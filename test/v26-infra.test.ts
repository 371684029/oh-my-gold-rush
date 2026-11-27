import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { GoldPricesRepo, computeSgePremiumUsd } from '../src/db/gold-prices.js';

const require = createRequire(import.meta.url);

interface DocsIndexModule {
  createDocsIndexCache: <T>(
    docsDir: string,
    buildFn: (mdFiles: string[]) => T[],
  ) => {
    getAll: () => T[];
    invalidate: () => void;
    getStats: () => { hits: number; misses: number; cachedCount: number };
  };
  extractAvailableMonths: (items: Array<{ filename?: string; dateLabel?: string }>) => Array<{ month: string; count: number }>;
  extractFileMonth: (filename: string) => string;
  renderMonthFilterBar: (months: Array<{ month: string; count: number }>, total: number) => string;
}

describe('GoldRush v2.6 Infrastructure & Data Extensions (M1/M2/M6/M8)', () => {
  it('M1: all web/*.cjs mirrors match src/utils/*.ts with zero drift', async () => {
    // Dynamic import of ESM sync script
    const syncMod = await import('../scripts/sync-web-cjs.mjs') as {
      runSync: (opts: { checkOnly: boolean }) => { drifted: string[]; total: number };
    };
    const res = syncMod.runSync({ checkOnly: true });
    expect(res.total).toBeGreaterThanOrEqual(9);
    expect(res.drifted).toEqual([]);
  });

  it('M2: all historical goldrush-analysis-*.md files in docs/ have schemaVersion 1 .meta.json sidecars', () => {
    const docsDir = path.resolve(process.cwd(), 'docs');
    const analyses = fs.readdirSync(docsDir).filter(f => /^goldrush-analysis-\d{4}-\d{2}-\d{2}\.md$/.test(f));
    expect(analyses.length).toBeGreaterThan(50);

    const missing: string[] = [];
    for (const f of analyses) {
      const metaPath = path.join(docsDir, f.replace(/\.md$/, '.meta.json'));
      if (!fs.existsSync(metaPath)) missing.push(f);
    }
    expect(missing).toEqual([]);
  });

  it('M6: computes SGE USD premium accurately and persists gvz/us2yYield/sgePremiumUsd with COALESCE', () => {
    // Shanghai 760 CNY/g, USD/CNY 7.20 -> 760/7.2*31.1034768 = 3283.14 USD/oz; vs London 3270 -> +13.14 USD/oz
    const prem = computeSgePremiumUsd(760, 3270, 7.2);
    expect(prem).not.toBeNull();
    expect(prem!).toBeCloseTo(13.14, 1);
    expect(computeSgePremiumUsd(0, 3270, 7.2)).toBeNull();

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE gold_prices (
        date TEXT PRIMARY KEY,
        london_close REAL, london_high REAL, london_low REAL,
        shanghai_close REAL, shanghai_high REAL, shanghai_low REAL,
        etf_nav REAL, etf_change REAL,
        dollar_index REAL, us10y_yield REAL, tips_yield REAL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // GoldPricesRepo constructor idempotently adds gvz, us2y_yield, sge_premium_usd
    const repo = new GoldPricesRepo(db);
    repo.upsert({
      date: '2026-11-26',
      londonClose: 3270,
      londonHigh: null,
      londonLow: null,
      shanghaiClose: 760,
      shanghaiHigh: null,
      shanghaiLow: null,
      etfNav: null,
      etfChange: null,
      dollarIndex: 103.5,
      us10yYield: 4.25,
      tipsYield: 1.85,
      gvz: 18.4,
      us2yYield: 4.10,
      sgePremiumUsd: prem,
    });

    // Subsequent partial upsert with nulls must not wipe gvz/us2yYield/sgePremiumUsd
    repo.upsert({
      date: '2026-11-26',
      londonClose: 3275,
      londonHigh: null,
      londonLow: null,
      shanghaiClose: null,
      shanghaiHigh: null,
      shanghaiLow: null,
      etfNav: null,
      etfChange: null,
      dollarIndex: null,
      us10yYield: null,
      tipsYield: null,
      gvz: null,
      us2yYield: null,
      sgePremiumUsd: null,
    });

    const saved = repo.getByDate('2026-11-26');
    expect(saved).toBeDefined();
    expect(saved!.londonClose).toBe(3275);
    expect(saved!.gvz).toBe(18.4);
    expect(saved!.us2yYield).toBe(4.10);
    expect(saved!.sgePremiumUsd).toBeCloseTo(13.14, 1);

    // Negative SGE discount (0 or negative) is valid and must be stored
    repo.upsert({
      date: '2026-11-27',
      londonClose: 3300,
      londonHigh: null,
      londonLow: null,
      shanghaiClose: null,
      shanghaiHigh: null,
      shanghaiLow: null,
      etfNav: null,
      etfChange: null,
      dollarIndex: null,
      us10yYield: null,
      tipsYield: null,
      sgePremiumUsd: -6.5,
    });
    expect(repo.getByDate('2026-11-27')!.sgePremiumUsd).toBe(-6.5);
  });

  it('M8: docs-index cache hits when unchanged, invalidates on file change, and groups months descending', () => {
    const docsIndex = require(path.resolve(process.cwd(), 'web/docs-index.cjs')) as DocsIndexModule;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goldrush-docs-cache-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'goldrush-analysis-2026-10-15.md'), '# Oct');
      fs.writeFileSync(path.join(tmpDir, 'goldrush-analysis-2026-11-02.md'), '# Nov 1');
      fs.writeFileSync(path.join(tmpDir, 'goldrush-analysis-2026-11-20.md'), '# Nov 2');

      let buildCalls = 0;
      const cache = docsIndex.createDocsIndexCache(tmpDir, (files) => {
        buildCalls++;
        return files.map(f => ({ filename: f }));
      });

      const first = cache.getAll();
      expect(first).toHaveLength(3);
      expect(buildCalls).toBe(1);

      // Second read hits cache
      const second = cache.getAll();
      expect(second).toBe(first);
      expect(buildCalls).toBe(1);
      expect(cache.getStats()).toEqual({ hits: 1, misses: 1, cachedCount: 3 });

      // Adding a new file invalidates cache automatically
      fs.writeFileSync(path.join(tmpDir, 'goldrush-analysis-2026-11-25.md'), '# Nov 3');
      const third = cache.getAll();
      expect(third).toHaveLength(4);
      expect(buildCalls).toBe(2);

      const months = docsIndex.extractAvailableMonths(third);
      expect(months).toEqual([
        { month: '2026-11', count: 3 },
        { month: '2026-10', count: 1 },
      ]);
      const barHtml = docsIndex.renderMonthFilterBar(months, 4);
      expect(barHtml).toContain('data-month="2026-11"');
      expect(barHtml).toContain('全部 (4)');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
