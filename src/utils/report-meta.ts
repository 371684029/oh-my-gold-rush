// 日报结构化 sidecar — 给 Web 用的机器可读契约
//
// server.cjs 原先只靠正则解析 Markdown。版式一改（区间评分、表头增减）就会静默
// 丢决策面板。analysis 写 MD 时同步写出同名 .meta.json，Web 优先读它，
// 解析失败再回落 MD 正则。schemaVersion 变更时旧 sidecar 直接忽略。

import fs from 'node:fs';
import path from 'node:path';
import type { Direction, GoldAnalysisReport, LongTermOutlook } from '../types/analysis.js';
import type { MidTermOutlook } from './mid-term-outlook.js';
import type { DualScoreVerdict } from './dual-score.js';
import type { DataQualityGate } from './data-quality-gate.js';
import type { PositionRecommendation } from './position-recommend.js';
import type { ReliabilityCard } from './reliability-card.js';
import { resolveOperationalAdvice } from './plain-advice.js';
import type { ProbPathMeta } from './prob-path-types.js';

export const REPORT_META_SCHEMA = 1 as const;

export interface ReportMetaHorizon {
  label: string;
  direction: Direction;
  score: number;
  confidence?: string | null;
  stance?: string | null;
}

export interface ReportMetaDimensionSummary {
  code: 'B1' | 'B2' | 'B3' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5';
  category: 'base' | 'specialized';
  title: string;
  score: number | null;
  direction: Direction;
  coverage: number;
  summary: string;
}

export interface ReportMeta {
  schemaVersion: typeof REPORT_META_SCHEMA;
  date: string;
  generatedAt: string;
  score: number;
  direction: Direction;
  scoreLow: number | null;
  scoreHigh: number | null;
  quantScore: number | null;
  quantCoverage: number | null;
  midTermScore: number | null;
  position: {
    targetPct: number;
    label: string;
    tilt: string;
    headline: string;
    action: string;
  } | null;
  advice: {
    label: string;
    headline: string;
    action: string;
    source: string;
  } | null;
  gate: {
    tier: string;
    actionable: boolean;
    overallConfidence: number;
  } | null;
  dual: {
    alignment: string;
    delta: number | null;
    actionPolicy: string;
    llmScore: number;
    quantScore: number | null;
  } | null;
  reliability: {
    score: number;
    level: string;
  } | null;
  short: ReportMetaHorizon;
  mid: ReportMetaHorizon | null;
  long: ReportMetaHorizon | null;
  midTerm: MidTermOutlook | null;
  longTerm: LongTermOutlook | null;
  /** 概率路径扇形（可选，v1 扩展） */
  probPath?: ProbPathMeta | null;
  /** 八维全景评分摘要（三基 + 五专，v2.4 可选扩展） */
  dimensions?: Record<string, ReportMetaDimensionSummary> | null;
}

export interface BuildReportMetaInput {
  report: GoldAnalysisReport;
  dualVerdict?: DualScoreVerdict | null;
  dataQualityGate?: DataQualityGate | null;
  positionRec?: PositionRecommendation | null;
  reliabilityCard?: ReliabilityCard | null;
  scoreLow?: number | null;
  scoreHigh?: number | null;
  probPath?: ProbPathMeta | null;
}

export function buildReportMeta(input: BuildReportMetaInput): ReportMeta {
  const { report, dualVerdict, dataQualityGate, positionRec, reliabilityCard } = input;
  const date = report.timestamp.slice(0, 10);
  const score = report.overall.score;
  const direction = report.overall.direction;

  const advice = resolveOperationalAdvice({
    dataActionable: dataQualityGate?.actionable,
    dualPolicy: dualVerdict?.actionPolicy,
    dualActionOverride: dualVerdict?.actionOverride,
    position: positionRec
      ? {
          label: positionRec.label,
          emoji: positionRec.emoji,
          headline: positionRec.headline,
          action: positionRec.action,
          targetPct: positionRec.targetPct,
          tilt: positionRec.tilt,
        }
      : null,
    llmScore: score,
    direction,
  });

  const midPrimary = report.midTermOutlook?.horizons?.find(h => h.months === 3)
    ?? report.midTermOutlook?.horizons?.[0]
    ?? null;
  const longPrimary = report.longTermOutlook?.horizons?.find(h => h.years === 3)
    ?? report.longTermOutlook?.horizons?.[0]
    ?? null;

  return {
    schemaVersion: REPORT_META_SCHEMA,
    date,
    generatedAt: new Date().toISOString(),
    score,
    direction,
    scoreLow: input.scoreLow ?? null,
    scoreHigh: input.scoreHigh ?? null,
    quantScore: report.overall.quantScore ?? null,
    quantCoverage: report.overall.quantCoverage ?? null,
    midTermScore: report.midTermOutlook?.score ?? null,
    position: positionRec
      ? {
          targetPct: positionRec.targetPct,
          label: positionRec.label,
          tilt: positionRec.tilt,
          headline: positionRec.headline,
          action: positionRec.action,
        }
      : null,
    advice: advice
      ? {
          label: advice.label,
          headline: advice.headline,
          action: advice.action,
          source: advice.source,
        }
      : null,
    gate: dataQualityGate
      ? {
          tier: dataQualityGate.tier,
          actionable: dataQualityGate.actionable,
          overallConfidence: dataQualityGate.overallConfidence,
        }
      : null,
    dual: dualVerdict
      ? {
          alignment: dualVerdict.alignment,
          delta: dualVerdict.delta,
          actionPolicy: dualVerdict.actionPolicy,
          llmScore: dualVerdict.llmScore,
          quantScore: dualVerdict.quantScore,
        }
      : null,
    reliability: reliabilityCard
      ? { score: reliabilityCard.score, level: reliabilityCard.tier }
      : null,
    short: {
      label: '短期',
      direction,
      score,
      confidence: null,
      stance: positionRec ? `建议仓位 ${positionRec.targetPct}%` : null,
    },
    mid: midPrimary
      ? {
          label: midPrimary.label,
          direction: midPrimary.direction,
          score: midPrimary.biasScore,
          confidence: midPrimary.confidence,
          stance: midPrimary.stance === 'add' ? '可加仓'
            : midPrimary.stance === 'reduce' ? '宜减仓' : '维持',
        }
      : null,
    long: longPrimary
      ? {
          label: longPrimary.label,
          direction: longPrimary.direction,
          score: longPrimary.biasScore,
          confidence: longPrimary.confidence,
          stance: longPrimary.allocationStance === 'overweight' ? '偏积极'
            : longPrimary.allocationStance === 'underweight' ? '偏谨慎' : '中性',
        }
      : null,
    midTerm: report.midTermOutlook ?? null,
    longTerm: report.longTermOutlook ?? null,
    probPath: input.probPath ?? null,
    dimensions: report.dimensions
      ? Object.fromEntries(
          Object.entries(report.dimensions).map(([k, d]) => [
            k,
            {
              code: d.code,
              category: d.category,
              title: d.title,
              score: d.score,
              direction: d.direction,
              coverage: d.coverage,
              summary: d.summary,
            },
          ]),
        )
      : null,
  };
}

/** 与 MD 同目录：goldrush-analysis-YYYY-MM-DD.meta.json */
export function metaPathForMarkdown(mdPath: string): string {
  return mdPath.replace(/\.md$/i, '.meta.json');
}

export function saveReportMeta(mdPath: string, meta: ReportMeta): string {
  const out = metaPathForMarkdown(mdPath);
  const dir = path.dirname(out);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(out, JSON.stringify(meta, null, 2), 'utf-8');
  return out;
}

export function loadReportMeta(mdPathOrMetaPath: string): ReportMeta | null {
  const metaPath = mdPathOrMetaPath.endsWith('.meta.json')
    ? mdPathOrMetaPath
    : metaPathForMarkdown(mdPathOrMetaPath);
  if (!fs.existsSync(metaPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ReportMeta;
    if (raw?.schemaVersion !== REPORT_META_SCHEMA) return null;
    if (typeof raw.score !== 'number' || !raw.direction) return null;
    return raw;
  } catch {
    return null;
  }
}
