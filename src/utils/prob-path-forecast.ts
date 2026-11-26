// 概率路径扇形 — 分桶 → 相似日 → 经验分位（纯本地）

import type Database from 'better-sqlite3';
import { GoldPricesRepo } from '../db/gold-prices.js';
import { ReportsRepo } from '../db/reports.js';
import { ScenarioFeaturesRepo } from '../db/scenario-features.js';
import { latestBollinger } from '../indicators/bollinger.js';
import { validClose } from './forward-return.js';
import { forwardFillCloses } from './price-series.js';
import { scoreBucketRange } from './score-buckets.js';
import { findSimilarPatterns, type SimilaritySearchOptions } from './scenario-similarity.js';
import type { ScenarioFeature } from '../types/calibration.js';
import {
  PROB_PATH_HISTORY_DAYS,
  PROB_PATH_MAX_SAMPLE_PATHS,
  PROB_PATH_MAX_SIMILAR,
  PROB_PATH_MIN_SAMPLE,
  PROB_PATH_SCHEMA,
  PROB_PATH_TARGET_SAMPLE,
  type ProbPathDegraded,
  type ProbPathHistoryPoint,
  type ProbPathHorizon,
  type ProbPathMeta,
  type ProbPathQuantilePoint,
  type ProbPathStructureLevel,
} from './prob-path-types.js';

const IN_SAMPLE_NOTE =
  '基于历史同类交易日的样本内分位统计，非样本外承诺；勿以路径命中率为 KPI。';

export interface BuildProbPathInput {
  db: Database.Database;
  asOf: string;
  score: number;
  /** 红档等：仅影响 gateHint，不阻止计算 */
  gateActionable?: boolean;
  gateTier?: string;
  currentFeature?: ScenarioFeature | null;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/** 决策日起逐交易日累计涨跌 %；不足 fullHorizon 个交易日则视为无效样本 */
export function forwardPathCumPct(
  prices: GoldPricesRepo,
  date: string,
  fullHorizon: number,
): number[] | null {
  const current = prices.getByDate(date);
  if (!validClose(current?.londonClose)) return null;
  const start = current!.londonClose!;
  const after = prices.getAfter(date, fullHorizon + 15).filter(r => validClose(r.londonClose));
  if (after.length < fullHorizon) return null;
  const out: number[] = [];
  for (let i = 0; i < fullHorizon; i++) {
    const end = after[i]!.londonClose!;
    out.push(((end - start) / start) * 100);
  }
  return out;
}

function buildHistorySegment(
  prices: GoldPricesRepo,
  asOf: string,
  days = PROB_PATH_HISTORY_DAYS,
): ProbPathHistoryPoint[] {
  const records = prices.getRecent(days, asOf);
  const closes = forwardFillCloses(records);
  if (closes.length < 2) return [];
  const base = closes[0]!;
  const out: ProbPathHistoryPoint[] = [];
  let di = 0;
  for (const r of records) {
    if (!validClose(r.londonClose)) continue;
    const c = closes[di] ?? r.londonClose!;
    di++;
    out.push({
      date: r.date,
      cumPct: Math.round((((c - base) / base) * 100) * 100) / 100,
    });
  }
  return out;
}

function buildStructureLevels(spot: number, closes: number[]): ProbPathStructureLevel[] {
  if (!Number.isFinite(spot) || spot <= 0 || closes.length < 20) return [];
  const bb = latestBollinger(closes, 20, 2);
  const levels: ProbPathStructureLevel[] = [];
  const add = (label: string, level: number | null, kind: 'resistance' | 'support') => {
    if (level == null || !Number.isFinite(level) || level <= 0) return;
    const pct = Math.round(((level / spot) - 1) * 1000) / 10;
    levels.push({ label, pctFromSpot: pct, kind });
  };
  if (bb) {
    add('布林上轨', bb.upper, 'resistance');
    add('MA20(布林中轨)', bb.middle, 'resistance');
    add('布林下轨', bb.lower, 'support');
  }
  return levels;
}

function quantileSeries(paths: number[][], horizon: number): ProbPathQuantilePoint[] {
  const points: ProbPathQuantilePoint[] = [];
  for (let h = 1; h <= horizon; h++) {
    const slice: number[] = [];
    for (const p of paths) {
      if (p.length >= h) slice.push(p[h - 1]!);
    }
    if (slice.length === 0) continue;
    points.push({
      h,
      p10: Math.round(percentile(slice, 0.1) * 100) / 100,
      p50: Math.round(percentile(slice, 0.5) * 100) / 100,
      p90: Math.round(percentile(slice, 0.9) * 100) / 100,
    });
  }
  return points;
}

function buildHorizon(
  paths: number[][],
  horizon: number,
  futureFan: boolean,
): ProbPathHorizon {
  return {
    h: horizon,
    futureFan,
    points: futureFan ? quantileSeries(paths, horizon) : [],
  };
}

function collectSampleDates(
  db: Database.Database,
  asOf: string,
  score: number,
  maxHorizon: number,
  currentFeature: ScenarioFeature | null | undefined,
): { dates: string[]; bucket: string; bucketCount: number; similarAdded: number } {
  const prices = new GoldPricesRepo(db);
  const reports = new ReportsRepo(db);
  const bucket = scoreBucketRange(score);
  if (!bucket) {
    return { dates: [], bucket: 'unknown', bucketCount: 0, similarAdded: 0 };
  }

  const bucketRows = reports
    .getByScoreRange(bucket.min, bucket.max)
    .filter(r => r.date < asOf);

  const dateSet = new Set<string>();
  const pathsChecked = new Map<string, boolean>();

  const tryDate = (d: string) => {
    if (dateSet.has(d) || d >= asOf) return false;
    if (!pathsChecked.has(d)) {
      pathsChecked.set(d, forwardPathCumPct(prices, d, maxHorizon) != null);
    }
    if (!pathsChecked.get(d)) return false;
    dateSet.add(d);
    return true;
  };

  for (const r of bucketRows) tryDate(r.date);
  const bucketCount = dateSet.size;

  let similarAdded = 0;
  if (dateSet.size < PROB_PATH_TARGET_SAMPLE && currentFeature) {
    const featuresRepo = new ScenarioFeaturesRepo(db);
    const history = featuresRepo.listForSimilarity(400);
    const scoreMap = new Map<number, { score: number; direction: import('../types/analysis.js').Direction }>();
    for (const r of reports.getRecent(2000)) {
      scoreMap.set(r.id, { score: r.overallScore, direction: r.direction });
    }
    const simOpts: SimilaritySearchOptions = {
    topK: PROB_PATH_MAX_SIMILAR,
    minSimilarity: 0.45,
    excludeDate: asOf,
    filledOnly: false,
  };
    const matches = findSimilarPatterns(currentFeature, history, scoreMap, simOpts);
    for (const m of matches) {
      if (dateSet.size >= PROB_PATH_MAX_SAMPLE_PATHS) break;
      if (tryDate(m.date)) similarAdded++;
    }
  }

  return {
    dates: [...dateSet].slice(0, PROB_PATH_MAX_SAMPLE_PATHS),
    bucket: bucket.range,
    bucketCount,
    similarAdded,
  };
}

function collectPaths(prices: GoldPricesRepo, dates: string[], maxHorizon: number): number[][] {
  const paths: number[][] = [];
  for (const d of dates) {
    const p = forwardPathCumPct(prices, d, maxHorizon);
    if (p) paths.push(p);
  }
  return paths;
}

function buildBaselineP50(prices: GoldPricesRepo, reports: ReportsRepo, asOf: string): ProbPathMeta['baseline'] {
  const recent = reports.getRecent(800).filter(r => r.date < asOf);
  const vals: number[] = [];
  for (const r of recent) {
    const p = forwardPathCumPct(prices, r.date, 5);
    if (p && p.length >= 5) vals.push(p[4]!);
    if (vals.length >= 250) break;
  }
  if (vals.length < 15) return null;
  return {
    horizon: 5,
    p50: Math.round(percentile(vals, 0.5) * 100) / 100,
    sampleSize: vals.length,
    label: '无条件历史路径中位（对照）',
  };
}

/** 构建完整 probPath meta；无法计算时返回 null（如无价） */
export function buildProbPathMeta(input: BuildProbPathInput): ProbPathMeta | null {
  const prices = new GoldPricesRepo(input.db);
  const reports = new ReportsRepo(input.db);
  const asOf = input.asOf;

  const spotRow = prices.getByDate(asOf);
  if (!validClose(spotRow?.londonClose)) return null;
  const spot = spotRow!.londonClose!;

  let currentFeature = input.currentFeature;
  if (currentFeature == null) {
    currentFeature = new ScenarioFeaturesRepo(input.db).getByDate(asOf) ?? undefined;
  }

  const maxHorizon = 20;
  const { dates, bucket, bucketCount, similarAdded } = collectSampleDates(
    input.db,
    asOf,
    input.score,
    maxHorizon,
    currentFeature ?? null,
  );

  const paths = collectPaths(prices, dates, maxHorizon);
  const n = paths.length;

  let degraded: ProbPathDegraded = 'full';
  if (n < PROB_PATH_MIN_SAMPLE) degraded = 'history_only';
  else if (n < PROB_PATH_TARGET_SAMPLE) degraded = 'sparse';

  const futureFan = n >= PROB_PATH_MIN_SAMPLE;
  const closes = forwardFillCloses(prices.getRecent(120, asOf));
  const history = buildHistorySegment(prices, asOf);
  const structure = buildStructureLevels(spot, closes);
  const baseline = buildBaselineP50(prices, reports, asOf);

  let gateHint: string | null = null;
  if (input.gateActionable === false) {
    gateHint = '数据门禁未通过：概率路径仅供研究参考，不构成加仓/减仓建议；仓位以短期档与可信度为准。';
  } else if (input.gateTier === 'yellow') {
    gateHint = '数据黄档：路径分位供辅助阅读，操作仍受门禁约束。';
  }

  return {
    schemaVersion: PROB_PATH_SCHEMA,
    asOf,
    spot,
    degraded,
    inSampleNote: IN_SAMPLE_NOTE,
    gateHint,
    condition: {
      bucket,
      score: input.score,
      bucketCount,
      similarAdded,
      method: 'bucket_then_similar',
    },
    sampleSize: n,
    structure,
    history,
    horizons: {
      '5': buildHorizon(paths, 5, futureFan),
      '20': buildHorizon(paths, 20, futureFan),
    },
    baseline,
    svgRel: null,
  };
}

export function formatProbPathConsole(meta: ProbPathMeta): string {
  const h5 = meta.horizons['5'];
  const last = h5.points[h5.points.length - 1];
  const band = last
    ? `P10~P90 ${last.p10}% ~ ${last.p90}%（P50 ${last.p50}%）`
    : '未来扇形未生成';
  return [
    `概率路径 ${meta.asOf}　条件分桶 ${meta.condition.bucket}　n=${meta.sampleSize}　${meta.degraded}`,
    `5 日：${band}`,
    meta.gateHint ?? meta.inSampleNote,
  ].join('\n');
}