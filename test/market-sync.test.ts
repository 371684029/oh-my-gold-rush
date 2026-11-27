import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface SnapshotRow {
  date: string;
  londonClose: number;
  londonHigh?: number;
  londonLow?: number;
  shanghaiClose?: number;
  usdCny?: number;
  dxy?: number;
  us10y?: number;
  tips?: number;
  gldClose?: number;
  gldVol?: number;
  cftcNet?: number;
  cftcPct?: number;
  macroObsDate?: string;
  cftcObsDate?: string;
  source?: string;
}

interface SyncMeta {
  schemaVersion: number;
  dateRange: { from: string | null; to: string | null };
  tradingDays: number;
  sources: Record<string, string>;
  liveQuotes: {
    xauUsd: number | null;
    shanghaiCny: number | null;
    usdCny: number | null;
  };
  obsDates: Record<string, string | null>;
}

const marketSync = require('../web/market-sync.cjs') as {
  readMarketSnapshot: (docsDir: string) => SnapshotRow[];
  readSyncMeta: (docsDir: string) => SyncMeta | null;
  writeMarketSnapshot: (docsDir: string, rows: SnapshotRow[], meta?: SyncMeta) => SnapshotRow[];
  persistRowsToSqlite: (rows: SnapshotRow[], cftcWeekly: unknown[], dbPath: string) => void;
  ensureSqliteHydrated: (docsDir: string, dbPath: string) => { hydrated: boolean; count: number };
  parseSinaQuoteLine: (line: string) => { price: number; prev: number } | null;
};

describe('web/market-sync (5-year persistence, COALESCE protection & Git snapshot)', () => {
  it('round-trips JSONL snapshots atomically and filters out invalid/zero prices', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goldrush-sync-'));
    try {
      const rows: SnapshotRow[] = [
        { date: '2026-11-25', londonClose: 3535.8, tips: 2.79, dxy: 103.67, usdCny: 6.6623 },
        { date: '2026-11-24', londonClose: 3561.9, shanghaiClose: 763.2, tips: 2.79 },
        { date: '2026-11-26', londonClose: 0 }, // 无效 0 价必须过滤
      ];
      marketSync.writeMarketSnapshot(tmpDir, rows, {
        schemaVersion: 1,
        dateRange: { from: '2026-11-24', to: '2026-11-25' },
        tradingDays: 2,
        sources: { yahooGold: 'ok' },
        liveQuotes: { xauUsd: 3535.8, shanghaiCny: 763.2, usdCny: 6.6623 },
        obsDates: { gold: '2026-11-25' },
      });

      const loaded = marketSync.readMarketSnapshot(tmpDir);
      expect(loaded.length).toBe(2);
      expect(loaded[0]!.date).toBe('2026-11-24');
      expect(loaded[1]!.date).toBe('2026-11-25');
      expect(loaded[0]!.shanghaiClose).toBe(763.2);

      const meta = marketSync.readSyncMeta(tmpDir);
      expect(meta?.tradingDays).toBe(2);
      expect(meta?.dateRange.to).toBe('2026-11-25');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('hydrates an empty SQLite DB from Git JSONL and protects valid columns via COALESCE', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goldrush-db-'));
    const dbPath = path.join(tmpDir, 'test.db');
    try {
      marketSync.writeMarketSnapshot(tmpDir, [
        { date: '2026-11-25', londonClose: 3535.8, shanghaiClose: 762.5, dxy: 103.67, tips: 2.79 },
        { date: '2026-11-26', londonClose: 3565.6, shanghaiClose: 765.89, dxy: 103.81, tips: 2.79 },
      ]);

      const hyd = marketSync.ensureSqliteHydrated(tmpDir, dbPath);
      expect(hyd.hydrated).toBe(true);
      expect(hyd.count).toBe(2);

      // 再次写入缺失 shanghaiClose 与 0 价 TIPS 时，不得覆盖已有有效值
      marketSync.persistRowsToSqlite(
        [{ date: '2026-11-26', londonClose: 3570.0, shanghaiClose: 0, tips: 0 }],
        [],
        dbPath,
      );

      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT london_close, shanghai_close, tips_yield FROM gold_prices WHERE date = ?').get('2026-11-26') as {
        london_close: number;
        shanghai_close: number;
        tips_yield: number;
      };
      db.close();

      expect(row.london_close).toBe(3570.0);
      expect(row.shanghai_close).toBe(765.89); // COALESCE 保护生效
      expect(row.tips_yield).toBe(2.79); // 0 不会被写入覆盖
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('parses Sina live quotes for Shanghai Au99.99, London hf_GC, and FX', () => {
    const au = marketSync.parseSinaQuoteLine('var hq_str_gds_AU9999="765.89,0,764.10,765.50,768.00,761.00,14:55:00,763.50,764.00";');
    expect(au).not.toBeNull();
    expect(au!.price).toBeCloseTo(765.89, 2);

    const fx = marketSync.parseSinaQuoteLine('var hq_str_fx_susdcny="14:56:00,6.6627,6.6630,6.6625,10,6.6600,6.6650,6.6590,6.6610";');
    expect(fx).not.toBeNull();
    expect(fx!.price).toBeCloseTo(6.6627, 4);

    expect(marketSync.parseSinaQuoteLine('var hq_str_empty="";')).toBeNull();
  });

  it('verifies the Git-tracked 5-year snapshot in docs/market-data/ is populated and clean', () => {
    const docsDir = path.resolve(process.cwd(), 'docs');
    const rows = marketSync.readMarketSnapshot(docsDir);
    const meta = marketSync.readSyncMeta(docsDir);

    expect(rows.length).toBeGreaterThanOrEqual(1200);
    expect(meta).not.toBeNull();
    expect(meta!.dateRange.to! >= '2026-11-26').toBe(true);
    expect(meta!.liveQuotes.xauUsd).toBeGreaterThan(2000);
    expect(meta!.liveQuotes.shanghaiCny).toBeGreaterThan(500);

    // 校验所有行价格合法且满足 OHLC 约束
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      expect(r.londonClose).toBeGreaterThan(1000);
      if (r.londonHigh != null) expect(r.londonHigh).toBeGreaterThanOrEqual(r.londonClose - 0.01);
      if (r.londonLow != null) expect(r.londonLow).toBeLessThanOrEqual(r.londonClose + 0.01);
      if (i > 0) expect(r.date > rows[i - 1]!.date).toBe(true);
    }

    // 最近一天应含宏观与 CFTC 数据
    const latest = rows[rows.length - 1]!;
    expect(latest.tips).not.toBeUndefined();
    expect(latest.us10y).not.toBeUndefined();
    expect(latest.dxy).not.toBeUndefined();
    expect(latest.cftcPct).not.toBeUndefined();
  });
});
