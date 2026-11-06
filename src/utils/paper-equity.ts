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

export interface PaperEquityStats {
  /** 区间累计收益 %（起点 100） */
  totalReturnPct: number | null;
  /** 按日频几何年化的收益 %（交易日近似） */
  annReturnPct: number | null;
  /** 日收益年化波动 %（策略为仓位加权收益的波动） */
  annVolPct: number | null;
  /** 最大回撤 %（正数） */
  maxDrawdownPct: number | null;
  /** 日均仓位 %（仅策略） */
  avgPositionPct: number | null;
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

function navStats(navs: number[], dailyReturns: number[]): PaperEquityStats {
  if (navs.length === 0) {
    return { totalReturnPct: null, annReturnPct: null, annVolPct: null, maxDrawdownPct: null, avgPositionPct: null };
  }
  const totalReturnPct = (navs[navs.length - 1] / navs[0] - 1) * 100;
  const n = navs.length;
  const years = n / 252;
  const annReturnPct = years > 0 ? ((navs[navs.length - 1] / navs[0]) ** (1 / years) - 1) * 100 : null;

  let vol: number | null = null;
  if (dailyReturns.length >= 5) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const varSum = dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyReturns.length;
    vol = Math.sqrt(varSum) * Math.sqrt(252) * 100;
  }

  let peak = navs[0];
  let maxDd = 0;
  for (const nav of navs) {
    if (nav > peak) peak = nav;
    const dd = (peak - nav) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  const round1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    totalReturnPct: Math.round(totalReturnPct * 100) / 100,
    annReturnPct: round1(annReturnPct),
    annVolPct: round1(vol),
    maxDrawdownPct: Math.round(maxDd * 1000) / 10,
    avgPositionPct: null,
  };
}

/**
 * 日频纸面权益回放。bars 需升序；decisions 按日期排序后使用。
 * 决策日收盘价未知或无有效价格的日子不计入（skippedNoPrice 计报告侧）。
 */
export function buildPaperEquity(
  bars: PaperEquityBar[],
  decisions: PaperEquityDecision[],
): PaperEquityResult {
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

  for (let i = startIdx; i < sortedBars.length; i++) {
    const prev = sortedBars[i - 1];
    const bar = sortedBars[i];

    // 推进到 prev.date 为止的最新决策（决策发生在 prev 收盘，作用于本日收益）
    while (decisionPtr < validDecisions.length && validDecisions[decisionPtr].date <= prev.date) {
      currentPct = validDecisions[decisionPtr].targetPct;
      decisionPtr++;
    }

    const pct = currentPct;
    if (pct == null) continue; // 理论上 startIdx 之前已确保存在决策，防御性跳过

    const r = bar.close / prev.close - 1;
    const rPct = r * 100;
    const w = pct / 100;

    strategyNav *= 1 + w * r;
    holdNav *= 1 + r;
    halfNav *= 1 + 0.5 * r;

    strategyDailyReturns.push(w * r);
    holdDailyReturns.push(r);
    halfDailyReturns.push(0.5 * r);
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

  const strategy = navStats(strategyNavs, strategyDailyReturns);
  strategy.avgPositionPct = appliedPcts.length
    ? Math.round((appliedPcts.reduce((a, b) => a + b, 0) / appliedPcts.length) * 10) / 10
    : null;

  return {
    points,
    strategy,
    hold: navStats(holdNavs, holdDailyReturns),
    half: navStats(halfNavs, halfDailyReturns),
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
