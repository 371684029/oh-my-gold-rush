import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { GoldPricesRepo } from '../src/db/gold-prices.js';
import { ReportsRepo } from '../src/db/reports.js';
import {
  forwardPathCumPct,
  buildProbPathMeta,
  realizedDailyVolPct,
} from '../src/utils/prob-path-forecast.js';
import { renderProbPathFanSvg } from '../src/utils/prob-path-chart.js';
import { PROB_PATH_SCHEMA } from '../src/utils/prob-path-types.js';

let db: Database.Database;

function dateStr(dayOffset: number): string {
  const d = new Date(Date.UTC(2026, 4, 1 + dayOffset));
  return d.toISOString().slice(0, 10);
}

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE gold_prices (
      date TEXT PRIMARY KEY,
      london_close REAL, london_high REAL, london_low REAL,
      shanghai_close REAL, shanghai_high REAL, shanghai_low REAL,
      etf_nav REAL, etf_change REAL,
      dollar_index REAL, us10y_yield REAL, tips_yield REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE analysis_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT, horizon TEXT, report_json TEXT,
      overall_score REAL, quant_score REAL, mid_term_score REAL,
      direction TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE scenario_features (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT, report_id INTEGER,
      dollar_direction TEXT, dollar_magnitude REAL,
      tips_direction TEXT, tips_magnitude REAL,
      gold_deviation REAL, vix_level REAL,
      fed_stance TEXT, geopolitical_risk TEXT,
      momentum_direction TEXT, consecutive_days INTEGER,
      cftc_percentile REAL, etf_flow_5d REAL, flow_score REAL,
      actual_5d_return REAL, actual_5d_direction TEXT,
      actual_20d_return REAL, backfill_status TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const prices = new GoldPricesRepo(db);
  const base = 4000;
  for (let i = 0; i < 65; i++) {
    const d = dateStr(i);
    // 温和震荡上行序列
    const wave = Math.sin(i * 0.45) * 28;
    const close = Math.round((base + i * 4.5 + wave) * 100) / 100;
    prices.upsert({
      date: d,
      londonClose: close,
      londonHigh: close + 12,
      londonLow: close - 12,
      shanghaiClose: null,
      shanghaiHigh: null,
      shanghaiLow: null,
      etfNav: null,
      etfChange: null,
      dollarIndex: 100,
      us10yYield: 4.4,
      tipsYield: 2.0,
    });
  }

  const reports = new ReportsRepo(db);
  for (let i = 0; i < 45; i++) {
    const d = dateStr(i);
    reports.insert({
      date: d,
      horizon: 'all',
      reportJson: '{}',
      overallScore: 52 + (i % 5),
      quantScore: 50,
      direction: 'neutral',
    });
  }
});

afterAll(() => {
  db.close();
});

describe('forwardPathCumPct', () => {
  it('computes cumulative % over h days and respects maxDate (zero look-ahead)', () => {
    const prices = new GoldPricesRepo(db);
    const d0 = dateStr(0);
    const d4 = dateStr(4);
    const d5 = dateStr(5);

    const path = forwardPathCumPct(prices, d0, 5, d5);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(5);

    // 若 maxDate 早于第 5 天终点，必须拒绝以防前视泄露
    const blocked = forwardPathCumPct(prices, d0, 5, d4);
    expect(blocked).toBeNull();
  });
});

describe('realizedDailyVolPct', () => {
  it('computes positive 20d realized volatility %', () => {
    const prices = new GoldPricesRepo(db);
    const vol = realizedDailyVolPct(prices, dateStr(55));
    expect(vol).not.toBeNull();
    expect(vol!).toBeGreaterThan(0);
  });
});

describe('buildProbPathMeta v2.0', () => {
  it('returns spot-anchored history, dual-track horizons, monotonic p10..p90, pathRisk, and light SVG', () => {
    const asOf = dateStr(58);
    const meta = buildProbPathMeta({
      db,
      asOf,
      score: 54,
    });
    expect(meta).not.toBeNull();
    expect(meta!.schemaVersion).toBe(PROB_PATH_SCHEMA);
    expect(meta!.vol20dPct).not.toBeNull();

    // 历史段末端必须严格锚定今日 0%，杜绝断崖跳变
    const lastHist = meta!.history[meta!.history.length - 1]!;
    expect(lastHist.date).toBe(asOf);
    expect(lastHist.cumPct).toBe(0);

    // 5 日视野应比 20 日视野拥有更多可用样本（双轨独立）
    const h5 = meta!.horizons['5'];
    const h20 = meta!.horizons['20'];
    expect(h5.points.length).toBe(5);
    expect(h20.points.length).toBe(20);
    expect((h5.sampleSize ?? 0)).toBeGreaterThanOrEqual(h20.sampleSize ?? 0);

    // 分位单调性 p10 <= p25 <= p50 <= p75 <= p90
    for (const pt of h5.points) {
      expect(pt.p10).toBeLessThanOrEqual(pt.p25!);
      expect(pt.p25!).toBeLessThanOrEqual(pt.p50);
      expect(pt.p50).toBeLessThanOrEqual(pt.p75!);
      expect(pt.p75!).toBeLessThanOrEqual(pt.p90);
    }

    // 路径风险摘要存在且合理
    expect(h5.pathRisk).not.toBeNull();
    expect(h5.pathRisk!.maxDdP90).toBeLessThanOrEqual(h5.pathRisk!.maxDdP50);
    expect(h5.pathRisk!.upEndProb).toBeGreaterThanOrEqual(0);
    expect(h5.pathRisk!.upEndProb).toBeLessThanOrEqual(100);

    // 动态支撑/压力分类正确：高于现价为阻力，低于现价为支撑
    const ma20 = meta!.structure.find(s => s.label.includes('MA20'));
    expect(ma20).toBeDefined();
    expect(ma20!.kind).toBe(ma20!.pctFromSpot >= 0 ? 'resistance' : 'support');

    // 浅色主题 SVG 渲染正常
    const svg = renderProbPathFanSvg(meta!, '5');
    expect(svg).toContain('<svg');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('P50');
  });

  it('has strictly zero look-ahead when mutating prices after asOf', () => {
    const asOf = dateStr(40);
    const before = buildProbPathMeta({ db, asOf, score: 54 });
    expect(before).not.toBeNull();

    // 篡改 asOf 之后的价格为暴涨 2 倍
    const prices = new GoldPricesRepo(db);
    const futureDate = dateStr(42);
    const orig = prices.getByDate(futureDate)!;
    prices.upsert({ ...orig, londonClose: orig.londonClose! * 2 });

    const after = buildProbPathMeta({ db, asOf, score: 54 });
    expect(after).not.toBeNull();
    expect(after!.horizons['5'].points).toEqual(before!.horizons['5'].points);
    expect(after!.horizons['20'].points).toEqual(before!.horizons['20'].points);

    // 还原
    prices.upsert(orig);
  });
});
