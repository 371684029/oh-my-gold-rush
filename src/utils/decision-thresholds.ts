// 方向判定与命中口径的唯一来源
//
// 这些阈值此前散落在 dual-score / calibration-adjust / quant-score / prediction-track /
// analysis / dashboard / server.cjs 等处，且展示口径（58/42）与命中口径（55/45）不一致：
// 56 分的报告页面写「中性」，命中统计却按「预测涨」记账，等于拿用户没看到的预测算准确率。
// 现统一为同一套阈值 —— 报告怎么说，就怎么算账。

import type { Direction } from '../types/analysis.js';

/** ≥ 该分数记偏多 */
export const BULLISH_MIN_SCORE = 58;
/** ≤ 该分数记偏空 */
export const BEARISH_MAX_SCORE = 42;

/**
 * 判定为「持平」的 5 日涨跌幅绝对值上限（%）。
 * 该区间内不计入命中率分母，避免噪音行情左右统计。
 */
export const FLAT_RETURN_PCT = 0.1;

/** 展示可信命中率所需的最小样本量；低于此值只报原始次数 */
export const MIN_HITRATE_SAMPLE = 10;

/** 分数 → 方向（展示与记账共用） */
export function directionFromScore(score: number): Direction {
  if (score >= BULLISH_MIN_SCORE) return 'bullish';
  if (score <= BEARISH_MAX_SCORE) return 'bearish';
  return 'neutral';
}

/**
 * 分数 → 可记账的方向预测。中性区间返回 null（不计入命中率分母）。
 * 与 directionFromScore 同阈值：页面上写「偏多」的日子才按看涨记账。
 */
export function predictDirectionFromScore(score: number): 'up' | 'down' | null {
  const dir = directionFromScore(score);
  if (dir === 'bullish') return 'up';
  if (dir === 'bearish') return 'down';
  return null;
}

export type ReturnClass = 'up' | 'down' | 'flat';

/** 涨跌幅（%）→ 实际方向，带持平死区 */
export function classifyReturn(returnPct: number): ReturnClass {
  if (returnPct > FLAT_RETURN_PCT) return 'up';
  if (returnPct < -FLAT_RETURN_PCT) return 'down';
  return 'flat';
}

/** 预测是否命中；持平或无预测返回 null（不计入分母） */
export function isHit(
  predicted: 'up' | 'down' | null,
  returnPct: number | null | undefined,
): boolean | null {
  if (predicted == null || returnPct == null || !Number.isFinite(returnPct)) return null;
  const actual = classifyReturn(returnPct);
  if (actual === 'flat') return null;
  return actual === predicted;
}

/** 命中口径的人话说明，供 CLI / MD / Web 复用，避免各写一套 */
export const HIT_RULE_TEXT =
  `分数 ≥${BULLISH_MIN_SCORE} 记「预测涨」、≤${BEARISH_MAX_SCORE} 记「预测跌」，`
  + `中间为中性不计入命中率；5 日涨跌幅在 ±${FLAT_RETURN_PCT}% 以内记持平，不计对错。`;

/**
 * Wilson 置信区间（95%）。
 *
 * 小样本下 7/10=70% 与 70/100=70% 的可信度天差地别，直接展示百分比会误导。
 * 返回 [下界, 上界]，均为 0–1。
 */
export function wilsonInterval(hits: number, total: number, z = 1.96): [number, number] {
  if (total <= 0) return [0, 1];
  const p = hits / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return [
    Math.max(0, (center - margin) / denom),
    Math.min(1, (center + margin) / denom),
  ];
}

/**
 * F16: 重叠滚动窗口（如逐日评估 T=5 / T=20 日前瞻收益）的 Bartlett / Newey-West 近似有效样本数。
 * 连续日线共享 T-1 天收益，直接用名义 N 算 Wilson CI 会低估标准误约 sqrt(T) 倍。
 */
export function effectiveSampleSizeOverlap(total: number, horizonDays = 5): number {
  if (total <= 0) return 0;
  const h = Math.max(1, horizonDays);
  if (h <= 1) return total;
  // Bartlett 核一阶近似：1 + 2 * sum_{k=1}^{h-1} (1 - k/h) * ((h - k) / h) ≈ 1 + (h - 1) * 2 / 3
  const overlapFactor = 1 + ((h - 1) * 2) / 3;
  return Math.max(1, Math.round((total / overlapFactor) * 10) / 10);
}

/**
 * F16: 重叠收益窗口的 HAC 修正 Wilson 95% 置信区间。
 * 用等效独立样本数 N_eff 替换名义 N，防止重叠样本制造「虚假统计显著」。
 */
export function wilsonIntervalHac(
  hits: number,
  total: number,
  horizonDays = 5,
  z = 1.96,
): [number, number] {
  if (total <= 0) return [0, 1];
  const nEff = effectiveSampleSizeOverlap(total, horizonDays);
  const p = hits / total;
  const effHits = p * nEff;
  return wilsonInterval(effHits, nEff, z);
}

/**
 * 命中率是否显著优于给定基准（默认 50% 抛硬币）。
 * 判据：Wilson 下界高于基准，即在 95% 置信度下不能用运气解释。
 */
export function beatsBaseline(hits: number, total: number, baseline = 0.5): boolean {
  if (total < MIN_HITRATE_SAMPLE) return false;
  return wilsonInterval(hits, total)[0] > baseline;
}

/** 命中率 + 样本量 + 置信区间的一行人话；样本不足时明说 */
export function formatHitRate(hits: number, total: number, baseline?: number): string {
  if (total <= 0) return '样本不足（0 次有效预测）';
  const pct = (hits / total) * 100;
  if (total < MIN_HITRATE_SAMPLE) {
    return `${hits}/${total}（${pct.toFixed(0)}%）· 样本不足 ${MIN_HITRATE_SAMPLE} 次，不具统计意义`;
  }
  const [lo, hi] = wilsonInterval(hits, total);
  const ci = `95%CI ${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)}%`;
  const base = baseline != null
    ? `｜基准 ${(baseline * 100).toFixed(0)}%${beatsBaseline(hits, total, baseline) ? '（显著跑赢）' : '（未显著跑赢）'}`
    : `${beatsBaseline(hits, total) ? '｜显著优于抛硬币' : '｜与抛硬币无显著差异'}`;
  return `${hits}/${total}（${pct.toFixed(0)}%，${ci}）${base}`;
}
