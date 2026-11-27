// 中期方向预期 — 1～3 个月（纯本地规则，零 LLM）
//
// 补上短期与长期之间的断档：
//   短期 = 当日 overall / quantScore，命中标签为 5 个交易日
//   长期 = buildLongTermOutlook，1/3/5 年配置向
//   中期 = 本模块，约 20 / 60 个交易日，决定「这一轮要不要调仓」
//
// 与短期分的区别在于喂进去的变量速度不同：中期只看慢半拍的结构量
// （MA50/MA200 趋势结构、实际利率 60 日趋势、美元趋势、估值分位、
// 持仓拥挤度、官方与 ETF 买盘），刻意不吃 RSI/MACD 这类日线动能，
// 否则中期只会变成短期分的复读。

import { latestMA } from '../indicators/ma.js';
import { percentile } from '../indicators/percentile.js';
import type { InstitutionalSignal } from '../types/institutional.js';
import type { Direction } from '../types/analysis.js';
import type { MacroRegime } from './macro-regime.js';
import { directionFromScore } from './decision-thresholds.js';

export type MidTermMonths = 1 | 3;

export interface MidTermFactor {
  name: string;
  /** 原始观测值，便于报告解释 */
  rawValue: number;
  /** 0–100，>50 偏多 */
  normalizedScore: number;
  weight: number;
  effectiveWeight: number;
  contribution: number;
  /** 人话说明，直接进报告 */
  note: string;
}

export interface MidTermHorizonView {
  months: MidTermMonths;
  label: string;
  direction: Direction;
  biasScore: number;
  confidence: 'low' | 'moderate' | 'high';
  stance: 'add' | 'hold' | 'reduce';
  action: string;
}

export interface MidTermOutlook {
  /** 中期综合分 0–100 */
  score: number;
  direction: Direction;
  /** 参与打分的名义权重合计（0–1），score 已按此重归一 */
  coverage: number;
  factors: Record<string, MidTermFactor>;
  horizons: MidTermHorizonView[];
  drivers: string[];
  /** 什么情况下该推翻这个中期判断 */
  watchTriggers: string[];
  summary: string;
}

export interface MidTermOutlookInput {
  /** 伦敦金收盘，按日期升序 */
  closes: number[];
  dxy?: number[];
  tips?: number[];
  /** CFTC 非商业净多头历史百分位 0–100，用于拥挤度反向判断 */
  cftcNetPercentile?: number | null;
  flowSignal?: InstitutionalSignal;
  macroRegime?: MacroRegime;
  /** 上一次中期展望，用于平滑防抖 */
  previous?: MidTermOutlook | null;
}

/** 权重合计 = 1.0 */
export const MID_TERM_WEIGHTS: Record<string, number> = {
  trend_structure: 0.22,
  real_rate_trend: 0.25,
  dollar_trend: 0.18,
  valuation: 0.12,
  positioning: 0.13,
  official_flow: 0.10,
};

/** 中期序列所需的最少样本（约 3 个月交易日） */
const MIN_MID_TERM_SAMPLE = 60;
/** 单次更新相对上一期的最大跳变，避免中期判断日度乱翻 */
const SMOOTH_MAX_STEP = 6;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function mk(key: string, name: string, rawValue: number, normalizedScore: number, note: string): MidTermFactor {
  return {
    name,
    rawValue: Math.round(rawValue * 100) / 100,
    normalizedScore: Math.round(clamp(normalizedScore, 5, 95)),
    weight: MID_TERM_WEIGHTS[key] ?? 0,
    effectiveWeight: 0,
    contribution: 0,
    note,
  };
}

/**
 * 因子 1：趋势结构（MA50 相对 MA200 + 价格相对 MA50）
 * 中期趋势跟随的主力项，比日线 MA20 慢，不易被单周波动甩下车。
 */
function trendStructureFactor(closes: number[]): MidTermFactor | null {
  const ma50 = latestMA(closes, 50);
  const ma200 = closes.length >= 200 ? latestMA(closes, 200) : null;
  if (ma50 == null || ma50 <= 0) return null;

  const cur = closes[closes.length - 1];
  const priceVsMa50 = ((cur - ma50) / ma50) * 100;

  // 无 MA200 时只用价格相对 MA50，权重逻辑不变但说明中标注
  let score = 50 + priceVsMa50 * 3;
  let note = `金价相对 MA50 ${priceVsMa50 >= 0 ? '+' : ''}${priceVsMa50.toFixed(1)}%`;

  if (ma200 != null && ma200 > 0) {
    const maSpread = ((ma50 - ma200) / ma200) * 100;
    score = 50 + priceVsMa50 * 2 + maSpread * 3;
    note += `；MA50 相对 MA200 ${maSpread >= 0 ? '+' : ''}${maSpread.toFixed(1)}%（${maSpread >= 0 ? '多头排列' : '空头排列'}）`;
  } else {
    note += '（样本不足 200 日，未计入长均线排列）';
  }

  return mk('trend_structure', '趋势结构(MA50/MA200)', priceVsMa50, score, note);
}

/**
 * 因子 2：实际利率趋势（TIPS 近 60 日变动）
 * 黄金最重要的单一驱动。中期看的是「方向和速度」，不是绝对水平：
 * 实际利率往下走 → 持有黄金机会成本下降 → 偏多。
 */
function realRateTrendFactor(tips: number[]): MidTermFactor | null {
  if (tips.length < 20) return null;
  const cur = tips[tips.length - 1];
  const lookback = Math.min(60, tips.length - 1);
  const past = tips[tips.length - 1 - lookback];
  const changeBp = (cur - past) * 100; // 百分点 → 基点

  // 每 25bp 变动约 10 分，±100bp 打满
  const score = 50 - (changeBp / 25) * 10;
  const dirWord = changeBp < -5 ? '下行（利多黄金）' : changeBp > 5 ? '上行（利空黄金）' : '基本走平';
  return mk(
    'real_rate_trend',
    '实际利率趋势(TIPS)',
    changeBp,
    score,
    `近 ${lookback} 日实际利率 ${changeBp >= 0 ? '+' : ''}${changeBp.toFixed(0)}bp，${dirWord}；当前 ${cur.toFixed(2)}%`,
  );
}

/**
 * 因子 3：美元趋势（DXY 相对 MA60）
 * 美元与黄金中期负相关，用 60 日均线过滤掉日内噪音。
 */
function dollarTrendFactor(dxy: number[]): MidTermFactor | null {
  if (dxy.length < 30) return null;
  const period = Math.min(60, dxy.length);
  const ma = latestMA(dxy, period);
  if (ma == null || ma <= 0) return null;
  const cur = dxy[dxy.length - 1];
  const dev = ((cur - ma) / ma) * 100;

  const score = 50 - dev * 8;
  const dirWord = dev > 0.5 ? '美元偏强（压制金价）' : dev < -0.5 ? '美元偏弱（利多金价）' : '美元中性';
  return mk(
    'dollar_trend',
    '美元趋势(DXY/MA60)',
    dev,
    score,
    `美元指数相对 ${period} 日均线 ${dev >= 0 ? '+' : ''}${dev.toFixed(2)}%，${dirWord}`,
  );
}

/**
 * 因子 4：估值分位（近一年百分位，反向）
 * 中期均值回归项，权重刻意压低——趋势市里估值高位可以维持很久。
 */
function valuationFactor(closes: number[]): MidTermFactor | null {
  if (closes.length < MIN_MID_TERM_SAMPLE) return null;
  const window = closes.slice(-252);
  const cur = closes[closes.length - 1];
  const pct = percentile(cur, window);
  // 只在极端分位才明显发力：50 分位给 50，两端给 ±20
  const score = 50 - ((pct - 50) / 50) * 20;
  const level = pct >= 80 ? '高位' : pct <= 20 ? '低位' : '中位';
  return mk(
    'valuation',
    '估值分位(近一年)',
    pct,
    score,
    `金价处于近一年 ${pct.toFixed(0)}% 分位（${level}）`,
  );
}

/**
 * 因子 5：持仓拥挤度（CFTC 非商业净多头百分位，反向）
 * 极端拥挤是中期反转的常见前提：人人满仓看多时，边际买盘已经耗尽。
 * 非极端区间给接近中性，不制造噪音。
 */
function positioningFactor(cftcPercentile: number): MidTermFactor {
  let score: number;
  let note: string;
  if (cftcPercentile >= 85) {
    score = 30;
    note = `CFTC 净多头处 ${cftcPercentile.toFixed(0)}% 分位，多头拥挤，中期回撤风险上升`;
  } else if (cftcPercentile <= 15) {
    score = 70;
    note = `CFTC 净多头处 ${cftcPercentile.toFixed(0)}% 分位，仓位已出清，中期反弹弹性较好`;
  } else {
    score = 50 - ((cftcPercentile - 50) / 50) * 12;
    note = `CFTC 净多头处 ${cftcPercentile.toFixed(0)}% 分位，未到拥挤或出清极端`;
  }
  return mk('positioning', '持仓拥挤度(CFTC)', cftcPercentile, score, note);
}

/**
 * 因子 6：官方与 ETF 买盘（F09：仅消费央行购金 + ETF 资金流，剔除 CFTC 避免与 positioningFactor 正反双计）
 * 央行购金与 ETF 持仓是中期最「慢」的资金项，方向性强于价格噪音。
 */
function officialFlowFactor(signal: InstitutionalSignal): MidTermFactor {
  const hasEtf = signal.etfFlow && typeof signal.etfFlow.score === 'number';
  const hasCb = signal.centralBank && typeof signal.centralBank.score === 'number';
  let raw: number;
  let note: string;
  if (hasEtf || hasCb) {
    const parts: Array<{ score: number; weight: number }> = [];
    if (hasEtf && !signal.etfFlow.summary?.includes('不足')) {
      parts.push({ score: signal.etfFlow.score, weight: 0.55 });
    }
    if (hasCb && !signal.centralBank.summary?.includes('暂无')) {
      parts.push({ score: signal.centralBank.score, weight: 0.45 });
    }
    if (parts.length > 0) {
      const wSum = parts.reduce((s, p) => s + p.weight, 0);
      raw = Math.round(parts.reduce((s, p) => s + p.score * (p.weight / wSum), 0));
      note = `官方/ETF 独立买盘 ${raw}/100（仅央行+ETF，已剔除 CFTC 避免重复计分）`;
    } else {
      raw = Math.round((hasEtf ? signal.etfFlow.score : 50) * 0.55 + (hasCb ? signal.centralBank.score : 50) * 0.45);
      note = `官方/ETF 买盘 ${raw}/100（央行+ETF）`;
    }
  } else {
    raw = signal.overallScore;
    note = `主力综合信号 ${raw}/100（仅传入汇总分，未拆分 CFTC）`;
  }
  return mk(
    'official_flow',
    '官方/ETF 买盘',
    raw,
    clamp(raw, 15, 85),
    note,
  );
}

function normalize(factors: Record<string, MidTermFactor>): { score: number; coverage: number } {
  let coverage = 0;
  for (const f of Object.values(factors)) coverage += f.weight;
  if (coverage <= 0) return { score: 50, coverage: 0 };

  let total = 0;
  for (const f of Object.values(factors)) {
    f.effectiveWeight = Math.round((f.weight / coverage) * 10000) / 10000;
    f.contribution = Math.round(f.normalizedScore * f.effectiveWeight * 100) / 100;
    total += f.normalizedScore * (f.weight / coverage);
  }
  return { score: Math.round(clamp(total, 0, 100)), coverage: Math.round(coverage * 10000) / 10000 };
}

function confidenceFor(coverage: number, spread: number, months: MidTermMonths): 'low' | 'moderate' | 'high' {
  if (coverage < 0.6) return 'low';
  if (spread < 6) return 'low';
  if (spread >= 15 && coverage >= 0.85 && months === 1) return 'high';
  return 'moderate';
}

function stanceFor(direction: Direction, biasScore: number): 'add' | 'hold' | 'reduce' {
  if (direction === 'bullish' && biasScore >= 60) return 'add';
  if (direction === 'bearish' && biasScore <= 40) return 'reduce';
  return 'hold';
}

function actionFor(stance: 'add' | 'hold' | 'reduce', months: MidTermMonths, conf: string): string {
  const horizon = months === 1 ? '未来 1 个月' : '未来 3 个月';
  if (conf === 'low') {
    return `${horizon}中期信号不清晰，按既定定投节奏执行，不主动调整波段仓`;
  }
  if (stance === 'add') {
    return months === 1
      ? `${horizon}结构偏多，回调至 MA50 附近可分批加波段仓，不追高`
      : `${horizon}结构偏多，可逐步把黄金仓位抬向计划上沿，分批而非一次性`;
  }
  if (stance === 'reduce') {
    return months === 1
      ? `${horizon}结构偏弱，反弹减波段仓，定投层保留`
      : `${horizon}结构偏弱，把仓位降回计划下沿，保留定投骨架不清仓`;
  }
  return `${horizon}方向不明，维持现有仓位与定投节奏，等结构变化再动`;
}

/**
 * 3 个月档相对 1 个月档更依赖慢变量：把趋势结构与估值的影响适度削弱，
 * 让实际利率与官方买盘占更大比重。
 */
function biasForMonths(factors: Record<string, MidTermFactor>, months: MidTermMonths): number {
  if (months === 1) {
    const { score } = normalize({ ...cloneFactors(factors) });
    return score;
  }
  const tilt: Record<string, number> = {
    trend_structure: 0.6,
    valuation: 0.7,
    positioning: 0.9,
    real_rate_trend: 1.3,
    dollar_trend: 1.0,
    official_flow: 1.4,
  };
  const adjusted = cloneFactors(factors);
  for (const [key, f] of Object.entries(adjusted)) {
    f.weight = (MID_TERM_WEIGHTS[key] ?? 0) * (tilt[key] ?? 1);
  }
  return normalize(adjusted).score;
}

function cloneFactors(factors: Record<string, MidTermFactor>): Record<string, MidTermFactor> {
  const out: Record<string, MidTermFactor> = {};
  for (const [k, v] of Object.entries(factors)) out[k] = { ...v };
  return out;
}

function smooth(raw: number, previous: MidTermOutlook | null | undefined): number {
  if (!previous || !Number.isFinite(previous.score)) return raw;
  const step = raw - previous.score;
  if (step > SMOOTH_MAX_STEP) return previous.score + SMOOTH_MAX_STEP;
  if (step < -SMOOTH_MAX_STEP) return previous.score - SMOOTH_MAX_STEP;
  return raw;
}

function buildWatchTriggers(factors: Record<string, MidTermFactor>, direction: Direction): string[] {
  const out: string[] = [];
  const rr = factors.real_rate_trend;
  if (rr) {
    out.push(
      direction === 'bullish'
        ? `实际利率由降转升（TIPS 较当前再上行 25bp 以上）→ 中期偏多逻辑失效`
        : `实际利率明确回落（TIPS 较当前下行 25bp 以上）→ 中期偏空逻辑失效`,
    );
  }
  const ts = factors.trend_structure;
  if (ts) {
    out.push(
      direction === 'bullish'
        ? '金价有效跌破 MA50 并且 MA50 转向下 → 趋势结构转空'
        : '金价站稳 MA50 且 MA50 转向上 → 趋势结构转多',
    );
  }
  const pos = factors.positioning;
  if (pos && pos.rawValue >= 85) {
    out.push('CFTC 净多头继续冲高而金价不涨 → 拥挤度背离，减仓优先于加仓');
  }
  out.push('中期判断以「结构」为准；单日大涨大跌不构成推翻理由');
  return out.slice(0, 4);
}

/** 构建 1～3 个月中期方向预期 */
export function buildMidTermOutlook(input: MidTermOutlookInput): MidTermOutlook {
  const factors: Record<string, MidTermFactor> = {};

  if (input.closes.length >= MIN_MID_TERM_SAMPLE) {
    const trend = trendStructureFactor(input.closes);
    if (trend) factors.trend_structure = trend;
    const val = valuationFactor(input.closes);
    if (val) factors.valuation = val;
  }
  if (input.tips?.length) {
    const rr = realRateTrendFactor(input.tips);
    if (rr) factors.real_rate_trend = rr;
  }
  if (input.dxy?.length) {
    const d = dollarTrendFactor(input.dxy);
    if (d) factors.dollar_trend = d;
  }
  if (input.cftcNetPercentile != null && Number.isFinite(input.cftcNetPercentile)) {
    factors.positioning = positioningFactor(input.cftcNetPercentile);
  }
  if (input.flowSignal) {
    factors.official_flow = officialFlowFactor(input.flowSignal);
  }

  const { score: rawScore, coverage } = normalize(factors);
  const score = smooth(rawScore, input.previous);
  const direction = directionFromScore(score);

  const horizons: MidTermHorizonView[] = ([1, 3] as MidTermMonths[]).map(months => {
    const bias = months === 1 ? score : smooth(biasForMonths(factors, months), input.previous);
    const dir = directionFromScore(bias);
    const conf = confidenceFor(coverage, Math.abs(bias - 50), months);
    const stance = stanceFor(dir, bias);
    return {
      months,
      label: months === 1 ? '1 个月' : '3 个月',
      direction: dir,
      biasScore: bias,
      confidence: conf,
      stance,
      action: actionFor(stance, months, conf),
    };
  });

  // 驱动按贡献偏离中性的绝对值排序，只留最能解释结论的几条
  const drivers = Object.values(factors)
    .sort((a, b) =>
      Math.abs(b.normalizedScore - 50) * b.effectiveWeight
      - Math.abs(a.normalizedScore - 50) * a.effectiveWeight)
    .slice(0, 3)
    .map(f => `${f.name}：${f.note}`);

  const summary = buildSummary(score, direction, coverage, horizons);

  return {
    score,
    direction,
    coverage,
    factors,
    horizons,
    drivers,
    watchTriggers: buildWatchTriggers(factors, direction),
    summary,
  };
}

function buildSummary(
  score: number,
  direction: Direction,
  coverage: number,
  horizons: MidTermHorizonView[],
): string {
  if (coverage < 0.6) {
    return `中期因子仅覆盖 ${(coverage * 100).toFixed(0)}% 权重，结论参考价值有限：维持定投纪律，不做中期调仓。`;
  }
  const oneM = horizons.find(h => h.months === 1);
  const threeM = horizons.find(h => h.months === 3);
  const diverge = oneM && threeM && oneM.direction !== threeM.direction;

  if (diverge) {
    return `1 个月与 3 个月方向不一致（${oneM!.biasScore} vs ${threeM!.biasScore}）：近端扰动与结构方向分歧，以定投为主、波段仓放轻。`;
  }
  if (direction === 'bullish') {
    return `中期（1～3 个月）结构偏多，综合 ${score}/100：趋势与慢变量同向，回调是加仓窗口而非离场信号。`;
  }
  if (direction === 'bearish') {
    return `中期（1～3 个月）结构偏弱，综合 ${score}/100：反弹宜减波段仓，定投骨架保留，不建议清仓式择时。`;
  }
  return `中期（1～3 个月）方向中性，综合 ${score}/100：结构未选方向，按计划仓位与定投节奏执行，少做择时。`;
}

// ============================================================
// 格式化
// ============================================================

function dirMark(d: Direction): string {
  return d === 'bullish' ? '📈 偏多' : d === 'bearish' ? '📉 偏空' : '➡️ 中性';
}

function stanceLabel(s: 'add' | 'hold' | 'reduce'): string {
  return s === 'add' ? '可加仓' : s === 'reduce' ? '宜减仓' : '维持';
}

export function formatMidTermOutlookConsole(outlook: MidTermOutlook, indent = '  '): string {
  const lines: string[] = [
    `${indent}🧭 中期方向预期（1～3 个月 · 纯本地慢变量）`,
    `${indent}${outlook.summary}`,
  ];
  for (const h of outlook.horizons) {
    lines.push(
      `${indent}  ${h.label}  ${dirMark(h.direction)} · 强度 ${h.biasScore}/100 · 置信 ${h.confidence} · ${stanceLabel(h.stance)}`,
    );
    lines.push(`${indent}      ${h.action}`);
  }
  if (outlook.drivers.length) {
    lines.push(`${indent}  主要驱动：`);
    for (const d of outlook.drivers) lines.push(`${indent}    · ${d}`);
  }
  if (outlook.coverage < 1) {
    lines.push(`${indent}  ⚠️ 因子覆盖 ${(outlook.coverage * 100).toFixed(0)}%，已按覆盖度重归一`);
  }
  return lines.join('\n');
}

export function formatMidTermOutlookMarkdown(outlook: MidTermOutlook): string {
  const lines: string[] = [
    '## 🧭 中期方向预期（1～3 个月）',
    '',
    outlook.summary,
    '',
    '| 期限 | 方向 | 强度 | 置信 | 操作倾向 | 建议 |',
    '|------|------|------|------|----------|------|',
  ];
  for (const h of outlook.horizons) {
    const dir = h.direction === 'bullish' ? '偏多' : h.direction === 'bearish' ? '偏空' : '中性';
    lines.push(`| ${h.label} | ${dir} | ${h.biasScore} | ${h.confidence} | ${stanceLabel(h.stance)} | ${h.action} |`);
  }
  lines.push('');

  if (Object.keys(outlook.factors).length) {
    lines.push('### 中期因子构成');
    lines.push('');
    lines.push('| 因子 | 信号分 | 实际权重 | 贡献 | 说明 |');
    lines.push('|------|--------|----------|------|------|');
    for (const f of Object.values(outlook.factors)) {
      lines.push(
        `| ${f.name} | ${f.normalizedScore} | ${(f.effectiveWeight * 100).toFixed(0)}% | +${f.contribution.toFixed(1)} | ${f.note} |`,
      );
    }
    lines.push(`| **合计** | **${outlook.score}** | 100% | | 名义覆盖 ${(outlook.coverage * 100).toFixed(0)}% |`);
    lines.push('');
  }

  if (outlook.watchTriggers.length) {
    lines.push('### 什么情况下推翻这个中期判断');
    lines.push('');
    for (const t of outlook.watchTriggers) lines.push(`- ${t}`);
    lines.push('');
  }

  lines.push('> 中期档只吃慢变量（MA50/MA200 结构、实际利率 60 日趋势、美元趋势、估值分位、持仓拥挤度、官方买盘），');
  lines.push('> 刻意不吃 RSI/MACD 等日线动能，避免与短期分重复。命中标签为 20 个交易日，与短期的 5 日标签分开统计。');
  lines.push('');
  return lines.join('\n');
}
