// 反驳评分修正 — 纯函数，可单测

import type { RebuttalAnalysis, RebuttalStrength } from '../types/analysis.js';

/** 默认强度乘数（可被在线校准微调） */
export const STRENGTH_MULTIPLIER: Record<RebuttalStrength, number> = {
  weak: 0.10,
  moderate: 0.20,
  strong: 0.35,
};

export interface RebuttalAdjustmentDetail {
  adjustedScore: number;
  netEffect: RebuttalAnalysis['netEffect'];
  bearishImpliedScore: number;
  multiplier: number;
  rawAdjustment: number;
}

export interface MultiplierCalibrateInput {
  /** 系统偏差文案：optimistic / pessimistic / calibrated / 偏乐观… */
  systematicBias?: string | null;
  /** 校准误差绝对值（百分点），越大微调越强 */
  calibrationError?: number | null;
  /** 样本数，过少不调 */
  sampleSize?: number | null;
}

/**
 * 按历史校准偏差微调反驳强度乘数。
 * - 系统偏乐观 → 略增乘数（更用力压低乐观分）
 * - 系统偏悲观 → 略减乘数
 * 幅度有上限，样本不足时返回原值。
 */
export function calibrateStrengthMultiplier(
  base: number,
  input?: MultiplierCalibrateInput | null,
): number {
  if (!input || (input.sampleSize ?? 0) < 5) return base;

  const bias = String(input.systematicBias ?? '').toLowerCase();
  const err = Math.max(0, Math.min(40, input.calibrationError ?? 0));
  const scale = Math.min(0.25, err / 100); // 最多 ±25%

  let factor = 1;
  if (bias.includes('optimistic') || bias.includes('偏乐观') || bias.includes('乐观')) {
    factor = 1 + scale;
  } else if (bias.includes('pessimistic') || bias.includes('偏悲观') || bias.includes('悲观')) {
    factor = 1 - scale;
  } else {
    return base;
  }

  const next = base * factor;
  return Math.max(0.05, Math.min(0.50, Math.round(next * 1000) / 1000));
}

export type RebuttalCounterDirection = 'bear_rebuttal' | 'bull_rebuttal';

/**
 * F18: 计算反驳修正明细（单向严格钳制，防止空头分被「看空反驳」反向拉高）：
 * - bear_rebuttal（默认）：仅能压低乐观分，rawAdjustment = min(0, (100 - bearScore - originalScore) * mult)
 * - bull_rebuttal（对称多头反驳）：仅能修正过度悲观分，rawAdjustment = max(0, (counterScore - originalScore) * mult)
 */
export function computeRebuttalAdjustment(
  originalScore: number,
  bearScore: number,
  rebuttalStrength: RebuttalStrength,
  calibrate?: MultiplierCalibrateInput | null,
  counterDirection: RebuttalCounterDirection = 'bear_rebuttal',
): RebuttalAdjustmentDetail {
  const baseMult = STRENGTH_MULTIPLIER[rebuttalStrength];
  const multiplier = calibrateStrengthMultiplier(baseMult, calibrate);
  const bearishImpliedScore = 100 - bearScore;

  let rawAdjustment: number;
  if (counterDirection === 'bull_rebuttal') {
    rawAdjustment = Math.max(0, (bearScore - originalScore) * multiplier);
  } else {
    rawAdjustment = Math.min(0, (bearishImpliedScore - originalScore) * multiplier);
  }

  const adjustedScore = Math.max(0, Math.min(100, Math.round(originalScore + rawAdjustment)));

  const absAdjust = Math.abs(rawAdjustment);
  let netEffect: RebuttalAnalysis['netEffect'];
  if (absAdjust < 1) {
    netEffect = 'unchanged';
  } else if (rawAdjustment < 0) {
    netEffect = absAdjust < 5 ? 'downgraded' : 'significant_downgrade';
  } else {
    netEffect = 'upgraded';
  }

  return { adjustedScore, netEffect, bearishImpliedScore, multiplier, rawAdjustment };
}

/**
 * 将反驳力度映射到评分修正（默认 bear_rebuttal 单向压低乐观分，绝不拉高偏空分）。
 */
export function adjustScoreWithRebuttal(
  originalScore: number,
  bearScore: number,
  rebuttalStrength: RebuttalStrength,
  calibrate?: MultiplierCalibrateInput | null,
  counterDirection: RebuttalCounterDirection = 'bear_rebuttal',
): { adjustedScore: number; netEffect: RebuttalAnalysis['netEffect'] } {
  const { adjustedScore, netEffect } = computeRebuttalAdjustment(
    originalScore, bearScore, rebuttalStrength, calibrate, counterDirection,
  );
  return { adjustedScore, netEffect };
}
