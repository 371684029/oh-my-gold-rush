// 概率路径扇形图 — 类型与契约常量（v2.0 FHS + 双轨视野 + 收缩稳健分位）

export const PROB_PATH_SCHEMA = 2 as const;

export const PROB_PATH_TARGET_SAMPLE = 30;
export const PROB_PATH_MIN_SAMPLE = 10;
export const PROB_PATH_HISTORY_DAYS = 60;
export const PROB_PATH_MAX_SIMILAR = 100;
export const PROB_PATH_MAX_SAMPLE_PATHS = 200;

export type ProbPathDegraded =
  | 'full'
  | 'sparse'
  | 'unconditional_only'
  | 'history_only'
  | 'no_spot';

export interface ProbPathStructureLevel {
  label: string;
  pctFromSpot: number;
  kind: 'resistance' | 'support';
}

export interface ProbPathHistoryPoint {
  date: string;
  cumPct: number;
}

export interface ProbPathQuantilePoint {
  h: number;
  p10: number;
  p25?: number;
  p50: number;
  p75?: number;
  p90: number;
}

export interface ProbPathRiskSummary {
  /** 严格峰谷最大回撤 P50（<= 0，%） */
  maxDdP50: number;
  /** 严格峰谷最大回撤 P90 尾部（<= 0，%） */
  maxDdP90: number;
  /** 相对起点买入价最大浮亏 P50（<= 0，%） */
  maxUnderwaterP50?: number;
  /** 相对起点买入价最大浮亏 P90（<= 0，%） */
  maxUnderwaterP90?: number;
  upEndProb: number;
}

export interface ProbPathHorizon {
  h: number;
  futureFan: boolean;
  sampleSize?: number;
  effectiveSampleSize?: number;
  shrinkageWeight?: number;
  pathRisk?: ProbPathRiskSummary | null;
  points: ProbPathQuantilePoint[];
}

export interface ProbPathCondition {
  bucket: string;
  score: number;
  bucketCount: number;
  similarAdded: number;
  method: 'bucket_then_similar' | 'fhs_bucket_similar_shrink';
}

export interface ProbPathBaseline {
  horizon: number;
  p50: number;
  sampleSize: number;
  label: string;
}

export interface ProbPathMeta {
  schemaVersion: typeof PROB_PATH_SCHEMA;
  asOf: string;
  spot: number;
  vol20dPct?: number | null;
  degraded: ProbPathDegraded;
  inSampleNote: string;
  gateHint: string | null;
  condition: ProbPathCondition;
  sampleSize: number;
  effectiveSampleSize?: number;
  shrinkageWeight?: number;
  structure: ProbPathStructureLevel[];
  history: ProbPathHistoryPoint[];
  horizons: Record<'5' | '20', ProbPathHorizon>;
  baseline: ProbPathBaseline | null;
  svgRel?: { path5d: string; path20d: string } | null;
}