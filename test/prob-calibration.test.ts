import { describe, it, expect } from 'vitest';
import {
  pinballLoss,
  computeFiveQuantileCrps,
  evaluateProbFanCalibration,
  buildNewsAuditStats,
  formatProbFanConsole,
  formatNewsAuditConsole,
  type QuantileForecastSample,
  type NewsAuditSample,
} from '../src/utils/prob-calibration.js';

describe('Probability Fan CRPS Calibration & News Audit (v2.6 M4)', () => {
  it('computes exact pinball loss and lower CRPS for sharper accurate fans', () => {
    expect(pinballLoss(2.0, 1.0, 0.9)).toBeCloseTo(0.9, 6);
    expect(pinballLoss(0.0, 1.0, 0.9)).toBeCloseTo(0.1, 6);

    const sharpHit = computeFiveQuantileCrps(1.0, { p10: -0.5, p25: 0.3, p50: 1.0, p75: 1.7, p90: 2.5 });
    const wideOrBiased = computeFiveQuantileCrps(1.0, { p10: -4.0, p25: -2.0, p50: -1.0, p75: 0.0, p90: 1.5 });
    expect(sharpHit).toBeLessThan(wideOrBiased);
    expect(sharpHit).toBeGreaterThan(0);
  });

  it('evaluates well-calibrated 80% coverage, positive CRPSS, and direction hit rate', () => {
    const samples: QuantileForecastSample[] = [];
    // 20 samples: 16 inside [p10, p90] (80% coverage), 2 below p10, 2 above p90
    for (let i = 0; i < 20; i++) {
      let actualPct = 1.2;
      if (i < 2) actualPct = -2.5;
      else if (i < 4) actualPct = 4.2;
      else if (i % 2 === 0) actualPct = 0.8;
      else actualPct = 1.6;

      samples.push({
        date: `2026-08-${String(i + 1).padStart(2, '0')}`,
        p10: -1.5,
        p25: 0.0,
        p50: 1.1,
        p75: 2.2,
        p90: 3.5,
        baselineP10: -4.0,
        baselineP25: -2.0,
        baselineP50: 0.0,
        baselineP75: 2.0,
        baselineP90: 4.0,
        actualPct,
      });
    }

    const rep = evaluateProbFanCalibration(samples, 5);
    expect(rep.sampleCount).toBe(20);
    expect(rep.coverage80Pct).toBe(80);
    expect(rep.lowerTailBreachPct).toBe(10);
    expect(rep.upperTailBreachPct).toBe(10);
    expect(rep.calibrationVerdict).toBe('well_calibrated');
    expect(rep.crpss).not.toBeNull();
    expect(rep.crpss!).toBeGreaterThan(0);
    expect(rep.directionHitRatePct).toBe(90);
    expect(formatProbFanConsole([rep])).toContain('P10–P90 覆盖率');
  });

  it('detects too_narrow and too_wide probability fans', () => {
    const narrowSamples: QuantileForecastSample[] = Array.from({ length: 12 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, '0')}`,
      p10: -0.2, p25: -0.1, p50: 0.0, p75: 0.1, p90: 0.2,
      actualPct: i < 8 ? 1.5 : 0.05,
    }));
    expect(evaluateProbFanCalibration(narrowSamples, 5).calibrationVerdict).toBe('too_narrow');

    const wideSamples: QuantileForecastSample[] = Array.from({ length: 12 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, '0')}`,
      p10: -10, p25: -5, p50: 0.5, p75: 5, p90: 10,
      actualPct: 0.4,
    }));
    expect(evaluateProbFanCalibration(wideSamples, 5).calibrationVerdict).toBe('too_wide');
  });

  it('stratifies news audit stats and measures positive filter lift when bait days underperform', () => {
    const samples: NewsAuditSample[] = [
      { date: '2026-09-01', veracityStatus: 'confirmed', score: 70, actual1dPct: 0.8, actual5dPct: 2.1 },
      { date: '2026-09-02', veracityStatus: 'confirmed', score: 68, actual1dPct: 0.5, actual5dPct: 1.4 },
      { date: '2026-09-03', veracityStatus: 'quiet', score: 65, actual1dPct: 0.3, actual5dPct: 1.0 },
      // Bait days: predicted bullish (score 65) but price reversed down
      { date: '2026-09-04', veracityStatus: 'bait_suspected', score: 65, actual1dPct: -1.1, actual5dPct: -2.4 },
      { date: '2026-09-05', veracityStatus: 'bait_suspected', score: 66, actual1dPct: -0.9, actual5dPct: -1.8 },
    ];

    const report = buildNewsAuditStats(samples);
    expect(report.totalSamples).toBe(5);
    expect(report.allSamplesHitRatePct).toBe(60);
    expect(report.filteredHitRatePct).toBe(100);
    expect(report.filterLiftPctPoints).toBe(40);
    expect(formatNewsAuditConsole(report)).toContain('防钓鱼事后审计');
  });
});
