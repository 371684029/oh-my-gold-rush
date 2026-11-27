// 纯量化评分引擎 — deterministic, zero LLM, 100% reproducible
//
// 因子体系（12 类，当前启用 11 类）：
//   金价趋势 + RSI + MACD + 布林带 + 估值 + 主力动向
//   + 美元指数 + 名义收益率 + 实际收益率(TIPS) + 波动率 + 宏观阶段
//   + 事件热度（默认关闭，需 Tavily 数据）
// 所有因子均来自本地数据或确定性计算，与 LLM 打分完全独立。

import { latestRSI } from './rsi.js';
import { latestMACD } from './macd.js';
import { latestBollinger } from './bollinger.js';
import { latestMA } from './ma.js';
import { percentile } from './percentile.js';
import type { InstitutionalSignal } from '../types/institutional.js';
import { BULLISH_MIN_SCORE, BEARISH_MAX_SCORE } from '../utils/decision-thresholds.js';

function quantDirection(score: number): 'bullish' | 'bearish' | 'neutral' {
  if (score >= BULLISH_MIN_SCORE) return 'bullish';
  if (score <= BEARISH_MAX_SCORE) return 'bearish';
  return 'neutral';
}

// ============================================================
// Types
// ============================================================

export interface QuantFactorDetail {
  name: string;
  rawValue: number;
  normalizedScore: number;
  /** 名义权重（DEFAULT_WEIGHTS 中的设定值） */
  weight: number;
  /** 重归一后的实际权重 = weight / coverage；所有生效因子之和 = 1 */
  effectiveWeight: number;
  /** normalizedScore × effectiveWeight，所有生效因子之和 = score */
  contribution: number;
}

/** 宏观序列最后一个观测值的滞后天数，超过该值视为过期并剔除 */
export const MAX_MACRO_AGE_DAYS = 10;

/** 低于该覆盖度时量化分参考价值有限，应在报告中提示 */
export const MIN_HEALTHY_COVERAGE = 0.75;

export interface QuantScoreParams {
  closes: number[];
  /** 可选日内最高价序列（与 closes 等长），用于计算真实 14 日 Wilder ATR%（F07） */
  highs?: number[];
  /** 可选日内最低价序列（与 closes 等长），用于计算真实 14 日 Wilder ATR%（F07） */
  lows?: number[];
  dxy?: number[];
  us10y?: number[];
  tips?: number[];
  flowSignal?: InstitutionalSignal;
  regimeTag?: string;
  eventScore?: number;
  /**
   * 各宏观序列最新观测值距今天数。超过 MAX_MACRO_AGE_DAYS 的因子会被剔除并重归一，
   * 避免 FRED 中断时把两周前的实际利率当成今天的信号。
   */
  macroAgeDays?: { dxy?: number | null; us10y?: number | null; tips?: number | null };
}

export interface QuantScoreResult {
  score: number;
  direction: 'bullish' | 'bearish' | 'neutral';
  factors: Record<string, QuantFactorDetail>;
  /**
   * 参与计算的名义权重合计（0–1）。score 已按此重归一，
   * 因此缺数据只会放大不确定性，不会把分数拉向 0。
   */
  coverage: number;
  /** 因数据不足被剔除的因子 key */
  missingFactors: string[];
  /** 因数据过期被剔除的因子 key */
  staleFactors: string[];
}

// ============================================================
// 权重（总和 = 1.0）
// ============================================================

export const DEFAULT_WEIGHTS: Record<string, number> = {
  trend:      0.14, // F07: 原 volatility 5% 方向权重归零，重新分配至趋势 (+2%) 与 TIPS (+3%)
  rsi:        0.10,
  macd:       0.10,
  bollinger:  0.05,
  valuation:  0.08,
  flow:       0.15,
  dxy:        0.12,
  us10y:      0.08,
  tips:       0.13,
  volatility: 0.00, // F07: 波动率是无方向风险尺度，仅入风控/带宽层，退出方向打分
  regime:     0.05,
  event_heat: 0.00, // 默认关闭；事件传导卡不进此权重（docs/USER-VALUE.md §3.1）
};

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function w(key: string): number { return DEFAULT_WEIGHTS[key] ?? 0; }

/** 构造因子明细；effectiveWeight / contribution 在重归一阶段回填 */
function detail(key: string, name: string, rawValue: number, normalizedScore: number): QuantFactorDetail {
  return { name, rawValue, normalizedScore, weight: w(key), effectiveWeight: 0, contribution: 0 };
}

/**
 * 按实际参与的权重重归一，使 score 始终落在同一 0–100 标尺上。
 *
 * 不这样做时，缺少 dxy/us10y/tips/regime（合计 35%）会让中性行情算出 32.5 分，
 * 被直接读成「偏空」——数据缺失被误当成看空信号。
 */
function normalizeFactors(factors: Record<string, QuantFactorDetail>): { score: number; coverage: number } {
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

// ============================================================
// 因子 1-6：金价技术/估值/资金
// ============================================================

function trendFactor(closes: number[]): QuantFactorDetail {
  const ma = latestMA(closes, 20);
  const cur = closes[closes.length - 1];
  const dev = ma != null && ma > 0 ? ((cur - ma) / ma) * 100 : 0;
  return detail('trend', '金价趋势(MA20)', Math.round(dev*100)/100, clamp(50+dev*5,10,90));
}

/**
 * F08: 分段 RSI(14) 因子 — 消除与布林带 %B 及 Web 端超买标注的语义矛盾：
 * - [50, 68]：温和多头动能（50 → 64）
 * - (68, 75]：动能趋缓（64 → 52）
 * - > 75：超买过热回落至中性/微空（52 → 35）
 * - [32, 50)：温和偏弱（36 → 50）
 * - [25, 32)：超卖筑底回升（48 → 36）
 * - < 25：极端超卖逆向修复（48 → 65）
 */
function rsiFactor(closes: number[]): QuantFactorDetail {
  const raw = latestRSI(closes, 14) ?? 50;
  let score: number;
  if (raw >= 50 && raw <= 68) {
    score = 50 + ((raw - 50) / 18) * 14; // 50..64
  } else if (raw > 68 && raw <= 75) {
    score = 64 - ((raw - 68) / 7) * 12; // 64..52
  } else if (raw > 75) {
    score = 52 - ((raw - 75) / 25) * 17; // 52..35
  } else if (raw >= 32 && raw < 50) {
    score = 50 - ((50 - raw) / 18) * 14; // 50..36
  } else if (raw >= 25 && raw < 32) {
    score = 36 + ((32 - raw) / 7) * 12; // 36..48
  } else {
    score = 48 + ((25 - raw) / 25) * 17; // 48..65
  }
  return detail('rsi', 'RSI(14)', Math.round(raw * 100) / 100, Math.round(clamp(score, 10, 90)));
}

function macdFactor(closes: number[]): QuantFactorDetail {
  const m = latestMACD(closes);
  const raw = m?.histogram ?? 0;
  const cur = closes[closes.length - 1];
  const scaled = cur > 0 ? (raw / cur) * 1000 : 0;
  return detail('macd', 'MACD动能', Math.round(scaled*100)/100, clamp(50+scaled*5,10,90));
}

function bollingerFactor(closes: number[]): QuantFactorDetail {
  const bb = latestBollinger(closes, 20, 2);
  const pB = bb?.percentB ?? 0.5;
  return detail('bollinger', '布林带(%B)', Math.round(pB*1000)/1000, clamp((1-pB)*100,10,90));
}

function valuationFactor(closes: number[]): QuantFactorDetail {
  const cur = closes[closes.length - 1];
  const pct = closes.length >= 20 ? percentile(cur, closes) : 50;
  return detail('valuation', '估值(百分位)', Math.round(pct*10)/10, clamp(100-pct,10,90));
}

function flowFactor(flowSignal?: InstitutionalSignal): QuantFactorDetail {
  const raw = flowSignal?.overallScore ?? 50;
  return detail('flow', '主力(CFTC+ETF+央行)', raw, clamp(raw,10,90));
}

// ============================================================
// 因子 7-9：跨资产（美元、名义利率、实际利率）
// ============================================================

function dxyFactor(dxy: number[]): QuantFactorDetail {
  const ma = latestMA(dxy, 20);
  const cur = dxy[dxy.length - 1];
  const dev = ma != null && ma > 0 ? ((cur - ma) / ma) * 100 : 0;
  return detail('dxy', '美元指数(DXY)', Math.round(dev*100)/100, clamp(50-dev*10,10,90));
}

/**
 * F03: 10Y 名义收益率按基点绝对偏离（bps）计分，替代相对百分比除零风险。
 * 每偏离 MA20 +25bp 扣 12 分，平滑映射至 [10, 90]。
 */
function us10yFactor(us10y: number[]): QuantFactorDetail {
  const ma = latestMA(us10y, 20);
  const cur = us10y[us10y.length - 1]!;
  const base = ma ?? cur;
  const devBp = (cur - base) * 100;
  const score = clamp(50 - (devBp / 25) * 12, 10, 90);
  return detail('us10y', '10Y名义收益率(bp)', Math.round(devBp * 10) / 10, Math.round(score));
}

/**
 * F03: TIPS 实际收益率 — 黄金最重要的单一驱动因子（区间尺度，严禁除以 |base|）。
 * 统一使用相对 MA20 的基点偏离 devBp = (cur - ma20) * 100，在 0.00% 附近完全连续平滑。
 * 每偏离 +25bp 扣 15 分，映射至 [10, 90]。
 */
function tipsFactor(tips: number[]): QuantFactorDetail {
  const ma = latestMA(tips, 20);
  const cur = tips[tips.length - 1]!;
  const base = ma ?? cur;
  const devBp = (cur - base) * 100;
  const score = clamp(50 - (devBp / 25) * 15, 10, 90);
  return detail('tips', '实际收益率(TIPS)', Math.round(cur * 10000) / 10000, Math.round(score));
}

// ============================================================
// 因子 10：真实波幅 ATR%（仅作风险观测元数据，不计方向权重 — F07）
// 提供 High/Low 时按标准 14 日 Wilder True Range 计算；
// 缺高低价时注明 Close-to-Close Realized Vol，normalizedScore 恒为 50（无方向）。
// ============================================================
function volatilityFactor(closes: number[], highs?: number[], lows?: number[]): QuantFactorDetail {
  const period = 14;
  if (closes.length < period + 1) {
    return detail('volatility', '波动率(ATR·仅风控)', 0, 50);
  }
  const hasHlc =
    Array.isArray(highs)
    && Array.isArray(lows)
    && highs.length === closes.length
    && lows.length === closes.length;

  let atrPct: number;
  let label: string;
  if (hasHlc) {
    const trPcts: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      const prevC = closes[i - 1]!;
      const h = highs![i]!;
      const l = lows![i]!;
      if (prevC <= 0 || !Number.isFinite(h) || !Number.isFinite(l)) continue;
      const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
      trPcts.push((tr / prevC) * 100);
    }
    if (trPcts.length >= period) {
      // Wilder 平滑 ATR%
      let atr = trPcts.slice(0, period).reduce((s, v) => s + v, 0) / period;
      for (let i = period; i < trPcts.length; i++) {
        atr = (atr * (period - 1) + trPcts[i]!) / period;
      }
      atrPct = atr;
      label = '波动率(Wilder ATR%·仅风控)';
    } else {
      atrPct = 0;
      label = '波动率(ATR·仅风控)';
    }
  } else {
    let sumMove = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const prevC = closes[i - 1]!;
      sumMove += prevC > 0 ? (Math.abs(closes[i]! - prevC) / prevC) * 100 : 0;
    }
    atrPct = sumMove / period;
    label = '波动率(Close-to-Close·仅风控)';
  }
  // F07: 波动率无方向性，normalizedScore 恒定 50 且权重为 0
  return detail('volatility', label, Math.round(atrPct * 100) / 100, 50);
}

// ============================================================
// 因子 11：宏观阶段
// ============================================================

/**
 * 宏观阶段 → 信号分。
 *
 * 键必须与 detectMacroRegime 实际产出的 tag 保持一致，否则该因子恒为中性 50，
 * 权重白白摊薄其它因子。改 macro-regime.ts 的 tag 时同步改这里。
 */
export const REGIME_SIGNAL_MAP: Record<string, number> = {
  // macro-regime.ts 当前产出的标签
  real_rate_headwind: 28,
  dovish_pivot_watch: 72,
  dollar_strength: 35,
  oversold_repair: 60,
  extended_rally: 42,
  rate_volatility: 45,
  range_bound: 50,
  // 历史/外部标签，保留兼容
  recession_risk: 85, dovish_pivot: 80, stagflation: 78,
  soft_landing: 55, goldilocks: 45, hawkish: 30, tightening: 25,
  strong_dollar: 35, risk_on: 40, disinflation_boom: 40,
};

function regimeFactor(regimeTag: string): QuantFactorDetail | null {
  const score = REGIME_SIGNAL_MAP[regimeTag];
  if (score == null) return null;
  return detail('regime', '宏观阶段', score, score);
}

// ============================================================
// 因子 12：事件热度（Tavily 关键词计数，零 LLM）
// 关键词出现频率 → 判断市场关注度与方向。
// 默认关闭（权重 0），启用时需要 Tavily 搜索并传 eventScore。
// ============================================================
function eventHeatFactor(eventScore?: number): QuantFactorDetail {
  const raw = eventScore ?? 50;
  return detail('event_heat', '事件热度', raw, clamp(raw,10,90));
}

// ============================================================
// 主函数
// ============================================================

export function computeQuantScore(params: QuantScoreParams): QuantScoreResult {
  const { closes, highs, lows, dxy, us10y, tips, flowSignal, regimeTag, eventScore, macroAgeDays } = params;

  if (closes.length < 20) {
    return minimalResult(flowSignal?.overallScore ?? 50, regimeTag);
  }

  const factors: QuantScoreResult['factors'] = {};
  const missingFactors: string[] = [];
  const staleFactors: string[] = [];

  factors.trend      = trendFactor(closes);
  factors.rsi        = rsiFactor(closes);
  factors.macd       = macdFactor(closes);
  factors.bollinger  = bollingerFactor(closes);
  factors.valuation  = valuationFactor(closes);
  factors.flow       = flowFactor(flowSignal);
  factors.volatility = volatilityFactor(closes, highs, lows);

  const isStale = (age: number | null | undefined): boolean => age != null && age > MAX_MACRO_AGE_DAYS;

  const addMacro = (
    key: 'dxy' | 'us10y' | 'tips',
    series: number[] | undefined,
    build: (s: number[]) => QuantFactorDetail,
  ): void => {
    if (!series || series.length < 20) { missingFactors.push(key); return; }
    if (isStale(macroAgeDays?.[key])) { staleFactors.push(key); return; }
    factors[key] = build(series);
  };

  addMacro('dxy', dxy, dxyFactor);
  addMacro('us10y', us10y, us10yFactor);
  addMacro('tips', tips, tipsFactor);

  if (w('regime') > 0) {
    const r = regimeTag ? regimeFactor(regimeTag) : null;
    if (r) factors.regime = r;
    else missingFactors.push('regime');
  }
  if (eventScore != null && w('event_heat') > 0) factors.event_heat = eventHeatFactor(eventScore);

  const { score, coverage } = normalizeFactors(factors);

  return {
    score,
    direction: quantDirection(score),
    factors,
    coverage,
    missingFactors,
    staleFactors,
  };
}

function minimalResult(defaultFlow: number, regimeTag?: string): QuantScoreResult {
  const f: QuantScoreResult['factors'] = {};
  f.trend = detail('trend', '趋势', 0, 50);
  f.rsi   = detail('rsi', 'RSI', 50, 50);
  f.macd  = detail('macd', 'MACD', 0, 50);
  f.flow  = detail('flow', '主力', defaultFlow, clamp(defaultFlow, 10, 90));
  if (regimeTag && w('regime') > 0) {
    const r = regimeFactor(regimeTag);
    if (r) f.regime = r;
  }
  const { score, coverage } = normalizeFactors(f);
  return {
    score,
    direction: 'neutral',
    factors: f,
    coverage,
    missingFactors: ['bollinger', 'valuation', 'volatility', 'dxy', 'us10y', 'tips'],
    staleFactors: [],
  };
}

/** 覆盖度不足时给报告用的一句话提示；覆盖度健康时返回 null */
export function quantCoverageWarning(result: QuantScoreResult): string | null {
  if (result.coverage >= MIN_HEALTHY_COVERAGE) return null;
  const parts: string[] = [];
  if (result.missingFactors.length) parts.push(`缺失 ${result.missingFactors.join('/')}`);
  if (result.staleFactors.length) parts.push(`过期 ${result.staleFactors.join('/')}（>${MAX_MACRO_AGE_DAYS}天）`);
  const why = parts.length ? `（${parts.join('；')}）` : '';
  return `量化分仅由 ${(result.coverage * 100).toFixed(0)}% 权重的因子构成${why}，已按覆盖度重归一，但参考价值下降。`;
}

// ============================================================
// 格式化
// ============================================================

export function formatQuantScoreConsole(result: QuantScoreResult, indent = '  '): string {
  const lines: string[] = [];
  const bar = '─'.repeat(52);
  lines.push(`${indent}🔢 量化评分构成（纯本地计算，零 LLM）`);
  lines.push(`${indent}${bar}`);
  for (const f of Object.values(result.factors) as QuantFactorDetail[]) {
    const pct = Math.round(f.effectiveWeight * 100);
    if (f.weight <= 0) continue;
    lines.push(`${indent}  ${f.name.padEnd(16,' ')} 信号=${String(f.normalizedScore).padStart(3)} × ${String(pct).padStart(2)}%  →  +${f.contribution.toFixed(1)}`);
  }
  lines.push(`${indent}${bar}`);
  const dm: Record<string,string> = { bullish:'📈 偏多', bearish:'📉 偏空', neutral:'➡️ 中性' };
  lines.push(`${indent}  量化综合分`.padEnd(indent.length+14) + `= ${result.score}  ${dm[result.direction]}`);
  const warn = quantCoverageWarning(result);
  if (warn) lines.push(`${indent}  ⚠️ ${warn}`);
  return lines.join('\n');
}

export function formatQuantScoreOneLine(result: QuantScoreResult): string {
  const keys = ['trend','rsi','macd','flow','dxy','tips','regime']
    .filter(k => result.factors[k])
    .map(k => `${k}=${result.factors[k].normalizedScore}`);
  return `[量化] ${keys.join('/')} → ${result.score}`;
}

/** Markdown 因子表（权重 0 的 event_heat 等跳过） */
export function formatQuantScoreMarkdown(
  factors: QuantScoreResult['factors'] | undefined,
  score?: number,
): string {
  if (!factors || Object.keys(factors).length === 0) return '';
  const lines = [
    '### 量化因子构成（纯本地，event_heat 默认权重 0）',
    '',
    '| 因子 | 信号分 | 名义权重 | 实际权重 | 贡献 |',
    '|------|--------|----------|----------|------|',
  ];
  let sumW = 0;
  let sumEff = 0;
  for (const f of Object.values(factors) as QuantFactorDetail[]) {
    if (f.weight <= 0) continue;
    sumW += f.weight;
    sumEff += f.effectiveWeight;
    lines.push(
      `| ${f.name} | ${f.normalizedScore} | ${(f.weight * 100).toFixed(0)}% | ${(f.effectiveWeight * 100).toFixed(0)}% | +${f.contribution.toFixed(1)} |`,
    );
  }
  if (score != null) {
    lines.push(`| **合计** | | ${(sumW * 100).toFixed(0)}% | ${(sumEff * 100).toFixed(0)}% | **${score}** |`);
  }
  lines.push('');
  if (sumW < MIN_HEALTHY_COVERAGE) {
    lines.push(`> ⚠️ 本次仅 ${(sumW * 100).toFixed(0)}% 名义权重的因子有数据。分数已按覆盖度重归一（实际权重合计 100%），`);
    lines.push('> 因此缺数据不会把分数拉低成假「偏空」，但结论的可靠性相应下降。');
    lines.push('');
  }
  lines.push('> 名义权重取自 `DEFAULT_WEIGHTS`；实际权重 = 名义权重 ÷ 覆盖度，保证缺因子时分数标尺不变。');
  lines.push('');
  return lines.join('\n');
}
