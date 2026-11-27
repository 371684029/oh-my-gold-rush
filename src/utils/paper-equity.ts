// 纸面权益回放（Paper Equity）— ROADMAP-FINENG 包 B
//
// 旧 tearsheet 的「模拟权益曲线」把每个报告日的 5 日前瞻收益当独立区间复利，
// 报告近似日更时窗口大量重叠，等于给同一段行情记了多次账，净值被系统性放大。
// 本模块改为**日频、不重叠**回放：
//   - 决策发生在报告日收盘（与 forward-return 口径一致）；
//   - 目标仓作用于「决策日收盘 → 下一交易日收盘」的日收益；
//   - 未出报告的日子沿用上一个目标仓（与产品「维持昨日仓位」语义一致）；
//   - 三条曲线同起点：策略（推荐仓位） vs 满仓持有 vs 固定 50% 标配。
//
// 仓位来源：优先用已入库的 overall.positionTargetPct（真实产品输出，含门禁/双分/波动约束）；
// 旧报告无该字段时回落到 scoreToBasePct((LLM+量化)/2) 近似，并在结果中标记 proxy 天数。

import type { AnalysisReportRow } from '../db/reports.js';
import { scoreToBasePct } from './position-recommend.js';

export interface PaperEquityBar {
  date: string; // YYYY-MM-DD
  close: number; // 伦敦金收盘（>0 才有效）
}

export interface PaperEquityDecision {
  date: string;
  /** 相对计划仓 0–100 */
  targetPct: number;
  source: 'stored' | 'proxy';
}

export interface PaperEquityPoint {
  date: string;
  /** 作用于本日收益的仓位 %（上一报告日决策） */
  appliedPct: number;
  /** 本日金价涨跌幅 % */
  dailyReturnPct: number;
  strategyNav: number;
  holdNav: number;
  halfNav: number;
}

export interface PaperEquityOptions {
  /** 现金闲置部分年化收益（如货基 0.018 = 1.8%），默认 0 以保持纯金价基准兼容 */
  cashAnnualRate?: number;
  /** 单边调仓交易成本（基点 bps，如 15 = 0.15%），默认 0 */
  transactionCostBps?: number;
  /** 调仓缓冲带（百分点，如 15 表示目标仓变动 <15% 不调仓以降低换手），默认 0 */
  rebalanceBandPct?: number;
}

/** 支付宝/场外黄金基金真实回测推荐参数（1.8% 货基现金收益 + 15bp 单边摩擦 + 15% 调仓缓冲带） */
export const DEFAULT_REALISTIC_BACKTEST_OPTIONS: Required<PaperEquityOptions> = {
  cashAnnualRate: 0.018,
  transactionCostBps: 15,
  rebalanceBandPct: 15,
};

export interface PaperEquityStats {
  /** 区间累计收益 %（起点 100） */
  totalReturnPct: number | null;
  /** 按日频几何年化的收益 %（严格以交易日收益条数 / 252 计算） */
  annReturnPct: number | null;
  /** 日收益年化波动 %（样本标准差 n-1） */
  annVolPct: number | null;
  /** 最大回撤 %（正数） */
  maxDrawdownPct: number | null;
  /** 日均仓位 %（仅策略） */
  avgPositionPct: number | null;
  /** F17: 年化夏普比率（相对 cashAnnualRate） */
  sharpe?: number | null;
  /** F17: 年化索提诺比率（仅下行偏差） */
  sortino?: number | null;
  /** F17: 卡玛比率（年化收益 / 最大回撤） */
  calmar?: number | null;
  /** F17: 年化单边换手率 %（仅策略） */
  annualTurnoverPct?: number | null;
  /** F17: 区间累计交易摩擦成本 %（仅策略） */
  totalCostPct?: number | null;
}

export interface PaperEquityResult {
  points: PaperEquityPoint[];
  strategy: PaperEquityStats;
  hold: PaperEquityStats;
  half: PaperEquityStats;
  storedDecisions: number;
  proxyDecisions: number;
  /** 有报告但当日无有效收盘价、无法参与回放的报告数 */
  skippedNoPrice: number;
  warnings: string[];
}

function navStats(
  navs: number[],
  dailyReturns: number[],
  cashAnnualRate = 0,
): PaperEquityStats {
  if (navs.length === 0 || dailyReturns.length === 0) {
    return {
      totalReturnPct: null,
      annReturnPct: null,
      annVolPct: null,
      maxDrawdownPct: null,
      avgPositionPct: null,
      sharpe: null,
      sortino: null,
      calmar: null,
    };
  }
  const totalReturnPct = (navs[navs.length - 1] / navs[0] - 1) * 100;
  // F17: 严格使用真实交易日收益笔数 dailyReturns.length（而非 navs.length = N+1）
  const years = dailyReturns.length / 252;
  const annReturnPct = years > 0 ? ((navs[navs.length - 1] / navs[0]) ** (1 / years) - 1) * 100 : null;

  let vol: number | null = null;
  let sharpe: number | null = null;
  let sortino: number | null = null;
  if (dailyReturns.length >= 5) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const varSum = dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (dailyReturns.length - 1);
    const dailySd = Math.sqrt(Math.max(0, varSum));
    vol = dailySd * Math.sqrt(252) * 100;

    const rfDaily = cashAnnualRate / 252;
    const excessMean = mean - rfDaily;
    if (dailySd > 1e-9) {
      sharpe = Math.round(((excessMean / dailySd) * Math.sqrt(252)) * 100) / 100;
    }

    const downsideSq = dailyReturns.reduce((acc, r) => {
      const diff = r - rfDaily;
      return diff < 0 ? acc + diff * diff : acc;
    }, 0) / dailyReturns.length;
    const downsideDev = Math.sqrt(Math.max(0, downsideSq));
    if (downsideDev > 1e-9) {
      sortino = Math.round(((excessMean / downsideDev) * Math.sqrt(252)) * 100) / 100;
    }
  }

  let peak = navs[0];
  let maxDd = 0;
  for (const nav of navs) {
    if (nav > peak) peak = nav;
    const dd = (peak - nav) / peak;
    if (dd > maxDd) maxDd = dd;
  }
  const maxDrawdownPct = Math.round(maxDd * 1000) / 10;
  const calmar = (annReturnPct != null && maxDrawdownPct > 0.1)
    ? Math.round((annReturnPct / maxDrawdownPct) * 100) / 100
    : null;

  const round1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    totalReturnPct: Math.round(totalReturnPct * 100) / 100,
    annReturnPct: round1(annReturnPct),
    annVolPct: round1(vol),
    maxDrawdownPct,
    avgPositionPct: null,
    sharpe,
    sortino,
    calmar,
  };
}

/**
 * 日频纸面权益回放。bars 需升序；decisions 按日期排序后使用。
 * 决策日收盘价未知或无有效价格的日子不计入（skippedNoPrice 计报告侧）。
 */
export function buildPaperEquity(
  bars: PaperEquityBar[],
  decisions: PaperEquityDecision[],
  options?: PaperEquityOptions,
): PaperEquityResult {
  const cashAnnualRate = Math.max(0, options?.cashAnnualRate ?? 0);
  const transactionCostRate = Math.max(0, options?.transactionCostBps ?? 0) / 10_000;
  const rebalanceBandPct = Math.max(0, options?.rebalanceBandPct ?? 0);
  const rfDaily = cashAnnualRate / 252;
  const warnings: string[] = [];

  // 净化 + 升序 + 同日去重（保留后者）
  const sortedBars = [...bars]
    .filter(b => b && Number.isFinite(b.close) && b.close > 0 && /^\d{4}-\d{2}-\d{2}$/.test(b.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  const barByDate = new Map<string, PaperEquityBar>();
  for (const b of sortedBars) barByDate.set(b.date, b);

  const sortedDecisions = [...decisions]
    .filter(d => d && Number.isFinite(d.targetPct))
    .sort((a, b) => a.date.localeCompare(b.date));

  // 有效决策日必须有当日收盘（决策价）；否则该报告无法入回放
  const validDecisions: PaperEquityDecision[] = [];
  let skippedNoPrice = 0;
  for (const d of sortedDecisions) {
    if (barByDate.has(d.date)) {
      validDecisions.push({ ...d, targetPct: Math.max(0, Math.min(100, d.targetPct)) });
    } else {
      skippedNoPrice++;
    }
  }

  const storedDecisions = validDecisions.filter(d => d.source === 'stored').length;
  const proxyDecisions = validDecisions.length - storedDecisions;
  if (proxyDecisions > 0) {
    warnings.push(
      `${proxyDecisions} 个报告日无入库仓位（positionTargetPct），按 scoreToBasePct((LLM+量化)/2) 近似重建——` +
        '近似值不含门禁红档/双分冲突/波动缩放/日平滑约束，仅作方向性对照。',
    );
  }
  if (validDecisions.length === 0) {
    return {
      points: [],
      strategy: navStats([], []),
      hold: navStats([], []),
      half: navStats([], []),
      storedDecisions: 0,
      proxyDecisions: 0,
      skippedNoPrice,
      warnings: [...warnings, '无可回放的报告（或报告日均无有效收盘价）'],
    };
  }

  // 回放起点：第一个有效决策日的**下一根** bar 才产生第一笔收益
  const firstDecisionDate = validDecisions[0].date;
  const startIdx = sortedBars.findIndex(b => b.date > firstDecisionDate);
  if (startIdx < 0) {
    return {
      points: [],
      strategy: navStats([], []),
      hold: navStats([], []),
      half: navStats([], []),
      storedDecisions,
      proxyDecisions,
      skippedNoPrice,
      warnings: [...warnings, '首个决策日之后无价格序列，无法回放'],
    };
  }

  // 预索引：decisionDate -> 该日起生效的仓位（之后的日子沿用直到下一决策）
  let decisionPtr = 0;
  let currentPct: number | null = null;

  const points: PaperEquityPoint[] = [];
  // 净值序列以初始资本 100 开头：总收益/MaxDD 的分母必须是起点而非首个回放日
  const strategyNavs: number[] = [100];
  const holdNavs: number[] = [100];
  const halfNavs: number[] = [100];
  const strategyDailyReturns: number[] = [];
  const holdDailyReturns: number[] = [];
  const halfDailyReturns: number[] = [];
  const appliedPcts: number[] = [];

  let strategyNav = 100;
  let holdNav = 100;
  let halfNav = 100;
  let prevAppliedPct: number | null = null;
  let totalTurnoverWeight = 0;
  let totalCostWeight = 0;

  for (let i = startIdx; i < sortedBars.length; i++) {
    const prev = sortedBars[i - 1];
    const bar = sortedBars[i];

    // 推进到 prev.date 为止的最新决策（决策发生在 prev 收盘，作用于本日收益）
    while (decisionPtr < validDecisions.length && validDecisions[decisionPtr].date <= prev.date) {
      currentPct = validDecisions[decisionPtr].targetPct;
      decisionPtr++;
    }

    if (currentPct == null) continue;

    // F17: 调仓缓冲带（若变动幅度小于 rebalanceBandPct 且已有持仓，则维持原仓位以降低无效换手）
    let pct = currentPct;
    if (prevAppliedPct != null && rebalanceBandPct > 0 && Math.abs(currentPct - prevAppliedPct) < rebalanceBandPct) {
      pct = prevAppliedPct;
    }

    const r = bar.close / prev.close - 1;
    const rPct = r * 100;
    const w = pct / 100;

    // F17: 调仓摩擦成本（仅在仓位发生变动时按 |Δw| * transactionCostRate 扣除）
    const deltaW = prevAppliedPct == null ? 0 : Math.abs(w - prevAppliedPct / 100);
    const cost = deltaW * transactionCostRate;
    totalTurnoverWeight += deltaW;
    totalCostWeight += cost;
    prevAppliedPct = pct;

    // F17: 现金闲置部分 (1 - w) 计入无风险/货基日收益 rfDaily
    const stratRet = w * r + (1 - w) * rfDaily - cost;
    const halfRet = 0.5 * r + 0.5 * rfDaily;

    strategyNav *= 1 + stratRet;
    holdNav *= 1 + r;
    halfNav *= 1 + halfRet;

    strategyDailyReturns.push(stratRet);
    holdDailyReturns.push(r);
    halfDailyReturns.push(halfRet);
    appliedPcts.push(pct);

    strategyNavs.push(Math.round(strategyNav * 100) / 100);
    holdNavs.push(Math.round(holdNav * 100) / 100);
    halfNavs.push(Math.round(halfNav * 100) / 100);

    points.push({
      date: bar.date,
      appliedPct: pct,
      dailyReturnPct: Math.round(rPct * 100) / 100,
      strategyNav: strategyNavs[strategyNavs.length - 1],
      holdNav: holdNavs[holdNavs.length - 1],
      halfNav: halfNavs[halfNavs.length - 1],
    });
  }

  const strategy = navStats(strategyNavs, strategyDailyReturns, cashAnnualRate);
  strategy.avgPositionPct = appliedPcts.length
    ? Math.round((appliedPcts.reduce((a, b) => a + b, 0) / appliedPcts.length) * 10) / 10
    : null;
  const years = strategyDailyReturns.length > 0 ? strategyDailyReturns.length / 252 : 0;
  strategy.annualTurnoverPct = years > 0 ? Math.round((totalTurnoverWeight / years) * 1000) / 10 : 0;
  strategy.totalCostPct = Math.round(totalCostWeight * 10000) / 100;

  return {
    points,
    strategy,
    hold: navStats(holdNavs, holdDailyReturns, cashAnnualRate),
    half: navStats(halfNavs, halfDailyReturns, cashAnnualRate),
    storedDecisions,
    proxyDecisions,
    skippedNoPrice,
    warnings,
  };
}

/**
 * 从报告行提取逐日仓位决策。
 * stored = report_json.overall.positionTargetPct（真实产品输出）
 * proxy  = scoreToBasePct((LLM+量化)/2)（旧报告近似重建）
 */
export function extractPositionDecisions(reports: AnalysisReportRow[]): PaperEquityDecision[] {
  const decisions: PaperEquityDecision[] = [];
  for (const r of reports) {
    let stored: number | null = null;
    try {
      const parsed = JSON.parse(r.reportJson) as {
        overall?: { positionTargetPct?: unknown };
      };
      const v = parsed?.overall?.positionTargetPct;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100) {
        stored = v;
      }
    } catch {
      // report_json 损坏 → proxy
    }
    if (stored != null) {
      decisions.push({ date: r.date, targetPct: Math.round(stored), source: 'stored' });
      continue;
    }
    const mid = r.quantScore != null && Number.isFinite(r.quantScore)
      ? Math.round((r.overallScore + r.quantScore) / 2)
      : r.overallScore;
    decisions.push({ date: r.date, targetPct: scoreToBasePct(mid), source: 'proxy' });
  }
  return decisions;
}

function formatStatsRow(name: string, s: PaperEquityStats): string {
  const cell = (v: number | null | undefined, suffix = '%') =>
    v == null ? '—' : `${v > 0 ? '+' : ''}${v}${suffix}`;
  return (
    `| ${name} `
    + `| ${cell(s.totalReturnPct)} `
    + `| ${cell(s.annReturnPct)} `
    + `| ${s.annVolPct == null ? '—' : `${s.annVolPct}%`} `
    + `| ${s.maxDrawdownPct == null ? '—' : `${s.maxDrawdownPct}%`} `
    + `| ${s.avgPositionPct == null ? '—' : `${s.avgPositionPct}%`} |`
  );
}

export function formatPaperEquityConsole(result: PaperEquityResult, indent = '  '): string {
  const lines: string[] = [];
  lines.push(`${indent}📈 纸面权益回放（日频不重叠 · 决策日收盘 → 次日收益）`);
  if (result.points.length === 0) {
    lines.push(`${indent}  暂无可回放样本`);
    for (const w of result.warnings) lines.push(`${indent}  · ${w}`);
    return lines.join('\n');
  }
  const first = result.points[0];
  const last = result.points[result.points.length - 1];
  lines.push(
    `${indent}  区间 ${first.date} ~ ${last.date} · ${result.points.length} 个交易日 · `
      + `真实仓位 ${result.storedDecisions} 天 / 近似重建 ${result.proxyDecisions} 天`,
  );
  lines.push(`${indent}  策略(推荐仓位)  累计 ${fmtSigned(result.strategy.totalReturnPct)}% · MaxDD ${result.strategy.maxDrawdownPct}%`);
  lines.push(`${indent}  满仓持有        累计 ${fmtSigned(result.hold.totalReturnPct)}% · MaxDD ${result.hold.maxDrawdownPct}%`);
  lines.push(`${indent}  固定50%标配     累计 ${fmtSigned(result.half.totalReturnPct)}% · MaxDD ${result.half.maxDrawdownPct}%`);
  for (const w of result.warnings) lines.push(`${indent}  ⚠️ ${w}`);
  lines.push(`${indent}  （模拟口径：不计费率与滑点；非投资业绩承诺）`);
  return lines.join('\n');
}

function fmtSigned(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}

export function formatPaperEquityMarkdown(result: PaperEquityResult): string {
  const lines: string[] = ['## 📈 纸面权益回放（包 B）', ''];
  if (result.points.length === 0) {
    lines.push('暂无可回放样本。');
    for (const w of result.warnings) lines.push(`> ⚠️ ${w}`);
    lines.push('');
    return lines.join('\n');
  }
  const first = result.points[0];
  const last = result.points[result.points.length - 1];
  lines.push(
    `> 区间 **${first.date} ~ ${last.date}** · **${result.points.length}** 个交易日 · `
      + `真实仓位 ${result.storedDecisions} 天 / 近似重建 ${result.proxyDecisions} 天`
      + (result.skippedNoPrice > 0 ? ` · ${result.skippedNoPrice} 个报告日无有效收盘未计入` : ''),
    '',
  );
  lines.push('| 策略 | 区间累计 | 年化近似 | 年化波动 | 最大回撤 | 日均仓位 |');
  lines.push('|------|----------|----------|----------|----------|----------|');
  lines.push(formatStatsRow('**策略（推荐仓位）**', result.strategy));
  lines.push(formatStatsRow('满仓持有', result.hold));
  lines.push(formatStatsRow('固定50%标配', result.half));
  lines.push('');
  if (result.warnings.length) {
    for (const w of result.warnings) lines.push(`> ⚠️ ${w}`);
    lines.push('');
  }
  lines.push('| 日期 | 当日仓位 | 当日涨跌 | 策略净值 | 满仓净值 | 半仓净值 |');
  lines.push('|------|----------|----------|----------|----------|----------|');
  const tail = result.points.slice(-20);
  for (const p of tail) {
    lines.push(
      `| ${p.date} | ${p.appliedPct}% | ${p.dailyReturnPct > 0 ? '+' : ''}${p.dailyReturnPct}% `
        + `| ${p.strategyNav.toFixed(1)} | ${p.holdNav.toFixed(1)} | ${p.halfNav.toFixed(1)} |`,
    );
  }
  if (result.points.length > 20) {
    lines.push('');
    lines.push(`> 上表仅展示最近 20 个交易日，共 ${result.points.length} 个。`);
  }
  lines.push('');
  lines.push(
    '> 口径：决策发生在报告日收盘，目标仓作用于次一交易日收益（无前视）；未出报告日沿用上一目标仓。'
      + '模拟不计费率与滑点；近似重建日不含门禁/双分/波动约束。**非投资业绩承诺。**',
  );
  lines.push('');
  return lines.join('\n');
}
