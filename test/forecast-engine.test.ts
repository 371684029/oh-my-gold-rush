import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface DailyRecord {
  date: string;
  filename: string | null;
  hasAiReport: boolean;
  dataSource: string;
  londonClose: number;
  shanghaiClose: number | null;
  cnyPerGram: number | null;
  cnySource: string;
  usdCnyRate: number;
  overallScore: number | null;
  quantScore: number | null;
  technicalScore: number | null;
  fundamentalScore: number | null;
  sentimentScore: number | null;
  tipsYield: number | null;
  dxy: number | null;
  us10y: number | null;
  flowScore: number | null;
  gate: { tier: string; actionable: boolean };
}

interface ForecastPoint {
  h: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  usd: { p10: number; p25: number; p50: number; p75: number; p90: number };
  cny: { p10: number; p25: number; p50: number; p75: number; p90: number };
}

interface HorizonForecast {
  horizon: number;
  degraded: string;
  pillarWeights: { technical: number; fundamental: number; information: number };
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
    maxDdP50: number;
    maxDdP90: number;
    upEndProb: number;
  };
  points: ForecastPoint[];
  structure: Array<{ label: string; kind: 'resistance' | 'support'; pctFromSpot: number; priceUsd: number; priceCny: number }>;
  actualReplay: Array<{ h: number; date: string; pct: number; usd: number; cny: number }>;
}

interface DailyForecastBundle {
  asOf: string;
  filename: string | null;
  hasAiReport: boolean;
  dataSource: string;
  totalTradingDays: number;
  spot: { usd: number; cny: number; cnySource: string; usdCnyRate: number };
  history: Array<{ date: string; usd: number; cny: number; pct: number }>;
  horizons: Record<'5' | '20' | '60', HorizonForecast>;
  pillarsByHorizon: Record<'5' | '20' | '60', { fundamental: { weightPct: number }; information: { weightPct: number }; technical: { weightPct: number } }>;
}

const forecastData = require('../web/forecast-data.cjs') as {
  TROY_OUNCE_TO_GRAM: number;
  loadDailyForecastDataset: (dir: string) => DailyRecord[];
};

const forecastEngine = require('../web/forecast-engine.cjs') as {
  HORIZONS: number[];
  HORIZON_PILLAR_WEIGHTS: Record<number, { technical: number; fundamental: number; information: number }>;
  weightedQuantile: (values: number[], weights: number[], q: number) => number;
  buildDailyGoldForecast: (records: DailyRecord[], asOfDate?: string) => DailyForecastBundle | null;
  buildDailyForecastArchive: (records: DailyRecord[], limit?: number) => Array<{ date: string; hasAiReport: boolean; p50_5d: number; actual5dPct: number | null }>;
};

const DOCS_DIR = path.resolve(process.cwd(), 'docs');

describe('web/forecast-data + web/forecast-engine (5-year fused real dataset)', () => {
  const records = forecastData.loadDailyForecastDataset(DOCS_DIR);

  it('loads 5-year fused gold records up to 2026-11-26 without zero or NaN prices', () => {
    expect(records.length).toBeGreaterThanOrEqual(1200);
    expect(records[records.length - 1]!.date >= '2026-11-26').toBe(true);
    for (const r of records) {
      expect(Number.isFinite(r.londonClose)).toBe(true);
      expect(r.londonClose).toBeGreaterThan(1000);
      expect(r.cnyPerGram).not.toBeNull();
      expect(r.cnyPerGram!).toBeGreaterThan(250);
    }
    for (let i = 1; i < records.length; i++) {
      expect(records[i]!.date > records[i - 1]!.date).toBe(true);
    }
  });

  it('distinguishes AI-report fused days from live-market-only days honestly', () => {
    const fcLatest = forecastEngine.buildDailyGoldForecast(records)!;
    expect(fcLatest.asOf >= '2026-11-26').toBe(true);
    expect(fcLatest.hasAiReport).toBe(false);
    expect(fcLatest.filename).toBeNull();
    expect(fcLatest.spot.cnySource).toBe('shanghai');
    expect(fcLatest.totalTradingDays).toBe(records.length);

    const fcAi = forecastEngine.buildDailyGoldForecast(records, '2026-11-06')!;
    expect(fcAi.asOf).toBe('2026-11-06');
    expect(fcAi.hasAiReport).toBe(true);
    expect(fcAi.filename).toBe('goldrush-analysis-2026-11-06.md');
  });

  it('builds 5d / 20d / 60d conditional FHS forecasts with monotonic quantiles and spot-anchored CNY', () => {
    const fc = forecastEngine.buildDailyGoldForecast(records)!;

    // 历史最后一天锚定 0%
    const lastHist = fc.history[fc.history.length - 1]!;
    expect(lastHist.date).toBe(fc.asOf);
    expect(lastHist.pct).toBe(0);
    expect(lastHist.cny).toBe(fc.spot.cny);

    // 5年数据下，连 60 日长视野都拥有真实条件历史样本（不再降级为分块模拟）
    expect(fc.horizons['60'].sampleStats.method).toBe('conditional_fhs_shrinkage');
    expect(fc.horizons['60'].sampleStats.rawSampleSize).toBeGreaterThan(1000);

    for (const key of ['5', '20', '60'] as const) {
      const h = fc.horizons[key];
      expect(h.points.length).toBe(Number(key));
      expect(h.sampleStats.currentVolPct).toBeGreaterThan(0);
      expect(h.summary.maxDdP90).toBeLessThanOrEqual(h.summary.maxDdP50);
      expect(h.summary.upEndProb).toBeGreaterThanOrEqual(0);
      expect(h.summary.upEndProb).toBeLessThanOrEqual(100);

      for (const pt of h.points) {
        expect(pt.p10).toBeLessThanOrEqual(pt.p25);
        expect(pt.p25).toBeLessThanOrEqual(pt.p50);
        expect(pt.p50).toBeLessThanOrEqual(pt.p75);
        expect(pt.p75).toBeLessThanOrEqual(pt.p90);
        expect(pt.usd.p10).toBeLessThanOrEqual(pt.usd.p50);
        expect(pt.usd.p50).toBeLessThanOrEqual(pt.usd.p90);
        expect(pt.cny.p10).toBeLessThanOrEqual(pt.cny.p50);
        expect(pt.cny.p50).toBeLessThanOrEqual(pt.cny.p90);
        // CNY 预测锚定实时上海金现价，无缝衔接 T+0
        const expectedCny = fc.spot.cny * (1 + pt.p50 / 100);
        expect(Math.abs(pt.cny.p50 - expectedCny)).toBeLessThan(0.15);
      }

      for (const s of h.structure) {
        expect(s.kind).toBe(s.pctFromSpot >= 0 ? 'resistance' : 'support');
      }
    }
  });

  it('shifts three-pillar weights by horizon (5d tech-heavy vs 60d fundamental-heavy)', () => {
    const w5 = forecastEngine.HORIZON_PILLAR_WEIGHTS[5]!;
    const w20 = forecastEngine.HORIZON_PILLAR_WEIGHTS[20]!;
    const w60 = forecastEngine.HORIZON_PILLAR_WEIGHTS[60]!;
    expect(w5.technical).toBeGreaterThan(w60.technical);
    expect(w60.fundamental).toBeGreaterThan(w5.fundamental);
    expect(Math.abs(w5.technical + w5.fundamental + w5.information - 1)).toBeLessThan(1e-6);
    expect(Math.abs(w20.technical + w20.fundamental + w20.information - 1)).toBeLessThan(1e-6);
    expect(Math.abs(w60.technical + w60.fundamental + w60.information - 1)).toBeLessThan(1e-6);
  });

  it('guarantees strict causality (zero look-ahead) across 5 years and provides actualReplay', () => {
    const histIdx = records.length - 15;
    const targetDate = records[histIdx]!.date;
    const origForecast = forecastEngine.buildDailyGoldForecast(records, targetDate)!;

    expect(origForecast.horizons['5'].actualReplay.length).toBe(5);

    const mutated = records.map((r, i) =>
      i > histIdx
        ? { ...r, londonClose: r.londonClose * 2.5, overallScore: 99, fundamentalScore: 99 }
        : r,
    );
    const mutatedForecast = forecastEngine.buildDailyGoldForecast(mutated, targetDate)!;

    expect(mutatedForecast.horizons['5'].points).toEqual(origForecast.horizons['5'].points);
    expect(mutatedForecast.horizons['20'].points).toEqual(origForecast.horizons['20'].points);
    expect(mutatedForecast.horizons['60'].points).toEqual(origForecast.horizons['60'].points);
    expect(mutatedForecast.horizons['5'].sampleStats).toEqual(origForecast.horizons['5'].sampleStats);
  });

  it('generates daily forecast archive entries with provenance flags', () => {
    const archive = forecastEngine.buildDailyForecastArchive(records, 18);
    expect(archive.length).toBe(18);
    expect(archive[0]!.date).toBe(records[records.length - 1]!.date);
    expect(archive[0]!.hasAiReport).toBe(false);
    expect(archive.some(a => a.hasAiReport)).toBe(true);
    expect(archive[archive.length - 1]!.actual5dPct).not.toBeNull();
  });
});
