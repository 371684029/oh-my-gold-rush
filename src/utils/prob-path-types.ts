// 概率路径扇形图 — 类型与契约常量

export const PROB_PATH_SCHEMA = 1 as const;

export const PROB_PATH_TARGET_SAMPLE = 30;
export const PROB_PATH_MIN_SAMPLE = 10;
export const PROB_PATH_HISTORY_DAYS = 60;
export const PROB_PATH_MAX_SIMILAR = 100;
export const PROB_PATH_MAX_SAMPLE_PATHS = 200;

export type ProbPathDegraded = 'full' | 'sparse' | 'history_only' | 'no_spot';

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
  p50: number;
  p90: number;
}

export interface ProbPathHorizon {
  h: number;
  futureFan: boolean;
  points: ProbPathQuantilePoint[];
}

export interface ProbPathCondition {
  bucket: string;
  score: number;
  bucketCount: number;
  similarAdded: number;
  method: 'bucket_then_similar';
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
  degraded: ProbPathDegraded;
  inSampleNote: string;
  gateHint: string | null;
  condition: ProbPathCondition;
  sampleSize: number;
  structure: ProbPathStructureLevel[];
  history: ProbPathHistoryPoint[];
  horizons: Record<'5' | '20', ProbPathHorizon>;
  baseline: ProbPathBaseline | null;
  svgRel?: { path5d: string; path20d: string } | null;
}