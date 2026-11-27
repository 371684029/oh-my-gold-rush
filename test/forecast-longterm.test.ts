import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface MonthlyRow {
  ym: string;
  date: string;
  londonClose: number;
  dxy?: number;
  us10y?: number;
  tips?: number;
  cpi?: number;
  cpiYoY?: number;
  usdCny?: number;
  realGoldIndex?: number;
  tipsObsDate?: string;
  cpiObsDate?: string;
}

interface LongTermPoint {
  h: number;
  ym: string;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  baselineP50: number;
  cagrP50: number;
  usd: { p10: number; p25: number; p50: number; p75: number; p90: number };
  cny: { p10: number; p25: number; p50: number; p75: number; p90: number };
}

interface FactorAuditRow {
  factor: string;
  currentValue: string;
  sourceDate: string;
  percentile25y: string;
  impact: string;
  impactLabel: string;
  empiricalStat: string;
  mechanism: string;
}

interface MacroScenario {
  key: 'bull' | 'base' | 'bear';
  title: string;
  probPct: number;
  trigger: string;
  targetPct: number;
  cagrPct: number;
  targetUsd: number;
  targetCny: number;
  stance: string;
}

interface LongTermHorizon {
  horizon: '1y' | '2y' | '5y';
  isLongTerm: boolean;
  months: number;
  years: number;
  sampleStats: {
    rawSampleSize: number;
    effectiveSampleSize: number;
    shrinkageWeight: number;
    currentVolPct: number;
    annualizedVolPct: number;
    method: string;
  };
  summary: {
    endP10Pct: number;
    endP25Pct: number;
    endP50Pct: number;
    endP75Pct: number;
    endP90Pct: number;
    cagr: { p10: number; p25: number; p50: number; p75: number; p90: number; baselineP50: number };
    maxDdP50: number;
    maxDdP90: number;
    upEndProb: number;
    beatCpiProb: number | null;
  };
  points: LongTermPoint[];
  structure: Array<{ label: string; kind: 'resistance' | 'support'; pctFromSpot: number; priceUsd: number; priceCny: number }>;
  topAnalogs: Array<{ date: string; endDate: string; eraLabel: string; macroSnap: string; similarity: number; rawEndPct: number; cagrPct: number; maxDdPct: number }>;
  actualReplay: Array<{ h: number; date: string; pct: number; usd: number; cny: number }>;
  evidence: {
    factorAudit: FactorAuditRow[];
    scenarios: MacroScenario[];
    invalidationTriggers: Array<{ metric: string; current: string; trigger: string; meaning: string }>;
    methodologyNote: string;
  };
}

interface FullForecastBundle {
  asOf: string;
  spot: { usd: number; cny: number };
  monthlyStats: { bars: number; from: string; to: string } | null;
  historyByHorizon: Record<string, Array<{ date: string; usd: number; cny: number; pct: number }>>;
  horizons: Record<'5' | '20' | '60' | '1y' | '2y' | '5y', LongTermHorizon>;
  pillarsByHorizon: Record<string, { fundamental: { weightPct: number }; information: { weightPct: number }; technical: { weightPct: number } }>;
}

const forecastData = require('../web/forecast-data.cjs') as {
  loadDailyForecastDataset: (dir: string) => unknown[];
  loadMonthlyForecastDataset: (dir: string) => MonthlyRow[];
};

const forecastEngine = require('../web/forecast-engine.cjs') as {
  buildDailyGoldForecast: (records: unknown[], asOfDate?: string, monthlyRecords?: MonthlyRow[]) => FullForecastBundle | null;
};

const DOCS_DIR = path.resolve(process.cwd(), 'docs');

function monthsApart(ymA: string, ymB: string): number {
  const [ya, ma] = ymA.split('-').map(Number);
  const [yb, mb] = ymB.split('-').map(Number);
  return Math.abs((ya! * 12 + ma!) - (yb! * 12 + mb!));
}

describe('web/forecast-longterm (26-year real monthly dataset + 1Y/2Y/5Y auditable engine)', () => {
  const dailyRecords = forecastData.loadDailyForecastDataset(DOCS_DIR);
  const monthlyRecords = forecastData.loadMonthlyForecastDataset(DOCS_DIR);

  it('persists 26-year continuous monthly snapshot in Git with real FRED TIPS/CPI & Yahoo DXY', () => {
    expect(monthlyRecords.length).toBeGreaterThanOrEqual(300);
    expect(monthlyRecords[0]!.ym <= '2000-10').toBe(true);
    expect(monthlyRecords[monthlyRecords.length - 1]!.ym >= '2026-11').toBe(true);

    const macroComplete = monthlyRecords.filter(
      r => r.tips != null && r.cpi != null && r.cpiYoY != null && r.dxy != null && r.realGoldIndex != null,
    );
    expect(macroComplete.length).toBeGreaterThanOrEqual(270);

    for (let i = 1; i < monthlyRecords.length; i++) {
      expect(monthlyRecords[i]!.ym > monthlyRecords[i - 1]!.ym).toBe(true);
      expect(monthlyRecords[i]!.londonClose).toBeGreaterThan(200);
    }
  });

  it('builds 1y / 2y / 5y macro forecasts with monotonic quantiles, CAGR, and beat-CPI stats', () => {
    const fc = forecastEngine.buildDailyGoldForecast(dailyRecords, undefined, monthlyRecords)!;
    expect(fc).not.toBeNull();
    expect(fc.monthlyStats).not.toBeNull();
    expect(fc.monthlyStats!.bars).toBeGreaterThanOrEqual(300);

    const expectedMonths: Record<'1y' | '2y' | '5y', number> = { '1y': 12, '2y': 24, '5y': 60 };
    for (const key of ['1y', '2y', '5y'] as const) {
      const h = fc.horizons[key];
      expect(h.isLongTerm).toBe(true);
      expect(h.points.length).toBe(expectedMonths[key]);
      expect(h.sampleStats.method).toBe('macro_26y_demeaned_log_fhs_mixed_weights');
      expect(h.sampleStats.rawSampleSize).toBeGreaterThanOrEqual(200);
      expect(h.sampleStats.effectiveSampleSize).toBeGreaterThan(10);
      expect(h.summary.beatCpiProb).not.toBeNull();
      expect(h.summary.beatCpiProb!).toBeGreaterThan(0);
      expect(h.summary.beatCpiProb!).toBeLessThanOrEqual(100);
      expect(h.summary.maxDdP90).toBeLessThanOrEqual(h.summary.maxDdP50);

      // CAGR 单调有序
      expect(h.summary.cagr.p10).toBeLessThanOrEqual(h.summary.cagr.p25);
      expect(h.summary.cagr.p25).toBeLessThanOrEqual(h.summary.cagr.p50);
      expect(h.summary.cagr.p50).toBeLessThanOrEqual(h.summary.cagr.p75);
      expect(h.summary.cagr.p75).toBeLessThanOrEqual(h.summary.cagr.p90);

      // 每个未来月均单调且具真实 YYYY-MM 日期与联合 USD/CNY 汇率路径（F12）
      for (const pt of h.points) {
        expect(/^\d{4}-\d{2}$/.test(pt.ym)).toBe(true);
        expect(pt.p10).toBeLessThanOrEqual(pt.p25);
        expect(pt.p25).toBeLessThanOrEqual(pt.p50);
        expect(pt.p50).toBeLessThanOrEqual(pt.p75);
        expect(pt.p75).toBeLessThanOrEqual(pt.p90);
        expect(pt.usd.p10).toBeLessThanOrEqual(pt.usd.p50);
        expect(pt.usd.p50).toBeLessThanOrEqual(pt.usd.p90);
        expect(pt.cny.p10).toBeLessThanOrEqual(pt.cny.p25);
        expect(pt.cny.p25).toBeLessThanOrEqual(pt.cny.p50);
        expect(pt.cny.p50).toBeLessThanOrEqual(pt.cny.p75);
        expect(pt.cny.p75).toBeLessThanOrEqual(pt.cny.p90);
        const frozenCny = fc.spot.cny * (1 + pt.p50 / 100);
        expect(Math.abs(pt.cny.p50 - frozenCny) / frozenCny).toBeLessThan(0.25);
      }

      // 月线历史尾点锚定现价 0%
      const ltHist = fc.historyByHorizon[key]!;
      expect(ltHist.length).toBeGreaterThanOrEqual(36);
      expect(ltHist[ltHist.length - 1]!.pct).toBe(0);
      expect(ltHist[ltHist.length - 1]!.usd).toBe(fc.spot.usd);
    }

    // 长期权重由基本面慢变量绝对主导（与日线噪声脱钩）
    expect(fc.pillarsByHorizon['5y']!.fundamental.weightPct).toBe(80);
    expect(fc.pillarsByHorizon['5y']!.technical.weightPct).toBe(5);
  });

  it('produces complete auditable evidence chains and independent non-overlapping cycle analogs', () => {
    const fc = forecastEngine.buildDailyGoldForecast(dailyRecords, undefined, monthlyRecords)!;
    const h5y = fc.horizons['5y'];

    expect(h5y.evidence.factorAudit.length).toBe(6);
    expect(h5y.evidence.factorAudit.some(r => r.sourceDate.includes('FRED DFII10'))).toBe(true);
    expect(h5y.evidence.factorAudit.some(r => r.sourceDate.includes('FRED CPIAUCSL'))).toBe(true);
    expect(h5y.evidence.factorAudit.every(r => r.empiricalStat.length > 10)).toBe(true);

    expect(h5y.evidence.scenarios.length).toBe(3);
    const totalProb = h5y.evidence.scenarios.reduce((s, x) => s + x.probPct, 0);
    expect(totalProb).toBe(100);
    expect(h5y.evidence.invalidationTriggers.length).toBeGreaterThanOrEqual(3);

    // Top 5 独立历史周期起点必须两两相隔至少 12 个月，防止相邻月份凑数
    expect(h5y.topAnalogs.length).toBe(5);
    for (let i = 0; i < h5y.topAnalogs.length; i++) {
      expect(h5y.topAnalogs[i]!.eraLabel.length).toBeGreaterThan(4);
      expect(h5y.topAnalogs[i]!.macroSnap.includes('TIPS')).toBe(true);
      for (let j = i + 1; j < h5y.topAnalogs.length; j++) {
        expect(monthsApart(h5y.topAnalogs[i]!.date, h5y.topAnalogs[j]!.date)).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it('guarantees strict zero look-ahead for 1Y/2Y/5Y and generates real actualReplay on past dates', () => {
    const targetDate = '2024-11-01';
    const orig = forecastEngine.buildDailyGoldForecast(dailyRecords, targetDate, monthlyRecords)!;
    expect(orig.horizons['1y'].actualReplay.length).toBe(12);

    // 极端篡改 2024-11 之后的所有未来月线数据，验证 2024-11-01 的 1y/2y/5y 预测结果按位完全不变
    const mutatedMonthly = monthlyRecords.map(r =>
      r.ym > '2024-11'
        ? { ...r, londonClose: r.londonClose * 4, tips: -5, cpiYoY: 18, dxy: 60 }
        : r,
    );
    const afterMutate = forecastEngine.buildDailyGoldForecast(dailyRecords, targetDate, mutatedMonthly)!;

    expect(afterMutate.horizons['1y'].points).toEqual(orig.horizons['1y'].points);
    expect(afterMutate.horizons['2y'].points).toEqual(orig.horizons['2y'].points);
    expect(afterMutate.horizons['5y'].points).toEqual(orig.horizons['5y'].points);
    expect(afterMutate.horizons['5y'].topAnalogs).toEqual(orig.horizons['5y'].topAnalogs);
    expect(afterMutate.horizons['5y'].evidence.factorAudit).toEqual(orig.horizons['5y'].evidence.factorAudit);
  });
});
