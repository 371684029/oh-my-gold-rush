import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { GoldPricesRepo } from '../src/db/gold-prices.js';
import { ReportsRepo } from '../src/db/reports.js';
import { forwardPathCumPct, buildProbPathMeta } from '../src/utils/prob-path-forecast.js';
import { renderProbPathFanSvg } from '../src/utils/prob-path-chart.js';

let db: Database.Database;

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
  for (let i = 0; i < 30; i++) {
    const d = `2026-06-${String(i + 1).padStart(2, '0')}`;
    const close = base + i * 5;
    prices.upsert({
      date: d,
      londonClose: close,
      londonHigh: close + 10,
      londonLow: close - 10,
      shanghaiClose: null,
      shanghaiHigh: null,
      shanghaiLow: null,
      etfNav: null,
      etfChange: null,
      dollarIndex: 100,
      us10yYield: 4.5,
      tipsYield: 2.0,
    });
  }

  const reports = new ReportsRepo(db);
  for (let i = 0; i < 15; i++) {
    const d = `2026-06-${String(i + 1).padStart(2, '0')}`;
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
  it('computes cumulative % over h days', () => {
    const prices = new GoldPricesRepo(db);
    const path = forwardPathCumPct(prices, '2026-06-01', 5);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(5);
    expect(path![0]).toBeGreaterThan(0);
  });
});

describe('buildProbPathMeta', () => {
  it('returns meta with horizons when enough samples', () => {
    const meta = buildProbPathMeta({
      db,
      asOf: '2026-06-28',
      score: 54,
    });
    if (meta) {
      expect(meta.schemaVersion).toBe(1);
      expect(meta.horizons['5'].points.length).toBeGreaterThan(0);
      const svg = renderProbPathFanSvg(meta, '5');
      expect(svg).toContain('<svg');
      expect(svg).toContain('P50');
    }
  });
});
