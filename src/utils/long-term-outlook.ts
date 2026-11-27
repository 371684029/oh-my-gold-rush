// 长期方向预期 — 1/3/5 年（纯本地规则）
//
// 设计目标（可靠性优先）：
// 1. 慢变量主导：实际利率/宏观阶段/结构情绪；少吃当日技术与 overall 短线分
// 2. 禁止年数线性放大成「五年跌六成」式吓人区间
// 3. 置信 low 时不展示硬累计%区间，只给配置档位
// 4. 相对上一日长期档平滑，降低日度乱翻

import type {
  Direction,
  FundamentalAnalysis,
  LongTermHorizonOutlook,
  LongTermHorizonYears,
  LongTermOutlook,
  RebuttalAnalysis,
  SentimentAnalysis,
  TechnicalAnalysis,
} from '../types/analysis.js';
import type { MacroRegime } from './macro-regime.js';
import type { GoldPriceRecord } from '../types/market.js';
import {
  computeHistoricalReturnBands,
  formatHistoricalBandLine,
  type HistoricalReturnBand,
} from './long-term-backtest.js';
import {
  computeHorizonEightDimensionScore,
  type EightDimensionProfile,
} from './eight-dimensions.js';

export interface LongTermOutlookInput {
  technical: TechnicalAnalysis;
  fundamental: FundamentalAnalysis;
  sentiment: SentimentAnalysis;
  rebuttal: RebuttalAnalysis;
  overallScore: number;
  overallDirection: Direction;
  macroRegime: MacroRegime;
  /** 可选：本地金价历史，用于无条件历史分位数区间 */
  priceHistory?: GoldPriceRecord[];
  /** 上一日（或最近）长期展望，用于平滑防抖 */
  previousOutlook?: LongTermOutlook | null;
  /** v2.4 可选：八维全景评分（存在时 1/3/5 年直接走慢变量八维权重，消息面/短线情绪严格 0%） */
  dimensions?: Partial<EightDimensionProfile>;
}

const HORIZONS: LongTermHorizonYears[] = [1, 3, 5];

/**
 * F14: 各期限慢变量权重：[技术, 基本面, 情绪, 宏观阶段]
 * 3/5 年严格剥离日度情绪面（权重 0%），由基本面与宏观周期慢变量主导。
 */
const WEIGHTS: Record<LongTermHorizonYears, [number, number, number, number]> = {
  1: [0.10, 0.50, 0.00, 0.40],
  3: [0.05, 0.55, 0.00, 0.40],
  5: [0.00, 0.60, 0.00, 0.40],
};

/** 当日综合分掺入比例：仅 1 年轻微参考，3/5 年脱钩 */
const OVERALL_BLEND: Record<LongTermHorizonYears, number> = {
  1: 0.08,
  3: 0.00,
  5: 0.00,
};

/** 平滑：新值权重（相对上一展望） */
const SMOOTH_NEW = 0.55;
const SMOOTH_MAX_STEP = 8; // 单日强度变化上限

function directionBias(score: number, direction: Direction): number {
  const adj = direction === 'bullish' ? 6 : direction === 'bearish' ? -6 : 0;
  return Math.max(0, Math.min(100, score + adj));
}

function macroBias(regime: MacroRegime): number {
  const map: Record<string, number> = {
    real_rate_headwind: 40,
    dollar_strength: 42,
    risk_off_bid: 68,
    dovish_pivot_watch: 66,
    range_bound: 52,
    inflation_hedge: 62,
    oversold_repair: 54,
    extended_rally: 48,
    rate_volatility: 48,
    unknown: 50,
  };
  return map[regime.tag] ?? 50;
}

/**
 * 反驳对长期的影响：大幅压低（尤其 3/5 年）
 * 旧版可把单日强反驳打成五年偏空极值
 */
function rebuttalPenalty(rebuttal: RebuttalAnalysis, years: LongTermHorizonYears): number {
  const bear = rebuttal.bearScore ?? 50;
  const strength =
    rebuttal.rebuttalStrength === 'strong' ? 1
      : rebuttal.rebuttalStrength === 'moderate' ? 0.6
        : 0.3;
  // 1年最多约 ±5 分，3年 ±3，5年 ±2
  const cap = years === 1 ? 5 : years === 3 ? 3 : 2;
  const raw = ((bear - 50) / 50) * cap * strength;
  return Math.max(-cap, Math.min(cap, raw));
}

/** 多年期限更宽的中性带，减少乱翻 */
function scoreToDirection(bias: number, years: LongTermHorizonYears): Direction {
  const hi = years === 1 ? 56 : 58;
  const lo = years === 1 ? 44 : 42;
  if (bias >= hi) return 'bullish';
  if (bias <= lo) return 'bearish';
  return 'neutral';
}

function trendLabel(direction: Direction, bias: number): string {
  if (direction === 'bullish') {
    return bias >= 68 ? '结构偏强' : '温和偏多';
  }
  if (direction === 'bearish') {
    return bias <= 32 ? '结构偏弱' : '温和偏空';
  }
  return '宽幅震荡 / 配置中性';
}

function allocationStance(direction: Direction, bias: number): 'overweight' | 'neutral' | 'underweight' {
  if (direction === 'bullish' && bias >= 60) return 'overweight';
  if (direction === 'bearish' && bias <= 40) return 'underweight';
  return 'neutral';
}

function allocationLabel(s: 'overweight' | 'neutral' | 'underweight'): string {
  if (s === 'overweight') return '配置偏积极（标配～小幅超配）';
  if (s === 'underweight') return '配置偏谨慎（标配～小幅低配）';
  return '配置中性（纪律定投为主）';
}

/**
 * 启发式区间：按「年化中枢」再×年数，并硬封顶
 * 避免旧公式 (50-bias)*0.35*years 导致五年 -60%
 */
function heuristicAnnualMid(direction: Direction, bias: number): number {
  const dev = (bias - 50) / 50; // -1..1
  if (direction === 'bullish') return 3 + Math.max(0, dev) * 5; // 约 3%～8% 年化中枢
  if (direction === 'bearish') return -2 + Math.min(0, dev) * 4; // 约 -2%～-6% 年化中枢
  return dev * 1.5;
}

function softCumulativeBand(
  direction: Direction,
  bias: number,
  years: LongTermHorizonYears,
): { lo: number; hi: number } {
  const ann = heuristicAnnualMid(direction, bias);
  // F14: 改为严格几何复利 ((1 + ann/100)^years - 1) * 100，消除单利 * 0.85 失真
  const mid = (Math.pow(1 + ann / 100, years) - 1) * 100;
  const half = (direction === 'neutral' ? 6 : 8) * Math.sqrt(years);
  let lo = mid - half;
  let hi = mid + half;
  // 硬封顶：任意期限名义累计不超过 ±35%
  lo = Math.max(-35, Math.min(35, lo));
  hi = Math.max(-35, Math.min(35, hi));
  if (lo > hi) [lo, hi] = [hi, lo];
  return {
    lo: Math.round(lo * 10) / 10,
    hi: Math.round(hi * 10) / 10,
  };
}

function formatSoftBand(lo: number, hi: number, years: number): string {
  const s = (n: number) => `${n >= 0 ? '+' : ''}${n}%`;
  return `参考名义累计约 ${s(lo)} ~ ${s(hi)}（${years}年量级，规则外推，非承诺）`;
}

function buildReturnBand(
  direction: Direction,
  bias: number,
  years: LongTermHorizonYears,
  conf: 'low' | 'moderate' | 'high',
  histAll: HistoricalReturnBand | null,
): string {
  // low：不展示吓人硬区间
  if (conf === 'low') {
    if (histAll && histAll.sampleSize >= 8) {
      return `置信偏低，不展示点位式预测；无条件历史参考：${formatHistoricalBandLine(histAll)}`;
    }
    return '置信偏低，不展示名义累计点位区间；以配置档位与定投纪律为准';
  }

  // moderate/high：优先无条件历史分位 + 软启发式
  const soft = softCumulativeBand(direction, bias, years);
  const softStr = formatSoftBand(soft.lo, soft.hi, years);
  if (histAll && histAll.sampleSize >= 8) {
    return `${softStr}；${formatHistoricalBandLine(histAll)}（GC=F 代理）`;
  }
  return softStr;
}

function confidence(
  bias: number,
  years: LongTermHorizonYears,
  rebuttal: RebuttalAnalysis,
  overallScore: number,
): 'low' | 'moderate' | 'high' {
  const spread = Math.abs(bias - 50);
  // 强反驳不再直接判 low（避免日度叙事绑架长期置信）
  // 但若 overall 极端且与长期 bias 同向极端，降一档
  let c: 'low' | 'moderate' | 'high' = 'low';
  if (spread >= 14) c = 'moderate';
  if (spread >= 20 && years >= 3) c = 'moderate'; // 多年极少给 high
  if (spread >= 22 && years === 1) c = 'high';

  // 短期综合分与长期脱节时，不抬高置信
  if (Math.abs(overallScore - bias) > 25) {
    if (c === 'high') c = 'moderate';
    else if (c === 'moderate') c = 'low';
  }
  // 强反驳仅压 1 年置信
  if (years === 1 && rebuttal.rebuttalStrength === 'strong' && (rebuttal.bearScore ?? 50) >= 65) {
    if (c === 'high') c = 'moderate';
  }
  // 多年默认最高 moderate
  if (years >= 3 && c === 'high') c = 'moderate';
  return c;
}

function dcaAdvice(
  stance: 'overweight' | 'neutral' | 'underweight',
  years: LongTermHorizonYears,
): string {
  if (years >= 5) {
    if (stance === 'overweight') return '维持定投纪律；深度回调分批加码，避免一次性重仓追高';
    if (stance === 'underweight') return '保留基础定投骨架，可略降单次金额；用时间换空间，不宜清仓式择时';
    return '标准定投为主；估值显著偏低时小幅加码';
  }
  if (years === 3) {
    if (stance === 'overweight') return '维持定投；急跌可小幅加码，高位不追';
    if (stance === 'underweight') return '定投可继续但放慢节奏；等待宏观/估值更友好再恢复加码';
    return '维持基础定投，按日历执行，少做择时';
  }
  // 1年
  if (stance === 'overweight') return '维持定投；急跌小加，不追涨';
  if (stance === 'underweight') return '放慢加码；基础定投可保留，波段仓宜轻';
  return '维持基础定投，少择时';
}

function pickDrivers(input: LongTermOutlookInput, years: LongTermHorizonYears): string[] {
  const drivers: string[] = [];
  drivers.push(`宏观阶段：${input.macroRegime.label}`);
  if (input.fundamental.dollarIndexEffect) {
    drivers.push(`美元/利率逻辑：${input.fundamental.dollarIndexEffect.slice(0, 40)}`);
  }
  if (input.fundamental.interestRateEffect) {
    drivers.push(`利率：${input.fundamental.interestRateEffect.slice(0, 36)}`);
  }
  if (years >= 3 && input.sentiment.centralBanks) {
    drivers.push(`央行储备：${input.sentiment.centralBanks.slice(0, 40)}`);
  } else if (input.sentiment.centralBanks) {
    drivers.push(`官方买盘：${input.sentiment.centralBanks.slice(0, 36)}`);
  }
  if (years === 1 && input.technical.summary) {
    drivers.push(`近端技术（次要）：${input.technical.summary.slice(0, 32)}`);
  }
  if (years >= 3) {
    drivers.push('慢变量主导：弱化当日综合分与强反驳对多年档的绑架');
  }
  return drivers.slice(0, 4);
}

function pickRisks(input: LongTermOutlookInput, years: LongTermHorizonYears): string[] {
  const risks: string[] = [];
  if (input.macroRegime.tag === 'real_rate_headwind') {
    risks.push('实际利率若长期偏高，压制黄金实际回报');
  }
  if (input.macroRegime.tag === 'dollar_strength') {
    risks.push('美元趋势性走强不利于美元计价金价');
  }
  // 多年少堆砌当日反驳金句
  if (years === 1) {
    for (const p of (input.rebuttal.bearPoints ?? []).slice(0, 1)) {
      risks.push(p.point.slice(0, 48));
    }
  } else {
    risks.push('政策与地缘路径高度不确定，历史分位不能外推未来');
  }
  risks.push('名义回报≠实际购买力；区间非承诺');
  return risks.slice(0, 3);
}

function smoothBias(
  raw: number,
  years: LongTermHorizonYears,
  previous?: LongTermOutlook | null,
): number {
  const prevH = previous?.horizons?.find(h => h.years === years);
  if (!prevH || !Number.isFinite(prevH.biasScore)) return raw;
  let mixed = SMOOTH_NEW * raw + (1 - SMOOTH_NEW) * prevH.biasScore;
  const step = mixed - prevH.biasScore;
  if (step > SMOOTH_MAX_STEP) mixed = prevH.biasScore + SMOOTH_MAX_STEP;
  if (step < -SMOOTH_MAX_STEP) mixed = prevH.biasScore - SMOOTH_MAX_STEP;
  return Math.max(5, Math.min(95, Math.round(mixed)));
}

function buildHorizon(
  input: LongTermOutlookInput,
  years: LongTermHorizonYears,
  histBand: HistoricalReturnBand | null,
): LongTermHorizonOutlook {
  let bias: number;
  if (input.dimensions && Object.keys(input.dimensions).length > 0) {
    const horizonKey = years === 1 ? '1y' : years === 3 ? '2y' : '5y';
    const dimRes = computeHorizonEightDimensionScore(input.dimensions, horizonKey);
    const macro = macroBias(input.macroRegime);
    bias = dimRes.score * 0.75 + macro * 0.25;
  } else {
    const [wT, wF, wS, wM] = WEIGHTS[years];
    const tech = directionBias(input.technical.score, input.technical.direction);
    const fund = directionBias(input.fundamental.score, input.fundamental.direction);
    const sent = directionBias(input.sentiment.score, input.sentiment.direction);
    const macro = macroBias(input.macroRegime);
    bias = tech * wT + fund * wF + sent * wS + macro * wM;
  }
  const overall = directionBias(input.overallScore, input.overallDirection);
  const ob = OVERALL_BLEND[years];
  if (ob > 0) {
    bias = bias * (1 - ob) + overall * ob;
  }
  bias -= rebuttalPenalty(input.rebuttal, years);
  bias = Math.max(5, Math.min(95, Math.round(bias)));
  bias = smoothBias(bias, years, input.previousOutlook);

  const direction = scoreToDirection(bias, years);
  const conf = confidence(bias, years, input.rebuttal, input.overallScore);
  const stance = allocationStance(direction, bias);
  const returnBandStr = buildReturnBand(direction, bias, years, conf, histBand);

  return {
    years,
    label: `${years}年`,
    direction,
    biasScore: bias,
    confidence: conf,
    trendLabel: trendLabel(direction, bias),
    returnBand: returnBandStr,
    allocationStance: stance,
    drivers: pickDrivers(input, years),
    risks: pickRisks(input, years),
    dcaAdvice: dcaAdvice(stance, years),
  };
}

/** 构建 1/3/5 年长期方向预期（配置向、慢变量主导） */
export function buildLongTermOutlook(input: LongTermOutlookInput): LongTermOutlook {
  const histBands = input.priceHistory?.length
    ? computeHistoricalReturnBands(input.priceHistory, HORIZONS)
    : [];
  const histMap = new Map(histBands.map(b => [b.years, b]));

  const horizons = HORIZONS.map(y => buildHorizon(input, y, histMap.get(y) ?? null));
  const bullishCount = horizons.filter(h => h.direction === 'bullish').length;
  const bearishCount = horizons.filter(h => h.direction === 'bearish').length;
  const lowConf = horizons.filter(h => h.confidence === 'low').length;

  let summary: string;
  if (lowConf >= 2) {
    summary = '长期档置信整体偏低：以配置纪律与历史分位参考为主，不宜把名义累计区间当点位预测；近端波动不自动等于多年趋势。';
  } else if (bullishCount >= 2) {
    summary = '结构偏多占优：慢变量（宏观阶段/利率逻辑/官方买盘）相对友好，宜纪律定投，避免用日线空头叙事否定长期配置。';
  } else if (bearishCount >= 2) {
    summary = '结构偏谨慎：美元/实际利率等逆风仍在，定投可保留骨架但放慢加码；非建议清仓，多年路径高度不确定。';
  } else {
    summary = '期限分化或近中性：近端扰动与远端结构可能不一致，标准定投 + 少择时通常更稳妥。';
  }

  return {
    summary,
    horizons,
    disclaimer:
      '长期档为本地慢变量规则 + 可选历史分位，非精确预测；置信 low 时不展示点位式累计区间。黄金波动大，请控制仓位。',
  };
}

export function formatLongTermOutlookConsole(outlook: LongTermOutlook, indent = '  '): string {
  const lines: string[] = [
    `${indent}🔭 长期方向预期（1 / 3 / 5 年 · 配置向）`,
    `${indent}${outlook.summary}`,
    '',
  ];
  for (const h of outlook.horizons) {
    const dir = h.direction === 'bullish' ? '📈 偏多' : h.direction === 'bearish' ? '📉 偏空' : '➡️ 中性';
    const stance = h.allocationStance ? allocationLabel(h.allocationStance) : '';
    lines.push(`${indent}  ${h.label}  ${dir} · ${h.trendLabel} · 强度 ${h.biasScore}/100 · 置信 ${h.confidence}`);
    if (stance) lines.push(`${indent}      配置：${stance}`);
    lines.push(`${indent}      ${h.returnBand}`);
    lines.push(`${indent}      定投：${h.dcaAdvice}`);
  }
  lines.push(`${indent}  ⚠️ ${outlook.disclaimer}`);
  return lines.join('\n');
}

export function formatLongTermOutlookMarkdown(outlook: LongTermOutlook): string {
  const lines: string[] = [
    '## 🔭 长期方向预期（1 / 3 / 5 年 · 配置向）',
    '',
    outlook.summary,
    '',
    '| 期限 | 方向 | 趋势 | 强度 | 置信 | 配置档位 | 参考区间 |',
    '|------|------|------|------|------|----------|----------|',
  ];
  for (const h of outlook.horizons) {
    const dir = h.direction === 'bullish' ? '偏多' : h.direction === 'bearish' ? '偏空' : '中性';
    const stance = h.allocationStance
      ? (h.allocationStance === 'overweight' ? '偏积极' : h.allocationStance === 'underweight' ? '偏谨慎' : '中性')
      : '—';
    const band = h.confidence === 'low' && !h.returnBand.includes('历史')
      ? '（低置信不展示点位）'
      : h.returnBand.replace(/\|/g, '/');
    lines.push(`| ${h.label} | ${dir} | ${h.trendLabel} | ${h.biasScore} | ${h.confidence} | ${stance} | ${band} |`);
  }
  lines.push('');
  for (const h of outlook.horizons) {
    lines.push(`### ${h.label}`);
    lines.push('');
    if (h.allocationStance) {
      lines.push(`- **配置档位**：${allocationLabel(h.allocationStance)}`);
    }
    lines.push(`- **驱动**：${h.drivers.join('；')}`);
    lines.push(`- **风险**：${h.risks.join('；')}`);
    lines.push(`- **参考区间**：${h.returnBand}`);
    lines.push(`- **定投建议**：${h.dcaAdvice}`);
    lines.push('');
  }
  lines.push(`> ${outlook.disclaimer}`);
  lines.push('');
  return lines.join('\n');
}
