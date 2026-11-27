// 金价快照 CRUD
import Database from 'better-sqlite3';
import type { GoldPriceRecord } from '../types/market.js';
import { addCalendarDays, todayDate } from '../utils/time.js';

/** 金衡盎司换算克数常数 */
export const TROY_OZ_TO_GRAM = 31.1034768;

/** 计算上海金 Au99.99 (CNY/g) 相对伦敦金 (USD/oz) 的美元溢价（可正可负） */
export function computeSgePremiumUsd(
  shanghaiCnyPerGram: number | null | undefined,
  londonUsdPerOz: number | null | undefined,
  usdCny: number | null | undefined,
): number | null {
  if (
    shanghaiCnyPerGram == null || !Number.isFinite(shanghaiCnyPerGram) || shanghaiCnyPerGram <= 0
    || londonUsdPerOz == null || !Number.isFinite(londonUsdPerOz) || londonUsdPerOz <= 0
    || usdCny == null || !Number.isFinite(usdCny) || usdCny <= 0
  ) {
    return null;
  }
  const shanghaiUsdPerOz = (shanghaiCnyPerGram / usdCny) * TROY_OZ_TO_GRAM;
  return Math.round((shanghaiUsdPerOz - londonUsdPerOz) * 100) / 100;
}

export class GoldPricesRepo {
  constructor(private db: Database.Database) {
    // 幂等补齐 v2.6 扩展列，兼容未经过 initDatabase 的旧库或测试内存库
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(gold_prices)').all() as Array<{ name: string }>).map(c => c.name),
    );
    if (cols.size > 0) {
      if (!cols.has('gvz')) this.db.exec('ALTER TABLE gold_prices ADD COLUMN gvz REAL');
      if (!cols.has('us2y_yield')) this.db.exec('ALTER TABLE gold_prices ADD COLUMN us2y_yield REAL');
      if (!cols.has('sge_premium_usd')) this.db.exec('ALTER TABLE gold_prices ADD COLUMN sge_premium_usd REAL');
    }
  }

  /** 将 ≤0 视为缺失，避免 0 或负数覆盖有效历史价 */
  private static sanitize(v: number | null | undefined): number | null {
    if (v == null || !Number.isFinite(v) || v <= 0) return null;
    return v;
  }

  /** 允许正负或 0 的有符号数值（如上海金溢价） */
  private static sanitizeSigned(v: number | null | undefined): number | null {
    if (v == null || !Number.isFinite(v)) return null;
    return v;
  }

  /** 插入或更新当日金价快照（0/无效值不覆盖已有有效列） */
  upsert(record: Omit<GoldPriceRecord, 'createdAt'>): void {
    const londonClose = GoldPricesRepo.sanitize(record.londonClose);
    const londonHigh = GoldPricesRepo.sanitize(record.londonHigh);
    const londonLow = GoldPricesRepo.sanitize(record.londonLow);
    const shanghaiClose = GoldPricesRepo.sanitize(record.shanghaiClose);
    const shanghaiHigh = GoldPricesRepo.sanitize(record.shanghaiHigh);
    const shanghaiLow = GoldPricesRepo.sanitize(record.shanghaiLow);
    const etfNav = GoldPricesRepo.sanitize(record.etfNav);
    const dollarIndex = GoldPricesRepo.sanitize(record.dollarIndex);
    const us10yYield = GoldPricesRepo.sanitize(record.us10yYield);
    // tips 可为负，仅拒绝恰好 0 / 非有限
    const tipsYield = record.tipsYield != null && Number.isFinite(record.tipsYield) && record.tipsYield !== 0
      ? record.tipsYield
      : null;
    const gvz = GoldPricesRepo.sanitize(record.gvz);
    const us2yYield = GoldPricesRepo.sanitize(record.us2yYield);
    const sgePremiumUsd = GoldPricesRepo.sanitizeSigned(record.sgePremiumUsd);

    this.db.prepare(`
      INSERT INTO gold_prices (date, london_close, london_high, london_low,
        shanghai_close, shanghai_high, shanghai_low, etf_nav, etf_change,
        dollar_index, us10y_yield, tips_yield, gvz, us2y_yield, sge_premium_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        london_close = COALESCE(excluded.london_close, gold_prices.london_close),
        london_high = COALESCE(excluded.london_high, gold_prices.london_high),
        london_low = COALESCE(excluded.london_low, gold_prices.london_low),
        shanghai_close = COALESCE(excluded.shanghai_close, gold_prices.shanghai_close),
        shanghai_high = COALESCE(excluded.shanghai_high, gold_prices.shanghai_high),
        shanghai_low = COALESCE(excluded.shanghai_low, gold_prices.shanghai_low),
        etf_nav = COALESCE(excluded.etf_nav, gold_prices.etf_nav),
        etf_change = COALESCE(excluded.etf_change, gold_prices.etf_change),
        dollar_index = COALESCE(excluded.dollar_index, gold_prices.dollar_index),
        us10y_yield = COALESCE(excluded.us10y_yield, gold_prices.us10y_yield),
        tips_yield = COALESCE(excluded.tips_yield, gold_prices.tips_yield),
        gvz = COALESCE(excluded.gvz, gold_prices.gvz),
        us2y_yield = COALESCE(excluded.us2y_yield, gold_prices.us2y_yield),
        sge_premium_usd = COALESCE(excluded.sge_premium_usd, gold_prices.sge_premium_usd)
    `).run(
      record.date, londonClose, londonHigh, londonLow,
      shanghaiClose, shanghaiHigh, shanghaiLow,
      etfNav, record.etfChange ?? null, dollarIndex,
      us10yYield, tipsYield, gvz, us2yYield, sgePremiumUsd,
    );
  }

  /**
   * 历史回填：仅填充 NULL 字段，不覆盖已有实时采集数据。
   * 与 upsert 一样走 sanitize —— 否则 LLM/CSV 回填可以把 0 或负数写进库，
   * 而日常 upsert 的 COALESCE 又挡不住「首次写入就是脏值」。
   */
  upsertBackfill(record: Omit<GoldPriceRecord, 'createdAt'>): void {
    const londonClose = GoldPricesRepo.sanitize(record.londonClose);
    const londonHigh = GoldPricesRepo.sanitize(record.londonHigh);
    const londonLow = GoldPricesRepo.sanitize(record.londonLow);
    const shanghaiClose = GoldPricesRepo.sanitize(record.shanghaiClose);
    const shanghaiHigh = GoldPricesRepo.sanitize(record.shanghaiHigh);
    const shanghaiLow = GoldPricesRepo.sanitize(record.shanghaiLow);
    const etfNav = GoldPricesRepo.sanitize(record.etfNav);
    const dollarIndex = GoldPricesRepo.sanitize(record.dollarIndex);
    const us10yYield = GoldPricesRepo.sanitize(record.us10yYield);
    const tipsYield = record.tipsYield != null && Number.isFinite(record.tipsYield) && record.tipsYield !== 0
      ? record.tipsYield
      : null;
    const gvz = GoldPricesRepo.sanitize(record.gvz);
    const us2yYield = GoldPricesRepo.sanitize(record.us2yYield);
    const sgePremiumUsd = GoldPricesRepo.sanitizeSigned(record.sgePremiumUsd);

    this.db.prepare(`
      INSERT INTO gold_prices (date, london_close, london_high, london_low,
        shanghai_close, shanghai_high, shanghai_low, etf_nav, etf_change,
        dollar_index, us10y_yield, tips_yield, gvz, us2y_yield, sge_premium_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        london_close = COALESCE(gold_prices.london_close, excluded.london_close),
        london_high = COALESCE(gold_prices.london_high, excluded.london_high),
        london_low = COALESCE(gold_prices.london_low, excluded.london_low),
        shanghai_close = COALESCE(gold_prices.shanghai_close, excluded.shanghai_close),
        shanghai_high = COALESCE(gold_prices.shanghai_high, excluded.shanghai_high),
        shanghai_low = COALESCE(gold_prices.shanghai_low, excluded.shanghai_low),
        etf_nav = COALESCE(gold_prices.etf_nav, excluded.etf_nav),
        etf_change = COALESCE(gold_prices.etf_change, excluded.etf_change),
        dollar_index = COALESCE(gold_prices.dollar_index, excluded.dollar_index),
        us10y_yield = COALESCE(gold_prices.us10y_yield, excluded.us10y_yield),
        tips_yield = COALESCE(gold_prices.tips_yield, excluded.tips_yield),
        gvz = COALESCE(gold_prices.gvz, excluded.gvz),
        us2y_yield = COALESCE(gold_prices.us2y_yield, excluded.us2y_yield),
        sge_premium_usd = COALESCE(gold_prices.sge_premium_usd, excluded.sge_premium_usd)
    `).run(
      record.date, londonClose, londonHigh, londonLow,
      shanghaiClose, shanghaiHigh, shanghaiLow,
      etfNav, record.etfChange ?? null, dollarIndex,
      us10yYield, tipsYield, gvz, us2yYield, sgePremiumUsd,
    );
  }

  /** 获取指定日期金价 */
  getByDate(date: string): GoldPriceRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM gold_prices WHERE date = ?`).get(date) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : undefined;
  }

  /** 获取最近 N 个日历日窗口内的金价（按上海日历截止日） */
  getRecent(days: number, asOf: string = todayDate()): GoldPriceRecord[] {
    const from = addCalendarDays(asOf, -(days - 1));
    return this.getRange(from, asOf);
  }

  /** 获取指定日期区间的金价 */
  getRange(from: string, to: string): GoldPriceRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM gold_prices
      WHERE date >= ? AND date <= ?
      ORDER BY date ASC
    `).all(from, to) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  /** 获取指定日期之后的金价（用于回测） */
  getAfter(date: string, limit: number = 30): GoldPriceRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM gold_prices
      WHERE date > ?
      ORDER BY date ASC
      LIMIT ?
    `).all(date, limit) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  /** 获取总记录数 */
  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM gold_prices`).get() as { cnt: number };
    return row.cnt;
  }
}

/** 读库时把历史脏数据 0 当成 NULL（tips 允许负） */
function mapNum(v: unknown, allowNegative = false): number | null {
  if (v == null || typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v === 0) return null;
  if (!allowNegative && v < 0) return null;
  return v;
}

function mapSignedNum(v: unknown): number | null {
  if (v == null || typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

function mapRow(row: Record<string, unknown>): GoldPriceRecord {
  return {
    date: row.date as string,
    londonClose: mapNum(row.london_close),
    londonHigh: mapNum(row.london_high),
    londonLow: mapNum(row.london_low),
    shanghaiClose: mapNum(row.shanghai_close),
    shanghaiHigh: mapNum(row.shanghai_high),
    shanghaiLow: mapNum(row.shanghai_low),
    etfNav: mapNum(row.etf_nav),
    etfChange: row.etf_change as number | null,
    dollarIndex: mapNum(row.dollar_index),
    us10yYield: mapNum(row.us10y_yield),
    tipsYield: mapNum(row.tips_yield, true),
    gvz: mapNum(row.gvz),
    us2yYield: mapNum(row.us2y_yield),
    sgePremiumUsd: mapSignedNum(row.sge_premium_usd),
    createdAt: row.created_at as string,
  };
}
