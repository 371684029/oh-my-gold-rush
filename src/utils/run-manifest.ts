// 分析运行审计包 — 每次 analysis 可追溯

import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import type { GoldAnalysisReport } from '../types/analysis.js';
import type { ScoreBreakdown } from './score-breakdown.js';
import type { MacroRegime } from './macro-regime.js';
import type { PatternMatch } from '../types/calibration.js';
import type { JudgeVerdict } from './judge-verdict.js';
import type { Horizon } from '../types/config.js';

export const JSON_SCHEMA_VERSION = 1 as const;

export interface RunManifest {
  runId: string;
  date: string;
  horizon: Horizon;
  startedAt: string;
  completedAt: string;
  /** 实际生效模型：null = 继承 opencode CLI 默认模型 */
  model: { providerID: string; modelID: string } | null;
  dataConfidence: number;
  validationWarnings: string[];
  scoreBreakdown: ScoreBreakdown;
  macroRegime: MacroRegime;
  judgeVerdict: JudgeVerdict;
  similarPatterns: PatternMatch[];
  longTermOutlook?: import('../types/analysis.js').LongTermOutlook;
  goldrushVersion: string;
}

/** 结构化 JSON 输出（schema v1） */
export interface AnalysisOutputV1 {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  manifest: RunManifest;
  report: GoldAnalysisReport;
}

export function buildRunManifest(params: {
  horizon: Horizon;
  startedAt: string;
  report: GoldAnalysisReport;
  scoreBreakdown: ScoreBreakdown;
  macroRegime: MacroRegime;
  judgeVerdict: JudgeVerdict;
  similarPatterns: PatternMatch[];
  longTermOutlook?: import('../types/analysis.js').LongTermOutlook;
}): RunManifest {
  const cfg = getConfig();
  return {
    runId: `goldrush-${params.report.timestamp.slice(0, 10)}-${Date.now()}`,
    date: params.report.timestamp.slice(0, 10),
    horizon: params.horizon,
    startedAt: params.startedAt,
    completedAt: new Date().toISOString(),
    model: cfg.model ? { ...cfg.model } : null,
    dataConfidence: params.report.dataQuality?.overallConfidence ?? 0,
    validationWarnings: params.report.dataQuality?.warnings ?? [],
    scoreBreakdown: params.scoreBreakdown,
    macroRegime: params.macroRegime,
    judgeVerdict: params.judgeVerdict,
    similarPatterns: params.similarPatterns,
    longTermOutlook: params.report.longTermOutlook,
    goldrushVersion: '0.1.0',
  };
}

export function wrapAnalysisOutputV1(manifest: RunManifest, report: GoldAnalysisReport): AnalysisOutputV1 {
  return { schemaVersion: JSON_SCHEMA_VERSION, manifest, report };
}

/** 写入 data/manifests/goldrush-manifest-YYYY-MM-DD.json */
export function saveRunManifest(manifest: RunManifest): string {
  const dir = path.resolve(process.cwd(), 'data', 'manifests');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = path.join(dir, `goldrush-manifest-${manifest.date}.json`);
  fs.writeFileSync(filename, JSON.stringify(manifest, null, 2), 'utf-8');
  return filename;
}
