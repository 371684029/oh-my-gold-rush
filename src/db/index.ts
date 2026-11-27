// SQLite 数据库初始化
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { getConfig } from '../utils/config.js';

let db: Database.Database | null = null;

/** 获取数据库实例（单例） */
export function getDb(dbPath?: string): Database.Database {
  if (db) return db;

  const resolvedPath = dbPath ?? path.resolve(process.cwd(), getConfig().database.path);

  // 确保数据目录存在
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initializeTables(db);
  return db;
}

/** 关闭数据库 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** 初始化所有表 */
function initializeTables(db: Database.Database): void {
  const goldPricesDDL = `
    CREATE TABLE IF NOT EXISTS gold_prices (
      date          TEXT PRIMARY KEY,
      london_close  REAL,
      london_high   REAL,
      london_low    REAL,
      shanghai_close REAL,
      shanghai_high  REAL,
      shanghai_low   REAL,
      etf_nav       REAL,
      etf_change    REAL,
      dollar_index  REAL,
      us10y_yield   REAL,
      tips_yield    REAL,
      created_at    TEXT DEFAULT (datetime('now'))
    )
  `;

  const fundNavDDL = `
    CREATE TABLE IF NOT EXISTS fund_nav (
      date        TEXT NOT NULL,
      code        TEXT NOT NULL,
      nav         REAL,
      acc_nav     REAL,
      change_pct  REAL,
      premium     REAL,
      created_at  TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (date, code)
    )
  `;

  const analysisReportsDDL = `
    CREATE TABLE IF NOT EXISTS analysis_reports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT,
      horizon     TEXT,
      report_json TEXT,
      overall_score INTEGER,
      quant_score REAL,
      mid_term_score REAL,
      direction   TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    )
  `;

  const scenarioFeaturesDDL = `
    CREATE TABLE IF NOT EXISTS scenario_features (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT,
      report_id   INTEGER,
      dollar_direction    TEXT,
      dollar_magnitude    REAL,
      tips_direction      TEXT,
      tips_magnitude      REAL,
      gold_deviation      REAL,
      vix_level           REAL,
      fed_stance          TEXT,
      geopolitical_risk   TEXT,
      momentum_direction  TEXT,
      consecutive_days    INTEGER,
      cftc_percentile     REAL,
      etf_flow_5d         REAL,
      flow_score          REAL,
      actual_5d_return     REAL,
      actual_5d_direction  TEXT,
      actual_20d_return   REAL,
      backfill_status     TEXT DEFAULT 'pending',
      created_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (report_id) REFERENCES analysis_reports(id)
    )
  `;

  const searchCacheDDL = `
    CREATE TABLE IF NOT EXISTS search_cache (
      query_hash  TEXT PRIMARY KEY,
      query       TEXT,
      engine      TEXT,
      results     TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      expires_at  TEXT
    )
  `;

  const institutionalFlowsDDL = `
    CREATE TABLE IF NOT EXISTS institutional_flows (
      date TEXT PRIMARY KEY,
      cftc_nc_long REAL,
      cftc_nc_short REAL,
      cftc_nc_net REAL,
      cftc_nc_change REAL,
      cftc_comm_net REAL,
      cftc_open_interest REAL,
      cftc_report_date TEXT,
      gld_holdings_tons REAL,
      gld_holdings_change REAL,
      gld_aum_million REAL,
      iau_holdings_tons REAL,
      cn_etf_518880_shares REAL,
      cn_etf_518880_flow REAL,
      cn_etf_159934_shares REAL,
      cn_etf_159934_flow REAL,
      cb_pboc_reserves REAL,
      cb_pboc_change REAL,
      comex_volume REAL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `;

  db.exec(goldPricesDDL);
  // v2.6 幂等迁移：补齐黄金隐含波动率 GVZ、美债 2Y 收益率、上海金相对伦敦金美元溢价
  try { db.exec('ALTER TABLE gold_prices ADD COLUMN gvz REAL'); } catch { /* 列已存在则忽略 */ }
  try { db.exec('ALTER TABLE gold_prices ADD COLUMN us2y_yield REAL'); } catch { /* 列已存在则忽略 */ }
  try { db.exec('ALTER TABLE gold_prices ADD COLUMN sge_premium_usd REAL'); } catch { /* 列已存在则忽略 */ }
  db.exec(fundNavDDL);
  db.exec(analysisReportsDDL);

  // 迁移：为旧数据库添加 quant_score 列（幂等，列已存在时忽略错误）
  try {
    db.exec('ALTER TABLE analysis_reports ADD COLUMN quant_score REAL');
  } catch { /* 列已存在则忽略 */ }

  // 迁移：中期（1～3 个月）方向分，命中标签为 20 个交易日，与 5 日短期分分轨统计
  try {
    db.exec('ALTER TABLE analysis_reports ADD COLUMN mid_term_score REAL');
  } catch { /* 列已存在则忽略 */ }

  db.exec(scenarioFeaturesDDL);

  // 迁移：为旧 scenario_features 表添加主力相关列（幂等）
  try { db.exec('ALTER TABLE scenario_features ADD COLUMN cftc_percentile REAL'); } catch { /* ok */ }
  try { db.exec('ALTER TABLE scenario_features ADD COLUMN etf_flow_5d REAL'); } catch { /* ok */ }
  try { db.exec('ALTER TABLE scenario_features ADD COLUMN flow_score REAL'); } catch { /* ok */ }

  db.exec(searchCacheDDL);
  db.exec(institutionalFlowsDDL);

  // 创建索引
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_date ON analysis_reports(date)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_score ON analysis_reports(overall_score)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_features_date ON scenario_features(date)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_features_backfill ON scenario_features(backfill_status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cache_expires ON search_cache(expires_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_flows_cftc ON institutional_flows(cftc_report_date)`);
}
