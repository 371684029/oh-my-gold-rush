import { describe, it, expect } from 'vitest';
import {
  BASE_DIST_WEIGHTS_5D,
  BASE_DIST_WEIGHTS_MID,
  classifyCausalMacroRegime,
  buildRegimeAwareWeights,
} from '../src/utils/regime-kernel.js';

describe('Causal Macro Regime-Aware Dynamic Feature Kernel (v2.6 M5)', () => {
  it('classifies all 4 macro regimes strictly from causal inputs', () => {
    expect(
      classifyCausalMacroRegime({ gvz: 26, volPct: 1.85, yieldSpread2s10s: -0.35 }),
    ).toBe('stagflation_haven');

    expect(
      classifyCausalMacroRegime({ tips: 2.2, tipsDelta60dBp: 28, dxyDevMa60: 1.4, volPct: 0.9 }),
    ).toBe('tightening_headwind');

    expect(
      classifyCausalMacroRegime({ tips: 1.35, tipsDelta60dBp: -25, dxyDevMa60: -1.2, volPct: 1.0 }),
    ).toBe('easing_tailwind');

    expect(
      classifyCausalMacroRegime({ tips: 1.55, tipsDelta60dBp: 4, dxyDevMa60: 0.2, volPct: 1.05 }),
    ).toBe('balanced_neutral');
  });

  it('preserves total distance weight sum across all regimes and horizons', () => {
    const sumOf = (obj: Record<string, number>) =>
      Object.values(obj).reduce((a, b) => a + b, 0);

    const baseSum5 = sumOf(BASE_DIST_WEIGHTS_5D);
    const baseSum20 = sumOf(BASE_DIST_WEIGHTS_MID);

    const k5Tight = buildRegimeAwareWeights(5, { tips: 2.3, tipsDelta60dBp: 30, dxyDevMa60: 1.5 });
    const k20Ease = buildRegimeAwareWeights(20, { tips: 1.1, tipsDelta60dBp: -30, dxyDevMa60: -1.5 });
    const k5Crisis = buildRegimeAwareWeights(5, { gvz: 28, volPct: 2.1, yieldSpread2s10s: -0.4 });

    expect(k5Tight.regime).toBe('tightening_headwind');
    expect(sumOf(k5Tight.weights)).toBeCloseTo(baseSum5, 0);
    // In tightening_headwind, tips and dxy weights are elevated relative to base
    expect(k5Tight.weights.tips).toBeGreaterThan(BASE_DIST_WEIGHTS_5D.tips);
    expect(k5Tight.weights.dxy).toBeGreaterThan(BASE_DIST_WEIGHTS_5D.dxy);

    expect(k20Ease.regime).toBe('easing_tailwind');
    expect(sumOf(k20Ease.weights)).toBeCloseTo(baseSum20, 0);
    expect(k20Ease.weights.flow).toBeGreaterThan(BASE_DIST_WEIGHTS_MID.flow);

    expect(k5Crisis.regime).toBe('stagflation_haven');
    expect(k5Crisis.weights.volPct).toBeGreaterThan(BASE_DIST_WEIGHTS_5D.volPct);
    expect(k5Crisis.topWeightedFeatures).toHaveLength(3);
  });

  it('returns exact base weights when regime is balanced_neutral or blendAlpha is 0', () => {
    const neutral = buildRegimeAwareWeights(20, { tips: 1.5, tipsDelta60dBp: 0, dxyDevMa60: 0, volPct: 1.0 });
    expect(neutral.regime).toBe('balanced_neutral');
    expect(neutral.weights).toEqual(BASE_DIST_WEIGHTS_MID);

    const zeroAlpha = buildRegimeAwareWeights(5, { tips: 2.5, tipsDelta60dBp: 40 }, 0);
    expect(zeroAlpha.weights).toEqual(BASE_DIST_WEIGHTS_5D);
  });
});
