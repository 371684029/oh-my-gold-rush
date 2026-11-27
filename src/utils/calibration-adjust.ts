// 校准数值修正（v2.4 F05 重构）
// 1) 将 0-100 强度分通过单调逻辑映射（Platt 风格）转化为合理预期胜率 p_expected ∈ [0.35, 0.65]，
//    彻底消除「把 75 分当成 75% 5日胜率」的尺度错配与永久看空偏移；
// 2) 最小生效样本量提高至 N >= 30（或有效独立样本 >= 15），并采用经验贝叶斯收缩；
// 3) 偏移区间对称截断为 [-6, +6]。

import type { CalibrationContext } from '../types/analysis.js';
import { scoreBucketRange } from './score-buckets.js';

export const CALIBRATION_MIN_SAMPLE = 30;
export const CALIBRATION_PRIOR_K = 25;
export const CALIBRATION_MAX_ABS_OFFSET = 6;

export interface CalibrationAdjustResult {
  rawScore: number;
  calibratedScore: number;
  offset: number;
  applied: boolean;
  reason: string;
  /** 校准后的预期 5 日上涨概率（0.35–0.65） */
  expectedWinProb?: number;
}

/**
 * Platt 风格单调映射：将 0-100 综合强度分映射为金融市场现实的 5 日预期上涨概率 [0.35, 0.65]。
 * score = 50 -> 0.50；score = 75 -> ~0.585；score = 25 -> ~0.415。
 */
export function scoreToExpectedWinProb(score: number): number {
  const clamped = Math.max(0, Math.min(100, score));
  const z = (clamped - 50) / 22;
  const logistic = 1 / (1 + Math.exp(-z)); // (0, 1)
  return 0.35 + 0.30 * logistic;
}

/**
 * F05: 根据实际胜率与 Platt 预期胜率的残差计算经验贝叶斯收缩偏移。
 * - 样本 < 30 不触发硬偏移（避免小样本拟合噪音）
 * - 偏移对称钳制在 [-6, +6]
 */
export function computeCalibrationOffset(
  rawScore: number,
  historicalAccuracy: number | null,
  sampleSize: number,
): number {
  if (historicalAccuracy == null || !Number.isFinite(historicalAccuracy) || sampleSize < CALIBRATION_MIN_SAMPLE) {
    return 0;
  }

  const bucket = scoreBucketRange(rawScore);
  if (!bucket) return 0;

  const midScore = (bucket.min + bucket.max) / 2;
  const expectedProb = scoreToExpectedWinProb(midScore);
  // 经验贝叶斯收缩：shrinkage = n / (n + K)
  const shrinkage = sampleSize / (sampleSize + CALIBRATION_PRIOR_K);
  const probDiff = historicalAccuracy - expectedProb; // 约 -0.25..+0.25
  // 每 10pp 胜率残差映射约 4 分强度偏移
  const rawOffset = probDiff * 40 * shrinkage;
  const rounded = Math.round(rawOffset);

  return Math.max(-CALIBRATION_MAX_ABS_OFFSET, Math.min(CALIBRATION_MAX_ABS_OFFSET, rounded));
}

export function applyCalibrationScore(
  rawScore: number,
  ctx: Pick<
    CalibrationContext,
    | 'historicalAccuracy'
    | 'sampleSize'
    | 'systematicBias'
    | 'regimeHistoricalAccuracy'
    | 'regimeSampleSize'
    | 'regimeSystematicBias'
  > | null,
  preferRegime = true,
): CalibrationAdjustResult {
  const clampedRaw = Math.max(0, Math.min(100, Math.round(rawScore)));
  const expectedWinProb = Math.round(scoreToExpectedWinProb(clampedRaw) * 1000) / 1000;

  let accuracy = ctx?.historicalAccuracy ?? null;
  let sampleSize = ctx?.sampleSize ?? 0;

  if (
    preferRegime
    && ctx?.regimeSampleSize != null
    && ctx.regimeSampleSize >= CALIBRATION_MIN_SAMPLE
    && ctx.regimeHistoricalAccuracy != null
  ) {
    accuracy = ctx.regimeHistoricalAccuracy;
    sampleSize = ctx.regimeSampleSize;
  }

  if (accuracy == null || sampleSize < CALIBRATION_MIN_SAMPLE) {
    return {
      rawScore: clampedRaw,
      calibratedScore: clampedRaw,
      offset: 0,
      applied: false,
      expectedWinProb,
      reason: sampleSize < CALIBRATION_MIN_SAMPLE
        ? `校准样本不足（${sampleSize} < ${CALIBRATION_MIN_SAMPLE}）`
        : '暂无校准数据',
    };
  }

  const offset = computeCalibrationOffset(clampedRaw, accuracy, sampleSize);
  const calibratedScore = Math.max(0, Math.min(100, clampedRaw + offset));

  return {
    rawScore: clampedRaw,
    calibratedScore,
    offset,
    applied: offset !== 0,
    expectedWinProb,
    reason: offset < 0
      ? `区间胜率低于预期，经贝叶斯收缩下调 ${Math.abs(offset)} 分`
      : offset > 0
        ? `区间胜率高于预期，经贝叶斯收缩上调 ${offset} 分`
        : '区间校准良好',
  };
}

export { directionFromScore } from './decision-thresholds.js';
