import { describe, it, expect } from 'vitest';
import { computeScenarioBrier } from '../src/utils/scenario-brier';
import type { AnalysisReportRow } from '../src/db/reports';
import type { GoldPricesRepo } from '../src/db/gold-prices';

function mkPrices(prices: Record<string, number>): GoldPricesRepo {
  return {
    getByDate: (date: string) => (prices[date] != null ? { londonClose: prices[date] } : undefined),
    getAfter: (date: string, limit: number) => {
      const dates = Object.keys(prices).filter(d => d > date).sort().slice(0, limit);
      return dates.map(d => ({ date: d, londonClose: prices[d] }));
    },
  } as unknown as GoldPricesRepo;
}

function mkRow(date: string, pUpPct: number | null): AnalysisReportRow {
  const scenarios = pUpPct == null
    ? {}
    : { upside: { probability: pUpPct }, base: { probability: 100 - pUpPct }, downside: { probability: 0 } };
  return {
    id: 1,
    date,
    horizon: 'all',
    reportJson: JSON.stringify({ overall: { scenarios } }),
    overallScore: 50,
    quantScore: null,
    midTermScore: null,
    direction: 'neutral',
    createdAt: '',
  };
}

// 6 个交易日：每段 5 日窗口都是 +10%（涨）
const upPrices = mkPrices({
  '2026-06-01': 100,
  '2026-06-02': 101,
  '2026-06-03': 102,
  '2026-06-04': 103,
  '2026-06-05': 104,
  '2026-06-08': 110,
});

describe('computeScenarioBrier', () => {
  it('完美预报（上行 100% 且全涨）→ Brier = 0（气候学基准退化为 0，技巧分记 null）', () => {
    const rows = [mkRow('2026-06-01', 100), mkRow('2026-06-02', 100)];
    const r = computeScenarioBrier(rows, upPrices, 5);
    expect(r.evaluatedCount).toBe(2);
    expect(r.brierScore).toBeCloseTo(0, 6);
    expect(r.brierClimatology).toBeCloseTo(0, 6);
    expect(r.skillVsClimatology).toBeNull();
  });

  it('全错预报（上行 100% 但实际跌）→ Brier = 1', () => {
    const downPrices = mkPrices({
      '2026-06-01': 100,
      '2026-06-02': 99,
      '2026-06-03': 98,
      '2026-06-04': 97,
      '2026-06-05': 96,
      '2026-06-08': 90,
    });
    const rows = [mkRow('2026-06-01', 100)];
    const r = computeScenarioBrier(rows, downPrices, 5);
    expect(r.brierScore).toBeCloseTo(1, 6);
    expect(r.upRatePct).toBe(0);
  });

  it('气候学基准与技巧分方向正确（预报恒 100% 上行、实际 50% 涨）', () => {
    // 两天报告：一天实际涨、一天实际跌 → upRate=50%
    // 预报恒 pUp=1 → brier = (1-1)²+(1-0)² /2 = 0.5；climo(0.5) = 0.25 → 技巧分 = -1（差于气候学）
    const mixed = mkPrices({
      '2026-06-01': 100,
      '2026-06-02': 101,
      '2026-06-03': 102,
      '2026-06-04': 103,
      '2026-06-05': 104,
      '2026-06-08': 110, // 06-01 的 5 日窗口 → 涨
      '2026-06-09': 100,
      '2026-06-10': 99,
      '2026-06-11': 98,
      '2026-06-12': 97,
      '2026-06-15': 90, // 06-08 的 5 日窗口 → 跌
    });
    const rows = [mkRow('2026-06-01', 100), mkRow('2026-06-08', 100)];
    const r = computeScenarioBrier(rows, mixed, 5);
    expect(r.evaluatedCount).toBe(2);
    expect(r.upRatePct).toBe(50);
    expect(r.brierScore).toBeCloseTo(0.5, 6);
    expect(r.brierClimatology).toBeCloseTo(0.25, 6);
    expect(r.skillVsClimatology).toBeCloseTo(-1, 3);
  });

  it('持平死区内的实际涨跌不计入分母', () => {
    const flat = mkPrices({
      '2026-06-01': 100,
      '2026-06-02': 100.01,
      '2026-06-03': 100.02,
      '2026-06-04': 100.03,
      '2026-06-05': 100.04,
      '2026-06-08': 100.05, // +0.05% < 0.1% → flat
    });
    const rows = [mkRow('2026-06-01', 80)];
    const r = computeScenarioBrier(rows, flat, 5);
    expect(r.evaluatedCount).toBe(0);
    expect(r.pendingCount).toBe(1);
    expect(r.brierScore).toBeNull();
  });

  it('窗口未回填 → pending，不算 unusable', () => {
    const rows = [mkRow('2026-06-01', 60)];
    const thin = mkPrices({ '2026-06-01': 100, '2026-06-02': 101 });
    const r = computeScenarioBrier(rows, thin, 5);
    expect(r.pendingCount).toBe(1); // 不足 minPartialDays=3
    expect(r.unusableCount).toBe(0);
  });

  it('情景缺失 / 概率越界 / JSON 损坏 → unusable', () => {
    const broken = [mkRow('2026-06-01', null)];
    const r1 = computeScenarioBrier(broken, upPrices, 5);
    expect(r1.unusableCount).toBe(1);

    const outOfRange: AnalysisReportRow = {
      ...mkRow('2026-06-02', 50),
      reportJson: JSON.stringify({ overall: { scenarios: { upside: { probability: 150 } } } }),
    };
    const r2 = computeScenarioBrier([outOfRange], upPrices, 5);
    expect(r2.unusableCount).toBe(1);

    const badJson: AnalysisReportRow = { ...mkRow('2026-06-03', 50), reportJson: '{oops' };
    const r3 = computeScenarioBrier([badJson], upPrices, 5);
    expect(r3.unusableCount).toBe(1);
  });

  it('可靠性分桶：预报均值与实际上涨频率按区间聚合', () => {
    // 12 个连续交易日单边上涨；前 4 天预报上行 20%，后 4 天预报 80%
    const dates = Array.from({ length: 12 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`);
    const rising = mkPrices(Object.fromEntries(dates.map((d, i) => [d, 100 + i])));
    const rows = dates.slice(0, 8).map((d, i) => mkRow(d, i < 4 ? 20 : 80));
    const r = computeScenarioBrier(rows, rising, 5);
    expect(r.evaluatedCount).toBe(8);
    // 预报恰好 20% 落在 [20,40) 区间、恰好 80% 落在 [80,100] 区间（左闭右开）
    const b20 = r.buckets.find(b => b.range === '20–40%');
    const b80 = r.buckets.find(b => b.range === '80–100%');
    expect(b20?.sample).toBe(4);
    expect(b80?.sample).toBe(4);
    expect(b20?.empiricalUpRate).toBe(100);
    expect(b80?.empiricalUpRate).toBe(100);
    // 预报 20 的样本全涨 → Brier 差于预报 80 的样本；总体 Brier = (0.64*4 + 0.04*4)/8 = 0.34
    expect(r.brierScore).toBeCloseTo(0.34, 4);
  });
});
