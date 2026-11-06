import { describe, it, expect } from 'vitest';
import { buildCalibrationTearsheet } from '../src/utils/calibration-tearsheet';
import type { AnalysisReportRow } from '../src/db/reports';
import type { GoldPricesRepo } from '../src/db/gold-prices';

function mockPrices(): GoldPricesRepo {
  const prices: Record<string, number> = {
    '2026-06-01': 2000,
    '2026-06-02': 2010,
    '2026-06-03': 2020,
    '2026-06-04': 2030,
    '2026-06-05': 2040,
    '2026-06-06': 2050,
    '2026-06-07': 2060,
  };
  return {
    getByDate: (date: string) => (prices[date] != null ? { londonClose: prices[date] } : undefined),
    getAfter: (date: string, limit: number) => {
      const dates = Object.keys(prices).filter(d => d > date).sort().slice(0, limit);
      return dates.map(d => ({ date: d, londonClose: prices[d] }));
    },
  } as unknown as GoldPricesRepo;
}

describe('buildCalibrationTearsheet', () => {
  it('空报告返回空曲线', () => {
    const sheet = buildCalibrationTearsheet([], mockPrices());
    expect(sheet.sampleCount).toBe(0);
    expect(sheet.equity.points).toHaveLength(0);
  });

  it('有报告与金价时生成区间统计', () => {
    const reports: AnalysisReportRow[] = [
      { id: 1, date: '2026-06-01', horizon: 'all', reportJson: '{}', overallScore: 60, direction: 'neutral', quantScore: null, midTermScore: null, createdAt: '' },
      { id: 2, date: '2026-06-02', horizon: 'all', reportJson: '{}', overallScore: 70, direction: 'bullish', quantScore: null, midTermScore: null, createdAt: '' },
      { id: 3, date: '2026-06-03', horizon: 'all', reportJson: '{}', overallScore: 80, direction: 'bullish', quantScore: null, midTermScore: null, createdAt: '' },
    ];
    const sheet = buildCalibrationTearsheet(reports, mockPrices(), 2);
    expect(sheet.sampleCount).toBeGreaterThan(0);
    expect(sheet.bucketStats.length).toBeGreaterThan(0);
  });

  it('纸面权益：日频不重叠回放，proxy 决策计 warning', () => {
    const reports: AnalysisReportRow[] = [
      { id: 1, date: '2026-06-01', horizon: 'all', reportJson: '{}', overallScore: 60, direction: 'neutral', quantScore: null, midTermScore: null, createdAt: '' },
      { id: 2, date: '2026-06-02', horizon: 'all', reportJson: '{}', overallScore: 70, direction: 'bullish', quantScore: null, midTermScore: null, createdAt: '' },
      { id: 3, date: '2026-06-03', horizon: 'all', reportJson: '{}', overallScore: 80, direction: 'bullish', quantScore: null, midTermScore: null, createdAt: '' },
    ];
    const sheet = buildCalibrationTearsheet(reports, mockPrices());
    // 决策从 06-01 起，价格 06-01..07 → 06-02..07 共 6 个回放日
    expect(sheet.equity.points).toHaveLength(6);
    expect(sheet.equity.storedDecisions).toBe(0);
    expect(sheet.equity.proxyDecisions).toBe(3);
    // 满仓基准 = 2060/2000 - 1 = +3%
    expect(sheet.equity.hold.totalReturnPct).toBeCloseTo(3, 5);
    // 首个回放日应用 06-01 的决策（proxy：60 → 65%）
    expect(sheet.equity.points[0].appliedPct).toBe(65);
    // MaxDD 单边上涨应为 0
    expect(sheet.equity.strategy.maxDrawdownPct).toBe(0);
  });

  it('纸面权益：入库仓位（stored）优先于 proxy', () => {
    const reports: AnalysisReportRow[] = [
      {
        id: 1, date: '2026-06-01', horizon: 'all',
        reportJson: JSON.stringify({ overall: { positionTargetPct: 30 } }),
        overallScore: 60, direction: 'neutral', quantScore: null, midTermScore: null, createdAt: '',
      },
    ];
    const sheet = buildCalibrationTearsheet(reports, mockPrices());
    expect(sheet.equity.storedDecisions).toBe(1);
    expect(sheet.equity.points[0].appliedPct).toBe(30);
  });
});
