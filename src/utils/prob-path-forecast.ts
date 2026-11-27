// 概率路径扇形 — FHS 波动率缩放 + 零前视严格因果 + 去重叠 Kish N_eff + 经验贝叶斯收缩（纯本地）

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
  type ProbPathRiskSummary,
  type ProbPathStructureLevel,
} from './prob-path-types.js';

const IN_SAMPLE_NOTE =
  '基于历史同类交易日 FHS 波动率标准化与经验贝叶斯收缩的统计分布，非确定性点位承诺；仓位以短期操作建议为准。';

const FHS_VOL_WINDOW = 20;
const FHS_SCALE_MIN = 0.45;
const FHS_SCALE_MAX = 2.2;
const SHRINKAGE_PRIOR_K0 = 15;

export interface BuildProbPathInput {
  db: Database.Database;
  asOf: string;
  score: number;
  /** 红档等：仅影响 gateHint，不阻止计算 */
  gateActionable?: boolean;
  gateTier?: string;
  currentFeature?: ScenarioFeature | null;
}

interface WeightedPath {
  date: string;
  values: number[];
  weight: number;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function weightedQuantile(pairs: Array<{ value: number; weight: number }>, q: number): number {
  const valid = pairs.filter(p => Number.isFinite(p.value) && p.weight > 0);
  if (valid.length === 0) return 0;
  valid.sort((a, b) => a.value - b.value);
  const totalW = valid.reduce((s, p) => s + p.weight, 0);
  if (totalW <= 0) return valid[Math.floor(valid.length / 2)]!.value;

  const target = clamp(q, 0, 1) * totalW;
  let cum = 0;
  for (let i = 0; i < valid.length; i++) {
    const prevCum = cum;
    cum += valid[i]!.weight;
    if (cum >= target) {
      if (i === 0) return valid[0]!.value;
      const prevVal = valid[i - 1]!.value;
      const curVal = valid[i]!.value;
      const frac = valid[i]!.weight > 0 ? (target - prevCum) / valid[i]!.weight : 0;
      return prevVal + (curVal - prevVal) * clamp(frac, 0, 1);
    }
  }
  return valid[valid.length - 1]!.value;
}

/** 计算某日期截至当日的 20 日对数日收益已实现波动率（% / 日）；样本不足返回 null */
export function realizedDailyVolPct(prices: GoldPricesRepo, asOf: string, window = FHS_VOL_WINDOW): number | null {
  const rows = prices.getRecent(window + 6, asOf).filter(r => validClose(r.londonClose));
  if (rows.length < 8) return null;
  const tail = rows.slice(-(window + 1));
  const rets: number[] = [];
  for (let i = 1; i < tail.length; i++) {
    const prev = tail[i - 1]!.londonClose!;
    const cur = tail[i]!.londonClose!;
    if (prev > 0 && cur > 0) rets.push(Math.log(cur / prev));
  }
  if (rets.length < 7) return null;
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  const variance = rets.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const sdPct = Math.sqrt(Math.max(variance, 0)) * 100;
  return sdPct > 0.05 ? round2(sdPct) : null;
}

/**
 * 决策日起逐交易日累计涨跌 %；不足 fullHorizon 个交易日则视为无效样本。
 * 若传入 maxDate（即当前评估日 asOf），则严格要求路径终点日期 <= maxDate，防止回放与样本外测试发生前视泄露。
 */
export function forwardPathCumPct(
  prices: GoldPricesRepo,
  date: string,
  fullHorizon: number,
  maxDate?: string,
): number[] | null {
  const current = prices.getByDate(date);
  if (!validClose(current?.londonClose)) return null;
  const start = current!.londonClose!;
  const after = prices.getAfter(date, fullHorizon + 15).filter(r => validClose(r.londonClose));
  if (after.length < fullHorizon) return null;
  if (maxDate && after[fullHorizon - 1]!.date > maxDate) return null;
  const out: number[] = [];
  for (let i = 0; i < fullHorizon; i++) {
    const end = after[i]!.londonClose!;
    out.push(((end - start) / start) * 100);
  }
  return out;
}

/** 历史轨迹严格以决策日现价 spot 锚定为 0%，消除与未来扇形交界处断崖跳变 */
function buildHistorySegment(
  prices: GoldPricesRepo,
  asOf: string,
  spot: number,
  days = PROB_PATH_HISTORY_DAYS,
): ProbPathHistoryPoint[] {
  const records = prices.getRecent(days, asOf).filter(r => validClose(r.londonClose));
  if (records.length < 2 || !Number.isFinite(spot) || spot <= 0) return [];
  return records.map(r => ({
    date: r.date,
    cumPct: round2(((r.londonClose! / spot) - 1) * 100),
  }));
}

function buildStructureLevels(spot: number, closes: number[]): ProbPathStructureLevel[] {
  if (!Number.isFinite(spot) || spot <= 0 || closes.length < 20) return [];
  const bb = latestBollinger(closes, 20, 2);
  const levels: ProbPathStructureLevel[] = [];
  const add = (label: string, level: number | null, kind?: 'resistance' | 'support') => {
    if (level == null || !Number.isFinite(level) || level <= 0) return;
    const pct = Math.round(((level / spot) - 1) * 1000) / 10;
    const resolvedKind = kind ?? (pct >= 0 ? 'resistance' : 'support');
    levels.push({ label, pctFromSpot: pct, kind: resolvedKind });
  };
  if (bb) {
    add('布林上轨', bb.upper, 'resistance');
    add('MA20(布林中轨)', bb.middle);
    add('布林下轨', bb.lower, 'support');
  }
  if (closes.length >= 60) {
    const ma60 = closes.slice(-60).reduce((s, v) => s + v, 0) / 60;
    add('MA60', ma60);
  }
  return levels;
}

/** 按重叠交易窗口降权并计算 Kish 有效样本量 N_eff */
function applyDeoverlapWeights(
  rawPaths: Array<{ date: string; values: number[]; baseWeight: number }>,
  horizon: number,
): { paths: WeightedPath[]; effectiveSampleSize: number } {
  if (rawPaths.length === 0) return { paths: [], effectiveSampleSize: 0 };
  const sorted = [...rawPaths].sort((a, b) => a.date.localeCompare(b.date));
  const dayMs = 86400_000;
  const calendarWindow = Math.max(5, Math.round(horizon * 1.4));
  const times = sorted.map(p => Date.parse(p.date));

  const weighted: WeightedPath[] = sorted.map((item, idx) => {
    let overlaps = 0;
    const t = times[idx]!;
    for (let j = 0; j < times.length; j++) {
      if (Math.abs(times[j]! - t) < calendarWindow * dayMs) overlaps++;
    }
    const w = item.baseWeight / Math.max(1, overlaps);
    return { date: item.date, values: item.values, weight: w };
  });

  const sumW = weighted.reduce((s, p) => s + p.weight, 0);
  const sumW2 = weighted.reduce((s, p) => s + p.weight * p.weight, 0);
  const nEff = sumW2 > 0 ? round2((sumW * sumW) / sumW2) : 0;
  return { paths: weighted, effectiveSampleSize: nEff };
}

function buildFhsPaths(
  prices: GoldPricesRepo,
  dates: Array<{ date: string; baseWeight: number }>,
  horizon: number,
  asOf: string,
  spotVol: number | null,
): Array<{ date: string; values: number[]; baseWeight: number }> {
  const out: Array<{ date: string; values: number[]; baseWeight: number }> = [];
  for (const item of dates) {
    const raw = forwardPathCumPct(prices, item.date, horizon, asOf);
    if (!raw) continue;
    let scale = 1;
    if (spotVol != null) {
      const histVol = realizedDailyVolPct(prices, item.date);
      if (histVol != null && histVol > 0) {
        scale = clamp(spotVol / histVol, FHS_SCALE_MIN, FHS_SCALE_MAX);
      }
    }
    out.push({
      date: item.date,
      values: raw.map(v => v * scale),
      baseWeight: item.baseWeight,
    });
  }
  return out;
}

function computeWeightedQuantiles(
  condPaths: WeightedPath[],
  uncondPaths: WeightedPath[],
  alpha: number,
  horizon: number,
): { points: ProbPathQuantilePoint[]; pathRisk: ProbPathRiskSummary | null } {
  const condSum = condPaths.reduce((s, p) => s + p.weight, 0);
  const uncondSum = uncondPaths.reduce((s, p) => s + p.weight, 0);
  const combined: WeightedPath[] = [];

  if (condSum > 0 && alpha > 0) {
    for (const p of condPaths) {
      combined.push({ ...p, weight: (p.weight / condSum) * alpha });
    }
  }
  if (uncondSum > 0 && 1 - alpha > 0) {
    for (const p of uncondPaths) {
      combined.push({ ...p, weight: (p.weight / uncondSum) * (1 - alpha) });
    }
  }
  if (combined.length === 0) return { points: [], pathRisk: null };

  const points: ProbPathQuantilePoint[] = [];
  for (let h = 1; h <= horizon; h++) {
    const slice: Array<{ value: number; weight: number }> = [];
    for (const p of combined) {
      if (p.values.length >= h) slice.push({ value: p.values[h - 1]!, weight: p.weight });
    }
    if (slice.length === 0) continue;
    const p10 = round2(weightedQuantile(slice, 0.1));
    const p25 = round2(weightedQuantile(slice, 0.25));
    const p50 = round2(weightedQuantile(slice, 0.5));
    const p75 = round2(weightedQuantile(slice, 0.75));
    const p90 = round2(weightedQuantile(slice, 0.9));
    points.push({ h, p10, p25, p50, p75, p90 });
  }

  // 路径最大回撤与期末收涨概率
  const ddPairs: Array<{ value: number; weight: number }> = [];
  let upW = 0;
  let totalW = 0;
  for (const p of combined) {
    if (p.values.length < horizon) continue;
    let peak = 0;
    let maxDd = 0;
    for (let i = 0; i < horizon; i++) {
      const v = p.values[i]!;
      if (v > peak) peak = v;
      const dd = v - peak;
      if (dd < maxDd) maxDd = dd;
    }
    ddPairs.push({ value: maxDd, weight: p.weight });
    if (p.values[horizon - 1]! > 0) upW += p.weight;
    totalW += p.weight;
  }

  const pathRisk: ProbPathRiskSummary | null = ddPairs.length > 0
    ? {
        maxDdP50: round2(weightedQuantile(ddPairs, 0.5)),
        maxDdP90: round2(weightedQuantile(ddPairs, 0.1)),
        upEndProb: totalW > 0 ? round2((upW / totalW) * 100) : 50,
      }
    : null;

  return { points, pathRisk };
}

function collectConditionCandidates(
  db: Database.Database,
  asOf: string,
  score: number,
  horizon: number,
  currentFeature: ScenarioFeature | null | undefined,
): {
  candidates: Array<{ date: string; baseWeight: number }>;
  bucket: string;
  bucketCount: number;
  similarAdded: number;
} {
  const prices = new GoldPricesRepo(db);
  const reports = new ReportsRepo(db);
  const bucket = scoreBucketRange(score);
  if (!bucket) {
    return { candidates: [], bucket: 'unknown', bucketCount: 0, similarAdded: 0 };
  }

  const bucketRows = reports
    .getByScoreRange(bucket.min, bucket.max)
    .filter(r => r.date < asOf);

  const dateSet = new Set<string>();
  const candidates: Array<{ date: string; baseWeight: number }> = [];

  const tryDate = (d: string, baseWeight: number) => {
    if (dateSet.has(d) || d >= asOf) return false;
    if (forwardPathCumPct(prices, d, horizon, asOf) == null) return false;
    dateSet.add(d);
    candidates.push({ date: d, baseWeight });
    return true;
  };

  for (const r of bucketRows) {
    if (candidates.length >= PROB_PATH_MAX_SAMPLE_PATHS) break;
    tryDate(r.date, 1);
  }
  const bucketCount = candidates.length;

  let similarAdded = 0;
  if (candidates.length < PROB_PATH_TARGET_SAMPLE && currentFeature) {
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
      if (candidates.length >= PROB_PATH_MAX_SAMPLE_PATHS) break;
      const simW = clamp(m.similarity, 0.3, 1);
      if (tryDate(m.date, simW)) similarAdded++;
    }
  }

  return {
    candidates: candidates.slice(0, PROB_PATH_MAX_SAMPLE_PATHS),
    bucket: bucket.range,
    bucketCount,
    similarAdded,
  };
}

function collectUnconditionalPaths(
  prices: GoldPricesRepo,
  asOf: string,
  horizon: number,
  spotVol: number | null,
): WeightedPath[] {
  const rows = prices.getRecent(360, asOf).filter(r => r.date < asOf && validClose(r.londonClose));
  const raw = buildFhsPaths(
    prices,
    rows.map(r => ({ date: r.date, baseWeight: 1 })),
    horizon,
    asOf,
    spotVol,
  );
  return applyDeoverlapWeights(raw, horizon).paths;
}

function buildHorizonTrack(
  db: Database.Database,
  prices: GoldPricesRepo,
  asOf: string,
  score: number,
  horizon: 5 | 20,
  spotVol: number | null,
  currentFeature: ScenarioFeature | null | undefined,
): {
  track: ProbPathHorizon;
  bucket: string;
  bucketCount: number;
  similarAdded: number;
  uncondP50: number | null;
  uncondCount: number;
} {
  const { candidates, bucket, bucketCount, similarAdded } = collectConditionCandidates(
    db,
    asOf,
    score,
    horizon,
    currentFeature,
  );
  const condRaw = buildFhsPaths(prices, candidates, horizon, asOf, spotVol);
  const { paths: condWeighted, effectiveSampleSize } = applyDeoverlapWeights(condRaw, horizon);
  const uncondWeighted = collectUnconditionalPaths(prices, asOf, horizon, spotVol);

  const uncondEnd = uncondWeighted
    .filter(p => p.values.length >= horizon)
    .map(p => ({ value: p.values[horizon - 1]!, weight: p.weight }));
  const uncondP50 = uncondEnd.length >= 10 ? round2(weightedQuantile(uncondEnd, 0.5)) : null;

  const hasUncond = uncondWeighted.length >= PROB_PATH_MIN_SAMPLE;
  const hasCond = condWeighted.length >= PROB_PATH_MIN_SAMPLE;
  const futureFan = hasCond || hasUncond;

  const alpha = hasCond
    ? hasUncond
      ? round2(effectiveSampleSize / (effectiveSampleSize + SHRINKAGE_PRIOR_K0))
      : 1
    : 0;

  const { points, pathRisk } = futureFan
    ? computeWeightedQuantiles(condWeighted, uncondWeighted, alpha, horizon)
    : { points: [], pathRisk: null };

  return {
    track: {
      h: horizon,
      futureFan,
      sampleSize: condWeighted.length,
      effectiveSampleSize,
      shrinkageWeight: alpha,
      pathRisk,
      points,
    },
    bucket,
    bucketCount,
    similarAdded,
    uncondP50,
    uncondCount: uncondWeighted.length,
  };
}

/** 构建完整 probPath meta（v2.0）；无法计算时返回 null（如无价） */
export function buildProbPathMeta(input: BuildProbPathInput): ProbPathMeta | null {
  const prices = new GoldPricesRepo(input.db);
  const asOf = input.asOf;

  const spotRow = prices.getByDate(asOf);
  if (!validClose(spotRow?.londonClose)) return null;
  const spot = spotRow!.londonClose!;

  let currentFeature = input.currentFeature;
  if (currentFeature == null) {
    currentFeature = new ScenarioFeaturesRepo(input.db).getByDate(asOf) ?? undefined;
  }

  const vol20dPct = realizedDailyVolPct(prices, asOf);

  // 双轨独立采样：5 日路径不再被 20 日窗口白白截断
  const h5 = buildHorizonTrack(input.db, prices, asOf, input.score, 5, vol20dPct, currentFeature);
  const h20 = buildHorizonTrack(input.db, prices, asOf, input.score, 20, vol20dPct, currentFeature);

  const n5 = h5.track.sampleSize ?? 0;
  let degraded: ProbPathDegraded = 'full';
  if (!h5.track.futureFan && !h20.track.futureFan) {
    degraded = 'history_only';
  } else if (n5 < PROB_PATH_MIN_SAMPLE) {
    degraded = 'unconditional_only';
  } else if (n5 < PROB_PATH_TARGET_SAMPLE) {
    degraded = 'sparse';
  }

  const closes = forwardFillCloses(prices.getRecent(120, asOf));
  const history = buildHistorySegment(prices, asOf, spot);
  const structure = buildStructureLevels(spot, closes);
  const baseline = h5.uncondP50 != null
    ? {
        horizon: 5,
        p50: h5.uncondP50,
        sampleSize: h5.uncondCount,
        label: '无条件 FHS 历史中位（对照）',
      }
    : null;

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
    vol20dPct,
    degraded,
    inSampleNote: IN_SAMPLE_NOTE,
    gateHint,
    condition: {
      bucket: h5.bucket,
      score: input.score,
      bucketCount: h5.bucketCount,
      similarAdded: h5.similarAdded,
      method: 'fhs_bucket_similar_shrink',
    },
    sampleSize: n5,
    effectiveSampleSize: h5.track.effectiveSampleSize,
    shrinkageWeight: h5.track.shrinkageWeight,
    structure,
    history,
    horizons: {
      '5': h5.track,
      '20': h20.track,
    },
    baseline,
    svgRel: null,
  };
}

export function formatProbPathConsole(meta: ProbPathMeta): string {
  const h5 = meta.horizons['5'];
  const last = h5.points[h5.points.length - 1];
  const band = last
    ? `P10~P90 ${last.p10}% ~ ${last.p90}%（P25~P75 ${last.p25 ?? '-'}% ~ ${last.p75 ?? '-'}%，P50 ${last.p50}%）`
    : '未来扇形未生成';
  const neff = meta.effectiveSampleSize != null ? `  N_eff=${meta.effectiveSampleSize}` : '';
  const vol = meta.vol20dPct != null ? `  σ20d=${meta.vol20dPct}%/日` : '';
  return [
    `概率路径 ${meta.asOf}　条件分桶 ${meta.condition.bucket}　n=${meta.sampleSize}${neff}${vol}　${meta.degraded}`,
    `5 日：${band}`,
    meta.gateHint ?? meta.inSampleNote,
  ].join('\n');
}