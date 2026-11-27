import { describe, it, expect } from 'vitest';
import {
  computeQuantScore,
  quantCoverageWarning,
  formatQuantScoreMarkdown,
  REGIME_SIGNAL_MAP,
  MAX_MACRO_AGE_DAYS,
  DEFAULT_WEIGHTS,
} from '../src/indicators/quant-score.js';

/** 完全走平的收盘序列 → 技术类因子全部中性 */
function flatCloses(n = 60, price = 3000): number[] {
  return Array.from({ length: n }, () => price);
}

/** 走平的宏观序列 */
function flatSeries(n = 60, v = 100): number[] {
  return Array.from({ length: n }, () => v);
}

describe('computeQuantScore 权重重归一', () => {
  it('DEFAULT_WEIGHTS 名义权重合计为 1.0', () => {
    const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 6);
  });

  it('缺少全部宏观因子时不会把中性行情算成偏空', () => {
    const r = computeQuantScore({ closes: flatCloses() });
    // 未重归一时该场景会算出 ~33 分并被标成 bearish
    expect(r.score).toBeGreaterThanOrEqual(45);
    expect(r.score).toBeLessThanOrEqual(55);
    expect(r.direction).toBe('neutral');
    expect(r.coverage).toBeLessThan(1);
  });

  it('生效因子的实际权重合计为 1，贡献合计等于分数', () => {
    const r = computeQuantScore({ closes: flatCloses() });
    const factors = Object.values(r.factors).filter(f => f.weight > 0);
    const effSum = factors.reduce((a, f) => a + f.effectiveWeight, 0);
    const contribSum = factors.reduce((a, f) => a + f.contribution, 0);
    expect(effSum).toBeCloseTo(1, 2);
    expect(Math.round(contribSum)).toBe(r.score);
  });

  it('补齐宏观因子后覆盖度升至 1', () => {
    const r = computeQuantScore({
      closes: flatCloses(),
      dxy: flatSeries(),
      us10y: flatSeries(60, 4.2),
      tips: flatSeries(60, 1.8),
      regimeTag: 'range_bound',
    });
    expect(r.coverage).toBeCloseTo(1, 2);
    expect(r.missingFactors).toHaveLength(0);
  });

  it('相同行情下，宏观数据有无不应翻转方向', () => {
    const without = computeQuantScore({ closes: flatCloses() });
    const withMacro = computeQuantScore({
      closes: flatCloses(),
      dxy: flatSeries(),
      us10y: flatSeries(60, 4.2),
      tips: flatSeries(60, 1.8),
      regimeTag: 'range_bound',
    });
    expect(without.direction).toBe(withMacro.direction);
    expect(Math.abs(without.score - withMacro.score)).toBeLessThanOrEqual(5);
  });
});

describe('宏观数据时效', () => {
  it('超过 MAX_MACRO_AGE_DAYS 的序列被剔除并记入 staleFactors', () => {
    const r = computeQuantScore({
      closes: flatCloses(),
      tips: flatSeries(60, 1.8),
      macroAgeDays: { tips: MAX_MACRO_AGE_DAYS + 1 },
    });
    expect(r.staleFactors).toContain('tips');
    expect(r.factors.tips).toBeUndefined();
  });

  it('在时效内的序列正常参与打分', () => {
    const r = computeQuantScore({
      closes: flatCloses(),
      tips: flatSeries(60, 1.8),
      macroAgeDays: { tips: 1 },
    });
    expect(r.staleFactors).not.toContain('tips');
    expect(r.factors.tips).toBeDefined();
  });

  it('长度不足的序列记入 missingFactors', () => {
    const r = computeQuantScore({ closes: flatCloses(), dxy: flatSeries(5) });
    expect(r.missingFactors).toContain('dxy');
  });
});

describe('宏观阶段因子', () => {
  it('detectMacroRegime 产出的每个 tag 都能查到信号分', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../src/utils/macro-regime.ts', import.meta.url), 'utf8'),
    );
    const tags = [...src.matchAll(/tag:\s*'([a-z_]+)'/g)].map(m => m[1]);
    expect(tags.length).toBeGreaterThan(3);
    for (const tag of tags) {
      expect(REGIME_SIGNAL_MAP[tag], `regime tag ${tag} 未映射信号分`).toBeDefined();
    }
  });

  it('未知 tag 不注入假中性因子，而是剔除并重归一', () => {
    const r = computeQuantScore({ closes: flatCloses(), regimeTag: 'not_a_real_tag' });
    expect(r.factors.regime).toBeUndefined();
    expect(r.missingFactors).toContain('regime');
  });

  it('实际利率压制阶段给出偏空信号，降息预期阶段给出偏多信号', () => {
    expect(REGIME_SIGNAL_MAP.real_rate_headwind).toBeLessThan(50);
    expect(REGIME_SIGNAL_MAP.dovish_pivot_watch).toBeGreaterThan(50);
  });
});

describe('覆盖度提示', () => {
  it('覆盖度不足时给出可读警告', () => {
    const r = computeQuantScore({ closes: flatCloses() });
    const warn = quantCoverageWarning(r);
    expect(warn).toBeTruthy();
    expect(warn).toContain('重归一');
  });

  it('覆盖度充足时不提示', () => {
    const r = computeQuantScore({
      closes: flatCloses(),
      dxy: flatSeries(),
      us10y: flatSeries(60, 4.2),
      tips: flatSeries(60, 1.8),
      regimeTag: 'range_bound',
    });
    expect(quantCoverageWarning(r)).toBeNull();
  });

  it('Markdown 因子表同时列出名义权重与实际权重', () => {
    const r = computeQuantScore({ closes: flatCloses() });
    const md = formatQuantScoreMarkdown(r.factors, r.score);
    expect(md).toContain('名义权重');
    expect(md).toContain('实际权重');
    expect(md).toContain('重归一');
  });
});

describe('行情方向单调性与 F08 RSI 极端过热修正', () => {
  // F08: 健康温和趋势（有正常回调、RSI 在 55-68 区间）保持「涨 > 平 > 跌」单调关系；
  // 极端直线逼空（RSI=100）则会触发过热警示，不再盲目给极高看多打分。
  function buildHealthyUptrend(): number[] {
    const out: number[] = [];
    for (let i = 0; i < 60; i++) {
      if (i < 20) {
        // 先经历回调，使后续上涨位于合理中位估值区（非 100% 极端泡沫）
        out.push(3600 - i * 38);
      } else {
        // 后 40 日健康震荡走高（交替 +24 / -14，RSI 约 62，MA20 明显多头）
        const step = i - 20;
        const base = 2850 + step * 8;
        out.push(base + (step % 2 === 1 ? 10 : -10));
      }
    }
    return out;
  }

  function buildHealthyDowntrend(): number[] {
    const out: number[] = [];
    for (let i = 0; i < 60; i++) {
      if (i < 20) {
        out.push(2400 + i * 38);
      } else {
        const step = i - 20;
        const base = 3150 - step * 8;
        out.push(base + (step % 2 === 1 ? -10 : 10));
      }
    }
    return out;
  }

  const up = computeQuantScore({ closes: buildHealthyUptrend() });
  const flat = computeQuantScore({ closes: flatCloses() });
  const down = computeQuantScore({ closes: buildHealthyDowntrend() });

  it('健康上涨趋势分数高于横盘', () => {
    expect(up.score).toBeGreaterThan(flat.score);
  });

  it('横盘分数高于健康下跌趋势', () => {
    expect(flat.score).toBeGreaterThan(down.score);
  });

  it('横盘接近中性 50', () => {
    expect(Math.abs(flat.score - 50)).toBeLessThanOrEqual(3);
  });

  it('F08: 极端直线暴涨（RSI≈100）触发过热扣分，RSI 因子分低于健康温和上涨', () => {
    const parabolic = computeQuantScore({ closes: Array.from({ length: 60 }, (_, i) => 3000 + i * 20) });
    expect(parabolic.factors.rsi.rawValue).toBeGreaterThan(80);
    expect(parabolic.factors.rsi.normalizedScore).toBeLessThan(up.factors.rsi.normalizedScore);
  });
});

describe('F07 波动率因子仅作风险尺度（不给方向分）', () => {
  function atrSeries(dailyMovePct: number): number[] {
    const out = [3000];
    for (let i = 1; i < 40; i++) {
      // 交替涨跌，制造指定幅度的日均波动但不产生趋势
      out.push(out[i - 1] * (1 + (i % 2 === 0 ? dailyMovePct : -dailyMovePct) / 100));
    }
    return out;
  }

  it('DEFAULT_WEIGHTS.volatility 为 0，且高低波动均输出中性方向分 50 而保留真实 ATR rawValue', () => {
    expect(DEFAULT_WEIGHTS.volatility).toBe(0);
    const calm = computeQuantScore({ closes: atrSeries(0.1) });
    const turbulent = computeQuantScore({ closes: atrSeries(1.5) });
    expect(calm.factors.volatility.normalizedScore).toBe(50);
    expect(turbulent.factors.volatility.normalizedScore).toBe(50);
    expect(turbulent.factors.volatility.rawValue).toBeGreaterThan(calm.factors.volatility.rawValue);
  });
});
