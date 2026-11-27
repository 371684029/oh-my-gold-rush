'use strict';

// GoldRush 5年日线 + 实时多源同步引擎（零 LLM 直连 + 本地 SQLite 与 Git JSONL 双向持久化）
// 外部请求地址严格限定为固定官方白名单域名，所有 SQLite 写入使用参数化预编译语句与 COALESCE 保护。

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { getGlobalCircuitBreaker } = require('./source-circuit-breaker.cjs');

const USER_AGENT = 'GoldRush/2.6 (gold research engine)';
const SNAPSHOT_DIR_REL = 'market-data';
const JSONL_FILENAME = 'gold-daily-5y.jsonl';
const MONTHLY_JSONL_FILENAME = 'gold-monthly-25y.jsonl';
const META_FILENAME = 'sync-meta.json';
const DEFAULT_DB_REL = path.join('data', 'goldrush.db');
const MANUAL_COOLDOWN_MS = 30_000;
const STALE_AUTO_SYNC_MS = 30 * 60_000;

const ALLOWED_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'fred.stlouisfed.org',
  'api.gold-api.com',
  'hq.sinajs.cn',
  'publicreporting.cftc.gov',
]);

let _inFlightSync = null;
let _lastManualSyncAt = 0;

function round(v, digits = 2) {
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}

function isValidPos(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** F06: 有符号利率校验（允许 TIPS/利率精确等于 0.00%，区别于正价格校验） */
function isValidFiniteRate(v, min = -5, max = 15) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

/** F15: 期现基差比例复权辅助函数 — 消除 GC=F 期货连续合约与伦敦现货 XAU/USD 拼接处的展期升水跳空 */
function reconcileSpotFuturesBasis(rows, spotPrice, futuresPrice) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  if (!isValidPos(spotPrice) || !isValidPos(futuresPrice)) return rows;
  const ratio = spotPrice / futuresPrice;
  // 合理期现基差范围 ±4%，超出视为数据异常不做缩放
  if (!Number.isFinite(ratio) || ratio < 0.96 || ratio > 1.04 || Math.abs(ratio - 1) < 0.0005) {
    return rows;
  }
  return rows.map(r => {
    if (!r || !isValidPos(r.londonClose)) return r;
    if (r.source === 'gold_api_live' || r.source === 'report_md' || r.basisAdjusted) return r;
    return {
      ...r,
      londonClose: round(r.londonClose * ratio, 2),
      ...(isValidPos(r.londonHigh) ? { londonHigh: round(r.londonHigh * ratio, 2) } : {}),
      ...(isValidPos(r.londonLow) ? { londonLow: round(r.londonLow * ratio, 2) } : {}),
      basisAdjusted: true,
    };
  });
}

function todayShanghaiDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function yearsAgoDate(years = 5) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function assertAllowedUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Blocked non-allowlisted outbound host: ${parsed.hostname}`);
  }
  return parsed.toString();
}

function sourceKeyFromUrl(rawUrl) {
  try {
    const h = new URL(rawUrl).hostname;
    if (h.includes('yahoo')) return 'yahoo';
    if (h.includes('fred')) return 'fred';
    if (h.includes('gold-api')) return 'gold_api';
    if (h.includes('sinajs')) return 'sina';
    if (h.includes('cftc')) return 'cftc';
    return h;
  } catch {
    return 'unknown';
  }
}

async function fetchJsonSafe(rawUrl, timeoutMs = 12_000, extraHeaders = {}) {
  const breaker = getGlobalCircuitBreaker();
  const srcKey = sourceKeyFromUrl(rawUrl);
  const { value } = await breaker.execute(srcKey, async () => {
    const safeUrl = assertAllowedUrl(rawUrl);
    const res = await fetch(safeUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json,*/*', ...extraHeaders },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  });
  return value;
}

async function fetchTextSafe(rawUrl, timeoutMs = 15_000, extraHeaders = {}, encoding = 'utf8') {
  const breaker = getGlobalCircuitBreaker();
  const srcKey = sourceKeyFromUrl(rawUrl);
  const { value } = await breaker.execute(srcKey, async () => {
    const safeUrl = assertAllowedUrl(rawUrl);
    const res = await fetch(safeUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/csv,text/plain,*/*', ...extraHeaders },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString(encoding);
  });
  return value;
}

function getSourceHealth() {
  return getGlobalCircuitBreaker().getHealthSnapshot();
}

function yahooTsToNyDate(ts) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts * 1000));
}

/** 拉取 Yahoo Finance 日线序列（GC=F / DX-Y.NYB / ^TNX / GLD / CNY=X） */
async function fetchYahooDaily(symbol, range = '5y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${encodeURIComponent(range)}`;
  const body = await fetchJsonSafe(url, 15_000);
  const result = body?.chart?.result?.[0];
  if (!result?.timestamp?.length) return new Map();

  const ts = result.timestamp;
  const q = result.indicators?.quote?.[0] || {};
  const closes = q.close || [];
  const highs = q.high || [];
  const lows = q.low || [];
  const vols = q.volume || [];

  const map = new Map();
  for (let i = 0; i < ts.length; i++) {
    const close = closes[i];
    if (!isValidPos(close)) continue;
    const date = yahooTsToNyDate(ts[i]);
    map.set(date, {
      date,
      close: round(close, symbol === 'CNY=X' ? 4 : 2),
      high: isValidPos(highs[i]) ? round(highs[i], 2) : null,
      low: isValidPos(lows[i]) ? round(lows[i], 2) : null,
      volume: isValidPos(vols[i]) ? Math.round(vols[i]) : null,
    });
  }
  return map;
}

/** 拉取 FRED 官方日线 CSV（严格保留真实观测日期，禁止用当前时间覆盖） */
async function fetchFredSeries(seriesId, sinceDate) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const text = await fetchTextSafe(url, 16_000);
  if (!text || text.includes('<html') || text.includes('error')) return { map: new Map(), latestDate: null };

  const map = new Map();
  let latestDate = null;
  const lines = text.trim().split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const [rawDate, rawVal] = lines[i].split(',');
    if (!rawDate || !rawVal || rawVal === '.') continue;
    const date = rawDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const val = parseFloat(rawVal);
    if (!Number.isFinite(val)) continue;
    // F06: DFII10（10Y TIPS 实际利率）可正可负且可精确等于 0.00%，仅拒绝越界异常值
    if (seriesId === 'DFII10') {
      if (!isValidFiniteRate(val, -5, 15)) continue;
    } else if (seriesId === 'FEDFUNDS' || seriesId === 'DGS2' || seriesId === 'DGS10') {
      if (!isValidFiniteRate(val, 0, 25)) continue;
    } else if (val <= 0) {
      continue;
    }
    if (!sinceDate || date >= sinceDate) {
      map.set(date, round(val, 4));
      latestDate = date;
    }
  }
  return { map, latestDate };
}

/** 拉取 Yahoo Finance 日线分段并聚合为连续月末金价（规避 1mo 合约换月缺口，2000-09 至今零缺失） */
async function fetchYahooGoldMonthlyFull() {
  const nowSec = Math.floor(Date.now() / 1000) + 86400;
  const splitSec = Math.floor(Date.parse('2014-01-01T00:00:00Z') / 1000);
  const startSec = Math.floor(Date.parse('2000-09-01T00:00:00Z') / 1000);

  const fetchChunk = async (p1, p2) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&period1=${p1}&period2=${p2}`;
    const body = await fetchJsonSafe(url, 18_000);
    const result = body?.chart?.result?.[0];
    if (!result?.timestamp?.length) return [];
    const ts = result.timestamp;
    const q = result.indicators?.quote?.[0] || {};
    const closes = q.close || [];
    const highs = q.high || [];
    const lows = q.low || [];
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (!isValidPos(c)) continue;
      out.push({
        date: yahooTsToNyDate(ts[i]),
        close: round(c, 2),
        high: isValidPos(highs[i]) ? round(highs[i], 2) : round(c, 2),
        low: isValidPos(lows[i]) ? round(lows[i], 2) : round(c, 2),
      });
    }
    return out;
  };

  const [c1, c2] = await Promise.all([
    fetchChunk(startSec, splitSec),
    fetchChunk(splitSec, nowSec),
  ]);
  const all = c1.concat(c2);
  const byYm = new Map();
  for (const bar of all) {
    const ym = bar.date.slice(0, 7);
    const prev = byYm.get(ym);
    if (!prev) {
      byYm.set(ym, {
        ym,
        date: bar.date,
        londonClose: bar.close,
        londonHigh: Math.max(bar.high, bar.close),
        londonLow: Math.min(bar.low, bar.close),
      });
    } else {
      prev.londonHigh = round(Math.max(prev.londonHigh, bar.high, bar.close), 2);
      prev.londonLow = round(Math.min(prev.londonLow, bar.low, bar.close), 2);
      if (bar.date >= prev.date) {
        prev.date = bar.date;
        prev.londonClose = bar.close;
      }
    }
  }
  return byYm;
}

/** 拉取 Yahoo Finance 月线序列（period1/period2 精确覆盖，用于 DXY 26 年无缺口月线） */
async function fetchYahooMonthlyRange(symbol, startIso = '2000-01-01T00:00:00Z') {
  const p1 = Math.floor(Date.parse(startIso) / 1000);
  const p2 = Math.floor(Date.now() / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1mo&period1=${p1}&period2=${p2}`;
  const body = await fetchJsonSafe(url, 15_000);
  const result = body?.chart?.result?.[0];
  if (!result?.timestamp?.length) return new Map();

  const ts = result.timestamp;
  const closes = result.indicators?.quote?.[0]?.close || [];
  const map = new Map();
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (!isValidPos(c)) continue;
    const ym = new Date(ts[i] * 1000).toISOString().slice(0, 7);
    map.set(ym, round(c, symbol === 'CNY=X' ? 4 : 2));
  }
  return map;
}

/** 将 FRED 官方 CSV 按自然月聚合成月末值（严格保留真实观测日期 obsDate） */
async function fetchFredMonthly(seriesId, sinceYm = '1999-01') {
  const { map: dailyMap, latestDate } = await fetchFredSeries(seriesId, sinceYm + '-01');
  const byYm = new Map();
  for (const [date, val] of dailyMap.entries()) {
    const ym = date.slice(0, 7);
    const prev = byYm.get(ym);
    if (!prev || date >= prev.obsDate) {
      byYm.set(ym, { obsDate: date, val });
    }
  }
  return { byYm, latestDate };
}

/** 解析新浪行情快照行（与 src/data/live-anchors.ts 同口径） */
function parseSinaQuoteLine(text) {
  const m = text.match(/="([^"]*)"/);
  if (!m?.[1]) return null;
  const parts = m[1].split(',');
  const i = /^\d{2}:\d{2}:\d{2}$/.test(parts[0]) ? 1 : 0;
  const first = parseFloat(parts[i]);
  if (Number.isFinite(first) && first > 0) {
    const prev = parseFloat(parts[i + 7] || parts[i + 8] || '') || first;
    return { price: first, prev };
  }
  const price = parseFloat(parts[i + 3]);
  if (!Number.isFinite(price) || price <= 0) return null;
  const prev = parseFloat(parts[i + 2]) || price;
  return { price, prev };
}

async function fetchSinaLive(symbol) {
  const url = `https://hq.sinajs.cn/list=${encodeURIComponent(symbol)}`;
  const text = await fetchTextSafe(url, 8_000, { Referer: 'https://finance.sina.com.cn' }, 'latin1');
  if (!text) return null;
  const q = parseSinaQuoteLine(text);
  if (!q) return null;
  return {
    symbol,
    price: round(q.price, symbol === 'fx_susdcny' ? 4 : 2),
    prev: round(q.prev, symbol === 'fx_susdcny' ? 4 : 2),
    updatedAt: new Date().toISOString(),
  };
}

async function fetchGoldApiSpot() {
  const body = await fetchJsonSafe('https://api.gold-api.com/price/XAU', 8_000);
  if (!body || !isValidPos(body.price)) return null;
  return {
    price: round(body.price, 2),
    updatedAt: body.updatedAt || new Date().toISOString(),
  };
}

/** 拉取 CFTC 黄金期货分类持仓周报（Socrata 公开 API，失败不阻塞主同步） */
async function fetchCftcWeekly(limit = 260) {
  // 72hh-3qpy = Disaggregated Futures Only (Managed Money Long/Short, COMEX Gold = 088691)
  const url = `https://publicreporting.cftc.gov/resource/72hh-3qpy.json?$limit=${limit}&$order=report_date_as_yyyy_mm_dd%20DESC&cftc_contract_market_code=088691`;
  const rows = await fetchJsonSafe(url, 8_000);
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const parsed = [];
  for (const r of rows) {
    const rawDate = String(r.report_date_as_yyyy_mm_dd || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) continue;
    const mmLong = parseFloat(r.m_money_positions_long_all);
    const mmShort = parseFloat(r.m_money_positions_short_all);
    const oi = parseFloat(r.open_interest_all);
    if (!Number.isFinite(mmLong) || !Number.isFinite(mmShort)) continue;
    const net = Math.round(mmLong - mmShort);
    parsed.push({
      date: rawDate,
      nonCommLong: Math.round(mmLong),
      nonCommShort: Math.round(mmShort),
      nonCommNet: net,
      openInterest: Number.isFinite(oi) ? Math.round(oi) : null,
    });
  }
  parsed.sort((a, b) => a.date.localeCompare(b.date));
  // 计算严格因果的近 3 年（156 周）净多头分位数
  for (let i = 0; i < parsed.length; i++) {
    const winStart = Math.max(0, i - 155);
    const slice = parsed.slice(winStart, i + 1).map(x => x.nonCommNet);
    const cur = parsed[i].nonCommNet;
    const le = slice.filter(v => v <= cur).length;
    parsed[i].percentile = round((le / slice.length) * 100, 1);
    parsed[i].nonCommChange = i > 0 ? cur - parsed[i - 1].nonCommNet : 0;
  }
  return parsed;
}

/** 原子写入文本文件（先写临时文件再 rename，防中途损坏） */
function atomicWriteFile(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function getSnapshotPaths(docsDir) {
  const base = path.join(docsDir, SNAPSHOT_DIR_REL);
  return {
    dir: base,
    jsonlPath: path.join(base, JSONL_FILENAME),
    monthlyJsonlPath: path.join(base, MONTHLY_JSONL_FILENAME),
    metaPath: path.join(base, META_FILENAME),
  };
}

/** 读取 Git 快照 JSONL（按日期升序，损坏行跳过） */
function readMarketSnapshot(docsDir) {
  const { jsonlPath } = getSnapshotPaths(docsDir);
  if (!fs.existsSync(jsonlPath)) return [];
  const raw = fs.readFileSync(jsonlPath, 'utf-8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.date) && isValidPos(obj.londonClose)) {
        rows.push(obj);
      }
    } catch {
      // 忽略损坏单行
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

/** 读取同步元信息 JSON */
function readSyncMeta(docsDir) {
  const { metaPath } = getSnapshotPaths(docsDir);
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch {
    return null;
  }
}

/** 写出按日一行的 Git JSONL 快照 + sync-meta.json */
function writeMarketSnapshot(docsDir, rows, meta) {
  const { jsonlPath, metaPath } = getSnapshotPaths(docsDir);
  const sorted = rows
    .filter(r => r && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && isValidPos(r.londonClose))
    .sort((a, b) => a.date.localeCompare(b.date));

  const lines = sorted.map(r => JSON.stringify({
    date: r.date,
    londonClose: round(r.londonClose, 2),
    ...(isValidPos(r.londonHigh) ? { londonHigh: round(r.londonHigh, 2) } : {}),
    ...(isValidPos(r.londonLow) ? { londonLow: round(r.londonLow, 2) } : {}),
    ...(isValidPos(r.shanghaiClose) ? { shanghaiClose: round(r.shanghaiClose, 2) } : {}),
    ...(isValidPos(r.usdCny) ? { usdCny: round(r.usdCny, 4) } : {}),
    ...(isValidPos(r.dxy) ? { dxy: round(r.dxy, 2) } : {}),
    ...(isValidPos(r.us10y) ? { us10y: round(r.us10y, 3) } : {}),
    ...(isValidFiniteRate(r.tips) ? { tips: round(r.tips, 3) } : {}),
    ...(isValidFiniteRate(r.fedFunds, 0, 25) ? { fedFunds: round(r.fedFunds, 3) } : {}),
    ...(isValidFiniteRate(r.us2y, 0, 25) ? { us2y: round(r.us2y, 3) } : {}),
    ...(isValidPos(r.gvz) ? { gvz: round(r.gvz, 2) } : {}),
    ...(isValidPos(r.vix) ? { vix: round(r.vix, 2) } : {}),
    ...(isValidPos(r.comexVol) ? { comexVol: Math.round(r.comexVol) } : {}),
    ...(isValidPos(r.gldClose) ? { gldClose: round(r.gldClose, 2) } : {}),
    ...(isValidPos(r.gldVol) ? { gldVol: Math.round(r.gldVol) } : {}),
    ...(Number.isFinite(r.cftcNet) ? { cftcNet: Math.round(r.cftcNet) } : {}),
    ...(isValidPos(r.cftcOi) ? { cftcOi: Math.round(r.cftcOi) } : {}),
    ...(Number.isFinite(r.cftcPct) ? { cftcPct: round(r.cftcPct, 1) } : {}),
    ...(typeof r.sgePremiumCny === 'number' && Number.isFinite(r.sgePremiumCny) ? { sgePremiumCny: round(r.sgePremiumCny, 2) } : {}),
    ...(r.basisAdjusted ? { basisAdjusted: true } : {}),
    ...(r.macroObsDate ? { macroObsDate: r.macroObsDate } : {}),
    ...(r.cftcObsDate ? { cftcObsDate: r.cftcObsDate } : {}),
    ...(r.source ? { source: r.source } : {}),
  }));

  atomicWriteFile(jsonlPath, lines.join('\n') + '\n');
  if (meta) {
    atomicWriteFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
  }
  return sorted;
}

/** 读取 25 年月线 Git 快照（docs/market-data/gold-monthly-25y.jsonl） */
function readMonthlySnapshot(docsDir) {
  const { monthlyJsonlPath } = getSnapshotPaths(docsDir);
  if (!fs.existsSync(monthlyJsonlPath)) return [];
  const raw = fs.readFileSync(monthlyJsonlPath, 'utf-8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.ym === 'string' && /^\d{4}-\d{2}$/.test(obj.ym) && isValidPos(obj.londonClose)) {
        rows.push(obj);
      }
    } catch {
      // 忽略损坏单行
    }
  }
  rows.sort((a, b) => a.ym.localeCompare(b.ym));
  return rows;
}

/** 原子写出 25 年月线 Git 快照 */
function writeMonthlySnapshot(docsDir, rows) {
  const { monthlyJsonlPath } = getSnapshotPaths(docsDir);
  const sorted = rows
    .filter(r => r && typeof r.ym === 'string' && /^\d{4}-\d{2}$/.test(r.ym) && isValidPos(r.londonClose))
    .sort((a, b) => a.ym.localeCompare(b.ym));

  const lines = sorted.map(r => JSON.stringify({
    ym: r.ym,
    date: r.date,
    londonClose: round(r.londonClose, 2),
    ...(isValidPos(r.londonHigh) ? { londonHigh: round(r.londonHigh, 2) } : {}),
    ...(isValidPos(r.londonLow) ? { londonLow: round(r.londonLow, 2) } : {}),
    ...(isValidPos(r.dxy) ? { dxy: round(r.dxy, 2) } : {}),
    ...(isValidPos(r.us10y) ? { us10y: round(r.us10y, 3) } : {}),
    ...(isValidFiniteRate(r.tips) ? { tips: round(r.tips, 3) } : {}),
    ...(isValidFiniteRate(r.fedFunds, 0, 25) ? { fedFunds: round(r.fedFunds, 3) } : {}),
    ...(isValidFiniteRate(r.us2y, 0, 25) ? { us2y: round(r.us2y, 3) } : {}),
    ...(isValidPos(r.cpi) ? { cpi: round(r.cpi, 3) } : {}),
    ...(typeof r.cpiYoY === 'number' && Number.isFinite(r.cpiYoY) ? { cpiYoY: round(r.cpiYoY, 2) } : {}),
    ...(isValidPos(r.usdCny) ? { usdCny: round(r.usdCny, 4) } : {}),
    ...(isValidPos(r.realGoldIndex) ? { realGoldIndex: round(r.realGoldIndex, 2) } : {}),
    ...(r.tipsObsDate ? { tipsObsDate: r.tipsObsDate } : {}),
    ...(r.cpiObsDate ? { cpiObsDate: r.cpiObsDate } : {}),
    ...(r.source ? { source: r.source } : {}),
  }));

  atomicWriteFile(monthlyJsonlPath, lines.join('\n') + '\n');
  return sorted;
}

/** 查找不超过目标月份 ym 的最近一个 FRED 月观测 */
function latestMonthlyOnOrBefore(sortedEntries, targetYm) {
  let lo = 0;
  let hi = sortedEntries.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedEntries[mid][0] <= targetYm) {
      best = sortedEntries[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** 同步 26 年连续月线黄金与宏观底表（供 1年 / 2年 / 5年 长期预测与 25 年分位溯源使用） */
async function syncMonthlyHistory({ docsDir, mode = 'auto', dailyRows = [], liveQuotes = null }) {
  const existing = readMonthlySnapshot(docsDir);
  const needFull = mode === 'full' || existing.length < 240;

  const byYm = new Map();
  for (const r of existing) byYm.set(r.ym, { ...r });

  let fredTipsM = { byYm: new Map(), latestDate: null };
  let fred10yM = { byYm: new Map(), latestDate: null };
  let fredCpiM = { byYm: new Map(), latestDate: null };
  let fredCnyM = { byYm: new Map(), latestDate: null };
  let dxyMonthly = new Map();

  if (needFull) {
    const [goldMonthly, dxyM, tipsM, y10M, cpiM, cnyM] = await Promise.all([
      fetchYahooGoldMonthlyFull(),
      fetchYahooMonthlyRange('DX-Y.NYB', '2000-01-01T00:00:00Z'),
      fetchFredMonthly('DFII10', '2002-01'),
      fetchFredMonthly('DGS10', '2000-01'),
      fetchFredMonthly('CPIAUCSL', '1999-01'),
      fetchFredMonthly('DEXCHUS', '2000-01'),
    ]);
    fredTipsM = tipsM;
    fred10yM = y10M;
    fredCpiM = cpiM;
    fredCnyM = cnyM;
    dxyMonthly = dxyM;

    for (const [ym, bar] of goldMonthly.entries()) {
      const prev = byYm.get(ym) || { ym };
      byYm.set(ym, {
        ...prev,
        ym,
        date: bar.date,
        londonClose: bar.londonClose,
        londonHigh: bar.londonHigh,
        londonLow: bar.londonLow,
        source: 'yahoo_gc_monthly',
      });
    }
  } else {
    // 增量模式仅拉取近期 FRED CPI/TIPS/10Y/DEXCHUS 与 DXY，避免重复下载 26 年日线
    const sinceYm = yearsAgoDate(2).slice(0, 7);
    const [dxyM, tipsM, y10M, cpiM, cnyM] = await Promise.all([
      fetchYahooMonthlyRange('DX-Y.NYB', yearsAgoDate(2) + 'T00:00:00Z'),
      fetchFredMonthly('DFII10', sinceYm),
      fetchFredMonthly('DGS10', sinceYm),
      fetchFredMonthly('CPIAUCSL', yearsAgoDate(3).slice(0, 7)),
      fetchFredMonthly('DEXCHUS', sinceYm),
    ]);
    fredTipsM = tipsM;
    fred10yM = y10M;
    fredCpiM = cpiM;
    fredCnyM = cnyM;
    dxyMonthly = dxyM;
  }

  // 用最新的 5 年日线合并近月（确保当月和最近月与实盘日线 100% 对齐，零跳变）
  const recentDailyByYm = new Map();
  for (const r of dailyRows) {
    if (!r?.date || !isValidPos(r.londonClose)) continue;
    const ym = r.date.slice(0, 7);
    const prev = recentDailyByYm.get(ym);
    if (!prev) {
      recentDailyByYm.set(ym, {
        ym,
        date: r.date,
        londonClose: r.londonClose,
        londonHigh: isValidPos(r.londonHigh) ? Math.max(r.londonHigh, r.londonClose) : r.londonClose,
        londonLow: isValidPos(r.londonLow) ? Math.min(r.londonLow, r.londonClose) : r.londonClose,
        dxy: r.dxy,
        us10y: r.us10y,
        tips: r.tips,
        usdCny: r.usdCny,
        tipsObsDate: r.macroObsDate || null,
        source: r.source || 'yahoo_gc',
      });
    } else {
      prev.londonHigh = round(Math.max(prev.londonHigh, r.londonHigh || r.londonClose, r.londonClose), 2);
      prev.londonLow = round(Math.min(prev.londonLow, r.londonLow || r.londonClose, r.londonClose), 2);
      if (r.date >= prev.date) {
        prev.date = r.date;
        prev.londonClose = r.londonClose;
        if (isValidPos(r.dxy)) prev.dxy = r.dxy;
        if (isValidPos(r.us10y)) prev.us10y = r.us10y;
        if (isValidFiniteRate(r.tips)) prev.tips = r.tips;
        if (isValidFiniteRate(r.fedFunds, 0, 25)) prev.fedFunds = r.fedFunds;
        if (isValidFiniteRate(r.us2y, 0, 25)) prev.us2y = r.us2y;
        if (isValidPos(r.usdCny)) prev.usdCny = r.usdCny;
        if (r.macroObsDate) prev.tipsObsDate = r.macroObsDate;
        if (r.source) prev.source = r.source;
      }
    }
  }
  for (const [ym, dBar] of recentDailyByYm.entries()) {
    const prev = byYm.get(ym) || { ym };
    byYm.set(ym, {
      ...prev,
      ym,
      date: dBar.date,
      londonClose: dBar.londonClose,
      londonHigh: dBar.londonHigh,
      londonLow: dBar.londonLow,
      ...(isValidPos(dBar.dxy) ? { dxy: dBar.dxy } : {}),
      ...(isValidPos(dBar.us10y) ? { us10y: dBar.us10y } : {}),
      ...(isValidFiniteRate(dBar.tips) ? { tips: dBar.tips } : {}),
      ...(isValidFiniteRate(dBar.fedFunds, 0, 25) ? { fedFunds: dBar.fedFunds } : {}),
      ...(isValidFiniteRate(dBar.us2y, 0, 25) ? { us2y: dBar.us2y } : {}),
      ...(isValidPos(dBar.usdCny) ? { usdCny: dBar.usdCny } : {}),
      ...(dBar.tipsObsDate ? { tipsObsDate: dBar.tipsObsDate } : {}),
      source: dBar.source,
    });
  }

  // 对齐宏观月线字段（TIPS / 10Y / CPI & CPI YoY / DXY / USD-CNY / Real Gold Index）
  const tipsEntries = [...fredTipsM.byYm.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const y10Entries = [...fred10yM.byYm.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const cpiEntries = [...fredCpiM.byYm.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const cnyEntries = [...fredCnyM.byYm.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const cpiLookup = new Map(cpiEntries);
  const dxyEntries = [...dxyMonthly.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const prevYearYm = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    return `${y - 1}-${String(m).padStart(2, '0')}`;
  };

  const mergedMonthly = [...byYm.values()]
    .filter(r => isValidPos(r.londonClose))
    .sort((a, b) => a.ym.localeCompare(b.ym));

  for (const r of mergedMonthly) {
    const ym = r.ym;
    const tRec = fredTipsM.byYm.get(ym) || latestMonthlyOnOrBefore(tipsEntries, ym)?.[1];
    const y10Rec = fred10yM.byYm.get(ym) || latestMonthlyOnOrBefore(y10Entries, ym)?.[1];
    const cpiRec = fredCpiM.byYm.get(ym) || latestMonthlyOnOrBefore(cpiEntries, ym)?.[1];
    const cnyRec = fredCnyM.byYm.get(ym) || latestMonthlyOnOrBefore(cnyEntries, ym)?.[1];
    const dxyVal = dxyMonthly.get(ym) || latestMonthlyOnOrBefore(dxyEntries, ym)?.[1];

    if (tRec && isValidFiniteRate(tRec.val)) {
      r.tips = round(tRec.val, 3);
      r.tipsObsDate = tRec.obsDate;
    }
    if (y10Rec && isValidPos(y10Rec.val)) {
      r.us10y = round(y10Rec.val, 3);
    }
    if (isValidPos(dxyVal) && !isValidPos(r.dxy)) {
      r.dxy = round(dxyVal, 2);
    } else if (dxyMonthly.has(ym)) {
      r.dxy = round(dxyMonthly.get(ym), 2);
    }
    if (cnyRec && isValidPos(cnyRec.val) && !isValidPos(r.usdCny)) {
      r.usdCny = round(cnyRec.val, 4);
    }
    if (cpiRec && isValidPos(cpiRec.val)) {
      r.cpi = round(cpiRec.val, 3);
      r.cpiObsDate = cpiRec.obsDate;
      const cpiYm = cpiRec.obsDate.slice(0, 7);
      const prevCpi = cpiLookup.get(prevYearYm(cpiYm));
      if (prevCpi && isValidPos(prevCpi.val)) {
        r.cpiYoY = round(((cpiRec.val - prevCpi.val) / prevCpi.val) * 100, 2);
      }
    }
    if (isValidPos(r.cpi)) {
      r.realGoldIndex = round((r.londonClose / r.cpi) * 100, 2);
    }
  }

  // 若实时美元人民币汇率存在，对齐最新月
  if (mergedMonthly.length > 0 && isValidPos(liveQuotes?.usdCny)) {
    mergedMonthly[mergedMonthly.length - 1].usdCny = liveQuotes.usdCny;
  }

  if (mergedMonthly.length > 0) {
    writeMonthlySnapshot(docsDir, mergedMonthly);
  }

  return {
    rows: mergedMonthly,
    latestCpiDate: fredCpiM.latestDate || mergedMonthly[mergedMonthly.length - 1]?.cpiObsDate || null,
  };
}

/** 打开并确保 SQLite 表存在（与 src/db/index.ts 完全同构） */
function openGoldRushDb(dbPath) {
  const resolved = dbPath || path.resolve(process.cwd(), DEFAULT_DB_REL);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.exec(`
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
    );
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
    );
  `);
  // v2.6 幂等列迁移：补齐 GVZ / US2Y / 上海金美元溢价
  try { db.exec('ALTER TABLE gold_prices ADD COLUMN gvz REAL'); } catch { /* ok */ }
  try { db.exec('ALTER TABLE gold_prices ADD COLUMN us2y_yield REAL'); } catch { /* ok */ }
  try { db.exec('ALTER TABLE gold_prices ADD COLUMN sge_premium_usd REAL'); } catch { /* ok */ }
  return db;
}

/** 参数化事务写入本地 SQLite（COALESCE 保护：绝不以 0/NULL 覆盖已有有效列） */
function persistRowsToSqlite(rows, cftcWeekly, dbPath) {
  const db = openGoldRushDb(dbPath);
  try {
    const upsertPrice = db.prepare(`
      INSERT INTO gold_prices (
        date, london_close, london_high, london_low,
        shanghai_close, etf_nav, dollar_index, us10y_yield, tips_yield,
        gvz, us2y_yield, sge_premium_usd
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        london_close = COALESCE(excluded.london_close, gold_prices.london_close),
        london_high = COALESCE(excluded.london_high, gold_prices.london_high),
        london_low = COALESCE(excluded.london_low, gold_prices.london_low),
        shanghai_close = COALESCE(excluded.shanghai_close, gold_prices.shanghai_close),
        etf_nav = COALESCE(excluded.etf_nav, gold_prices.etf_nav),
        dollar_index = COALESCE(excluded.dollar_index, gold_prices.dollar_index),
        us10y_yield = COALESCE(excluded.us10y_yield, gold_prices.us10y_yield),
        tips_yield = COALESCE(excluded.tips_yield, gold_prices.tips_yield),
        gvz = COALESCE(excluded.gvz, gold_prices.gvz),
        us2y_yield = COALESCE(excluded.us2y_yield, gold_prices.us2y_yield),
        sge_premium_usd = COALESCE(excluded.sge_premium_usd, gold_prices.sge_premium_usd)
    `);

    const upsertCftc = db.prepare(`
      INSERT INTO institutional_flows (
        date, cftc_nc_long, cftc_nc_short, cftc_nc_net, cftc_nc_change,
        cftc_open_interest, cftc_report_date
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        cftc_nc_long = COALESCE(excluded.cftc_nc_long, institutional_flows.cftc_nc_long),
        cftc_nc_short = COALESCE(excluded.cftc_nc_short, institutional_flows.cftc_nc_short),
        cftc_nc_net = COALESCE(excluded.cftc_nc_net, institutional_flows.cftc_nc_net),
        cftc_nc_change = COALESCE(excluded.cftc_nc_change, institutional_flows.cftc_nc_change),
        cftc_open_interest = COALESCE(excluded.cftc_open_interest, institutional_flows.cftc_open_interest),
        cftc_report_date = COALESCE(excluded.cftc_report_date, institutional_flows.cftc_report_date)
    `);

    const tx = db.transaction(() => {
      for (const r of rows) {
        if (!r?.date || !isValidPos(r.londonClose)) continue;
        const sgePremUsd = (typeof r.sgePremiumCny === 'number' && Number.isFinite(r.sgePremiumCny) && isValidPos(r.usdCny))
          ? round((r.sgePremiumCny / r.usdCny) * 31.1034768, 2)
          : (typeof r.sgePremiumUsd === 'number' && Number.isFinite(r.sgePremiumUsd) ? round(r.sgePremiumUsd, 2) : null);
        upsertPrice.run(
          r.date,
          round(r.londonClose, 2),
          isValidPos(r.londonHigh) ? round(r.londonHigh, 2) : null,
          isValidPos(r.londonLow) ? round(r.londonLow, 2) : null,
          isValidPos(r.shanghaiClose) ? round(r.shanghaiClose, 2) : null,
          isValidPos(r.gldClose) ? round(r.gldClose, 2) : null,
          isValidPos(r.dxy) ? round(r.dxy, 2) : null,
          isValidPos(r.us10y) ? round(r.us10y, 3) : null,
          isValidFiniteRate(r.tips) ? round(r.tips, 3) : null,
          isValidPos(r.gvz) ? round(r.gvz, 2) : null,
          isValidFiniteRate(r.us2y, 0, 25) ? round(r.us2y, 3) : null,
          sgePremUsd,
        );
      }
      for (const c of (cftcWeekly || [])) {
        if (!c?.date || !Number.isFinite(c.nonCommNet)) continue;
        upsertCftc.run(
          c.date,
          c.nonCommLong,
          c.nonCommShort,
          c.nonCommNet,
          c.nonCommChange ?? 0,
          c.openInterest ?? null,
          c.date,
        );
      }
    });
    tx();
  } finally {
    db.close();
  }
}

/** 冷启动双向对齐：若新拉仓库本地 SQLite 为空或落后于 Git 快照，自动将 Git 快照灌入 SQLite */
function ensureSqliteHydrated(docsDir, dbPath) {
  const snapshotRows = readMarketSnapshot(docsDir);
  if (snapshotRows.length === 0) return { hydrated: false, count: 0 };
  const db = openGoldRushDb(dbPath);
  let dbCount = 0;
  let dbMaxDate = '';
  try {
    const stat = db.prepare('SELECT COUNT(*) AS cnt, MAX(date) AS maxDate FROM gold_prices WHERE london_close > 0').get();
    dbCount = stat?.cnt || 0;
    dbMaxDate = stat?.maxDate || '';
  } finally {
    db.close();
  }
  const snapMax = snapshotRows[snapshotRows.length - 1].date;
  if (dbCount < snapshotRows.length || dbMaxDate < snapMax) {
    persistRowsToSqlite(snapshotRows, [], dbPath);
    return { hydrated: true, count: snapshotRows.length };
  }
  return { hydrated: false, count: dbCount };
}

/** 查找不超过 targetDate 的最近一个观测（严格因果，绝不使用未来值） */
function latestOnOrBefore(sortedEntries, targetDate) {
  let lo = 0;
  let hi = sortedEntries.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedEntries[mid][0] <= targetDate) {
      best = sortedEntries[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * 执行市场数据同步（全量 5 年或增量刷新）并双写 SQLite + Git 快照。
 * @param {object} opts
 * @param {string} opts.docsDir docs 目录绝对路径
 * @param {'auto'|'full'|'incremental'} [opts.mode='auto']
 * @param {boolean} [opts.force=false] true 时跳过 30s 冷却（供 CLI 使用）
 * @param {string} [opts.dbPath] 自定义 SQLite 路径（供单测使用）
 */
async function syncMarketData(opts = {}) {
  const docsDir = opts.docsDir || path.resolve(process.cwd(), 'docs');
  const dbPath = opts.dbPath || path.resolve(process.cwd(), DEFAULT_DB_REL);
  const force = Boolean(opts.force);

  // 并发互斥锁：复用进行中的同步任务，避免重复打爆外部接口
  if (_inFlightSync) {
    return _inFlightSync;
  }

  const nowMs = Date.now();
  if (!force && nowMs - _lastManualSyncAt < MANUAL_COOLDOWN_MS) {
    const waitSec = Math.ceil((MANUAL_COOLDOWN_MS - (nowMs - _lastManualSyncAt)) / 1000);
    return {
      ok: true,
      refreshed: false,
      cooldown: true,
      waitSec,
      message: `刚刚已刷新，请 ${waitSec} 秒后再试`,
      meta: readSyncMeta(docsDir),
    };
  }

  _inFlightSync = (async () => {
    try {
      const existingRows = readMarketSnapshot(docsDir);
      const mode = opts.mode && opts.mode !== 'auto'
        ? opts.mode
        : (existingRows.length < 400 ? 'full' : 'incremental');
      const yahooRange = mode === 'full' ? '5y' : '3mo';
      const sinceDate = yearsAgoDate(5);
      const today = todayShanghaiDate();

      // 并发拉取所有白名单外部源（v2.4 新增 ^GVZ / ^VIX / FEDFUNDS / DGS2 支撑八维体系）
      const [
        goldMap,
        dxyMap,
        tnxMap,
        gldMap,
        cnyMap,
        gvzMap,
        vixMap,
        fredTips,
        fred10y,
        fredDxy,
        fredFedFunds,
        fred2y,
        liveSpot,
        sinaGc,
        sinaAu9999,
        sinaUsdcny,
        sinaEtf518880,
        cftcWeekly,
      ] = await Promise.all([
        fetchYahooDaily('GC=F', yahooRange),
        fetchYahooDaily('DX-Y.NYB', yahooRange),
        fetchYahooDaily('^TNX', yahooRange),
        fetchYahooDaily('GLD', yahooRange),
        fetchYahooDaily('CNY=X', yahooRange),
        fetchYahooDaily('^GVZ', yahooRange),
        fetchYahooDaily('^VIX', yahooRange),
        fetchFredSeries('DFII10', mode === 'full' ? sinceDate : yearsAgoDate(1)),
        fetchFredSeries('DGS10', mode === 'full' ? sinceDate : yearsAgoDate(1)),
        fetchFredSeries('DTWEXBGS', mode === 'full' ? sinceDate : yearsAgoDate(1)),
        fetchFredSeries('FEDFUNDS', mode === 'full' ? sinceDate : yearsAgoDate(1)),
        fetchFredSeries('DGS2', mode === 'full' ? sinceDate : yearsAgoDate(1)),
        fetchGoldApiSpot(),
        fetchSinaLive('hf_GC'),
        fetchSinaLive('gds_AU9999'),
        fetchSinaLive('fx_susdcny'),
        fetchSinaLive('sh518880'),
        fetchCftcWeekly(mode === 'full' ? 260 : 60),
      ]);

      // 以已有快照为底表（保留旧的上海金/CFTC 等列），按日期合并新抓取数据
      const byDate = new Map();
      for (const r of existingRows) {
        byDate.set(r.date, { ...r });
      }

      // 将 Yahoo 5y/3mo 主金价 + COMEX 成交量写入
      for (const [d, bar] of goldMap.entries()) {
        if (d < sinceDate) continue;
        const prev = byDate.get(d) || { date: d };
        byDate.set(d, {
          ...prev,
          date: d,
          londonClose: bar.close,
          londonHigh: bar.high ?? prev.londonHigh,
          londonLow: bar.low ?? prev.londonLow,
          ...(isValidPos(bar.volume) ? { comexVol: bar.volume } : {}),
          source: prev.source || 'yahoo_gc',
        });
      }

      // 合并当日实时锚定（gold-api 伦敦金 + 新浪上海金 Au99.99 + 实时汇率）
      const liveGoldPrice = liveSpot?.price ?? sinaGc?.price ?? null;
      let anchorDiffPct = null;
      if (liveSpot?.price && sinaGc?.price) {
        anchorDiffPct = round((Math.abs(liveSpot.price - sinaGc.price) / liveSpot.price) * 100, 2);
      }

      if (isValidPos(liveGoldPrice)) {
        const prevToday = byDate.get(today) || { date: today };
        const mergedHigh = isValidPos(prevToday.londonHigh) ? Math.max(prevToday.londonHigh, liveGoldPrice) : liveGoldPrice;
        const mergedLow = isValidPos(prevToday.londonLow) ? Math.min(prevToday.londonLow, liveGoldPrice) : liveGoldPrice;
        const usdCnyToday = isValidPos(sinaUsdcny?.price) ? sinaUsdcny.price : prevToday.usdCny;
        const shToday = isValidPos(sinaAu9999?.price) ? sinaAu9999.price : prevToday.shanghaiClose;
        const impliedCny = isValidPos(usdCnyToday) ? (liveGoldPrice * usdCnyToday) / 31.1034768 : null;
        const sgePremiumCny = (isValidPos(shToday) && isValidPos(impliedCny)) ? round(shToday - impliedCny, 2) : prevToday.sgePremiumCny;
        byDate.set(today, {
          ...prevToday,
          date: today,
          londonClose: liveGoldPrice,
          londonHigh: round(mergedHigh, 2),
          londonLow: round(mergedLow, 2),
          shanghaiClose: shToday,
          usdCny: usdCnyToday,
          ...(typeof sgePremiumCny === 'number' && Number.isFinite(sgePremiumCny) ? { sgePremiumCny } : {}),
          source: liveSpot ? 'gold_api_live' : 'sina_gc_live',
        });
      }

      // 预先排序辅助序列，严格因果对齐每个交易日的 DXY / 10Y / TIPS / GVZ / VIX / FEDFUNDS / 2Y / GLD / CNY / CFTC
      const dxyEntries = [...dxyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const tnxEntries = [...tnxMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const gldEntries = [...gldMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const cnyEntries = [...cnyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const gvzEntries = [...gvzMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const vixEntries = [...vixMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const tipsEntries = [...fredTips.map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const f10yEntries = [...fred10y.map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const fdxyEntries = [...fredDxy.map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const fedEntries = [...fredFedFunds.map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const f2yEntries = [...fred2y.map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const cftcEntries = (cftcWeekly || []).map(c => [c.date, c]);

      let mergedRows = [...byDate.values()]
        .filter(r => r.date >= sinceDate && isValidPos(r.londonClose))
        .sort((a, b) => a.date.localeCompare(b.date));

      // F15: 若实时现货与期货锚定同时存在，对历史期货段做比例向后复权以消除期现基差跳空
      if (isValidPos(liveSpot?.price) && isValidPos(sinaGc?.price)) {
        mergedRows = reconcileSpotFuturesBasis(mergedRows, liveSpot.price, sinaGc.price);
      }

      for (const r of mergedRows) {
        const d = r.date;
        const yDxy = dxyMap.get(d) || latestOnOrBefore(dxyEntries, d)?.[1];
        const yTnx = tnxMap.get(d) || latestOnOrBefore(tnxEntries, d)?.[1];
        const yGld = gldMap.get(d) || latestOnOrBefore(gldEntries, d)?.[1];
        const yCny = cnyMap.get(d) || latestOnOrBefore(cnyEntries, d)?.[1];
        const yGvz = gvzMap.get(d) || latestOnOrBefore(gvzEntries, d)?.[1];
        const yVix = vixMap.get(d) || latestOnOrBefore(vixEntries, d)?.[1];
        const fTips = latestOnOrBefore(tipsEntries, d);
        const f10y = latestOnOrBefore(f10yEntries, d);
        const fDxy = latestOnOrBefore(fdxyEntries, d);
        const fFed = latestOnOrBefore(fedEntries, d);
        const f2y = latestOnOrBefore(f2yEntries, d);
        const cftc = latestOnOrBefore(cftcEntries, d);

        if (yDxy && isValidPos(yDxy.close)) r.dxy = yDxy.close;
        else if (fDxy && isValidPos(fDxy[1]) && !isValidPos(r.dxy)) r.dxy = round(fDxy[1], 2);

        if (f10y && isValidPos(f10y[1])) r.us10y = round(f10y[1], 3);
        else if (yTnx && isValidPos(yTnx.close)) r.us10y = round(yTnx.close, 3);

        if (fTips && isValidFiniteRate(fTips[1])) {
          r.tips = round(fTips[1], 3);
          r.macroObsDate = fTips[0];
        } else if (f10y) {
          r.macroObsDate = f10y[0];
        }

        if (fFed && isValidFiniteRate(fFed[1], 0, 25)) r.fedFunds = round(fFed[1], 3);
        if (f2y && isValidFiniteRate(f2y[1], 0, 25)) r.us2y = round(f2y[1], 3);
        if (yGvz && isValidPos(yGvz.close)) r.gvz = round(yGvz.close, 2);
        if (yVix && isValidPos(yVix.close)) r.vix = round(yVix.close, 2);

        if (yGld && isValidPos(yGld.close)) {
          r.gldClose = yGld.close;
          if (isValidPos(yGld.volume)) r.gldVol = yGld.volume;
        }

        // 当日已有新浪实时汇率则保留，历史日用真实 CNY=X 日线
        if (!isValidPos(r.usdCny) && yCny && isValidPos(yCny.close)) {
          r.usdCny = yCny.close;
        }

        if (isValidPos(r.shanghaiClose) && isValidPos(r.usdCny) && r.sgePremiumCny == null) {
          const implied = (r.londonClose * r.usdCny) / 31.1034768;
          r.sgePremiumCny = round(r.shanghaiClose - implied, 2);
        }

        if (cftc) {
          r.cftcNet = cftc[1].nonCommNet;
          if (isValidPos(cftc[1].openInterest)) r.cftcOi = cftc[1].openInterest;
          r.cftcPct = cftc[1].percentile;
          r.cftcObsDate = cftc[0];
        }
      }

      const lastRow = mergedRows[mergedRows.length - 1] || null;
      const firstRow = mergedRows[0] || null;

      // 同步 26 年月线宏观底表（供 1年 / 2年 / 5年 长期周期预测与 25 年分位审计）
      const liveQuotesObj = {
        xauUsd: liveSpot?.price ?? null,
        hfGcUsd: sinaGc?.price ?? null,
        anchorDiffPct,
        shanghaiCny: sinaAu9999?.price ?? null,
        usdCny: sinaUsdcny?.price ?? lastRow?.usdCny ?? null,
        etf518880: sinaEtf518880?.price ?? null,
        updatedAt: liveSpot?.updatedAt || sinaAu9999?.updatedAt || new Date().toISOString(),
      };
      const monthlyRes = await syncMonthlyHistory({
        docsDir,
        mode,
        dailyRows: mergedRows,
        liveQuotes: liveQuotesObj,
      });
      const monthlyRows = monthlyRes.rows || [];

      const syncMeta = {
        schemaVersion: 2,
        lastSyncedAt: new Date().toISOString(),
        lastMode: mode,
        dateRange: {
          from: firstRow?.date || null,
          to: lastRow?.date || null,
        },
        tradingDays: mergedRows.length,
        monthlyBars: monthlyRows.length,
        monthlyDateRange: {
          from: monthlyRows[0]?.ym || null,
          to: monthlyRows[monthlyRows.length - 1]?.ym || null,
        },
        sources: {
          yahooGold: goldMap.size > 0 ? 'ok' : 'degraded',
          yahooMacro: (dxyMap.size > 0 || tnxMap.size > 0) ? 'ok' : 'degraded',
          fred: fredTips.map.size > 0 ? 'ok' : 'degraded',
          liveGold: liveSpot ? 'ok' : (sinaGc ? 'fallback_sina' : 'degraded'),
          liveSina: sinaAu9999 ? 'ok' : 'degraded',
          cftc: cftcWeekly.length > 0 ? 'ok' : 'cached_or_degraded',
          monthly25y: monthlyRows.length >= 240 ? 'ok' : 'partial',
        },
        liveQuotes: liveQuotesObj,
        obsDates: {
          gold: lastRow?.date || null,
          tips: fredTips.latestDate || lastRow?.macroObsDate || null,
          us10y: fred10y.latestDate || lastRow?.macroObsDate || null,
          cpi: monthlyRes.latestCpiDate || null,
          dxy: dxyEntries.length ? dxyEntries[dxyEntries.length - 1][0] : (fredDxy.latestDate || null),
          cftc: cftcWeekly.length ? cftcWeekly[cftcWeekly.length - 1].date : (lastRow?.cftcObsDate || null),
        },
      };

      // 双持久化：原子写入 Git 文本快照 + 事务更新本地 SQLite
      if (mergedRows.length > 0) {
        writeMarketSnapshot(docsDir, mergedRows, syncMeta);
        persistRowsToSqlite(mergedRows, cftcWeekly, dbPath);
      }

      _lastManualSyncAt = Date.now();
      return {
        ok: true,
        refreshed: true,
        cooldown: false,
        mode,
        tradingDays: mergedRows.length,
        monthlyBars: monthlyRows.length,
        latestDate: lastRow?.date || null,
        message: `已同步至 ${lastRow?.date || today}（${mergedRows.length} 日线 · ${monthlyRows.length} 月线）`,
        meta: syncMeta,
      };
    } catch (err) {
      return {
        ok: false,
        refreshed: false,
        cooldown: false,
        message: `同步失败：${err?.message || err}`,
        meta: readSyncMeta(docsDir),
      };
    } finally {
      _inFlightSync = null;
    }
  })();

  return _inFlightSync;
}

/**
 * 服务端启动自动对齐 + 定时增量刷新调度器（非阻塞，不影响首屏启动速度）
 */
function startBackgroundSyncScheduler(docsDir, dbPath) {
  try {
    ensureSqliteHydrated(docsDir, dbPath);
  } catch (err) {
    console.warn('[market-sync] SQLite hydration skipped:', err?.message || err);
  }

  const checkAndRefresh = async () => {
    const meta = readSyncMeta(docsDir);
    const today = todayShanghaiDate();
    const lastSyncMs = meta?.lastSyncedAt ? Date.parse(meta.lastSyncedAt) : 0;
    const stale = !meta || !meta.dateRange?.to || meta.dateRange.to < today || (Date.now() - lastSyncMs > STALE_AUTO_SYNC_MS);
    if (stale) {
      const res = await syncMarketData({ docsDir, dbPath, mode: 'auto', force: true });
      if (res.ok && res.refreshed) {
        console.log(`[market-sync] ${res.message}`);
      }
    }
  };

  // 启动后延迟 1.5s 静默检查一次，之后每 30 分钟增量刷新
  const bootTimer = setTimeout(() => { checkAndRefresh().catch(() => {}); }, 1500);
  if (typeof bootTimer.unref === 'function') bootTimer.unref();

  const interval = setInterval(() => { checkAndRefresh().catch(() => {}); }, STALE_AUTO_SYNC_MS);
  if (typeof interval.unref === 'function') interval.unref();

  return () => {
    clearTimeout(bootTimer);
    clearInterval(interval);
  };
}

module.exports = {
  USER_AGENT,
  SNAPSHOT_DIR_REL,
  JSONL_FILENAME,
  MONTHLY_JSONL_FILENAME,
  META_FILENAME,
  MANUAL_COOLDOWN_MS,
  isValidFiniteRate,
  reconcileSpotFuturesBasis,
  getSnapshotPaths,
  readMarketSnapshot,
  readMonthlySnapshot,
  readSyncMeta,
  writeMarketSnapshot,
  writeMonthlySnapshot,
  persistRowsToSqlite,
  ensureSqliteHydrated,
  syncMarketData,
  syncMonthlyHistory,
  startBackgroundSyncScheduler,
  parseSinaQuoteLine,
  getSourceHealth,
};
