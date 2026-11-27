import { describe, it, expect } from 'vitest';
import {
  applyCalibrationScore,
  computeCalibrationOffset,
  scoreToExpectedWinProb,
  CALIBRATION_MIN_SAMPLE,
  CALIBRATION_MAX_ABS_OFFSET,
  directionFromScore,
} from '../src/utils/calibration-adjust';

describe('scoreToExpectedWinProb (F05 Platt mapping)', () => {
  it('将 0-100 强度分单调映射至合理 5 日胜率区间 [0.35, 0.65]', () => {
    expect(scoreToExpectedWinProb(50)).toBeCloseTo(0.5, 3);
    expect(scoreToExpectedWinProb(75)).toBeGreaterThan(0.55);
    expect(scoreToExpectedWinProb(75)).toBeLessThan(0.65);
    expect(scoreToExpectedWinProb(25)).toBeGreaterThan(0.35);
    expect(scoreToExpectedWinProb(25)).toBeLessThan(0.45);
    expect(scoreToExpectedWinProb(100)).toBeLessThanOrEqual(0.65);
    expect(scoreToExpectedWinProb(0)).toBeGreaterThanOrEqual(0.35);
  });
});

describe('computeCalibrationOffset', () => {
  it('样本不足 N < 30 时不偏移', () => {
    expect(computeCalibrationOffset(65, 0.4, 2)).toBe(0);
    expect(computeCalibrationOffset(65, 0.4, CALIBRATION_MIN_SAMPLE - 1)).toBe(0);
  });

  it('偏乐观区间在样本充足时经贝叶斯收缩下调分数且不超 -6', () => {
    const offset = computeCalibrationOffset(65, 0.35, 45);
    expect(offset).toBeLessThan(0);
    expect(offset).toBeGreaterThanOrEqual(-CALIBRATION_MAX_ABS_OFFSET);
    // 极端偏差触发对称上限 -6
    expect(computeCalibrationOffset(65, 0.1, 120)).toBe(-CALIBRATION_MAX_ABS_OFFSET);
  });

  it('偏保守区间在样本充足时对称上调分数且不超 +6', () => {
    const offset = computeCalibrationOffset(45, 0.65, 45);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThanOrEqual(CALIBRATION_MAX_ABS_OFFSET);
    // 极端保守触发对称上限 +6
    expect(computeCalibrationOffset(45, 0.9, 120)).toBe(CALIBRATION_MAX_ABS_OFFSET);
  });

  it('样本越大贝叶斯收缩系数越高', () => {
    const smallN = Math.abs(computeCalibrationOffset(65, 0.42, 30));
    const largeN = Math.abs(computeCalibrationOffset(65, 0.42, 200));
    expect(largeN).toBeGreaterThanOrEqual(smallN);
  });
});

describe('applyCalibrationScore', () => {
  it('样本不足时返回原分并注明 N < 30', () => {
    const r = applyCalibrationScore(47, { historicalAccuracy: null, sampleSize: 2, systematicBias: '样本不足' });
    expect(r.calibratedScore).toBe(47);
    expect(r.applied).toBe(false);
    expect(r.reason).toContain('校准样本不足');
    expect(r.expectedWinProb).toBeDefined();
  });

  it('regime 样本达到最小阈值时优先用于偏移', () => {
    const r = applyCalibrationScore(65, {
      historicalAccuracy: 0.7,
      sampleSize: 60,
      systematicBias: '校准良好',
      regimeHistoricalAccuracy: 0.35,
      regimeSampleSize: 35,
      regimeSystematicBias: '偏乐观',
    });
    expect(r.offset).toBeLessThan(0);
    expect(r.applied).toBe(true);
  });

  it('应用偏移并钳制 0-100', () => {
    const r = applyCalibrationScore(47, { historicalAccuracy: 0.25, sampleSize: 40, systematicBias: '偏乐观' });
    expect(r.offset).toBeLessThan(0);
    expect(r.calibratedScore).toBeGreaterThanOrEqual(0);
    expect(r.applied).toBe(true);
  });
});

describe('directionFromScore', () => {
  it('阈值与长期展望一致', () => {
    expect(directionFromScore(60)).toBe('bullish');
    expect(directionFromScore(40)).toBe('bearish');
    expect(directionFromScore(50)).toBe('neutral');
  });
});
