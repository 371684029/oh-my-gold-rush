/**
 * 日报 sidecar 读取 — 与 src/utils/report-meta.ts 写出的 .meta.json 对齐。
 * schemaVersion 不匹配时返回 null，调用方回落 MD 正则。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPORT_META_SCHEMA = 1;

function metaPathForMarkdown(mdPath) {
  return String(mdPath).replace(/\.md$/i, '.meta.json');
}

function loadReportMeta(mdPathOrMetaPath) {
  const metaPath = String(mdPathOrMetaPath).endsWith('.meta.json')
    ? mdPathOrMetaPath
    : metaPathForMarkdown(mdPathOrMetaPath);
  if (!fs.existsSync(metaPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    if (raw?.schemaVersion !== REPORT_META_SCHEMA) return null;
    if (typeof raw.score !== 'number' || !raw.direction) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 把 sidecar 转成 server.cjs extractScore 兼容形态 */
function scoreInfoFromMeta(meta) {
  if (!meta) return null;
  return {
    score: meta.score,
    direction: meta.direction,
    low: meta.scoreLow ?? null,
    high: meta.scoreHigh ?? null,
    isBand: meta.scoreLow != null && meta.scoreHigh != null,
  };
}

function quantInfoFromMeta(meta) {
  if (!meta || meta.quantScore == null) return null;
  return {
    quantScore: meta.quantScore,
    llmScore: meta.score,
    diff: meta.dual?.delta ?? null,
    coverage: meta.quantCoverage,
  };
}

function positionFromMeta(meta) {
  if (!meta?.position) return null;
  return {
    targetPct: meta.position.targetPct,
    label: meta.position.label,
    tilt: meta.position.tilt,
    headline: meta.position.headline,
    action: meta.position.action,
  };
}

function adviceFromMeta(meta) {
  if (!meta?.advice) return null;
  return {
    label: meta.advice.label,
    headline: meta.advice.headline,
    action: meta.advice.action,
    source: meta.advice.source,
    emoji: meta.direction === 'bullish' ? '📈' : meta.direction === 'bearish' ? '📉' : '➡️',
  };
}

function gateFromMeta(meta) {
  if (!meta?.gate) return null;
  const tier = meta.gate.tier;
  const emoji = tier === 'green' ? '🟢' : tier === 'yellow' ? '🟡' : '🔴';
  const label = tier === 'green' ? '数据可信' : tier === 'yellow' ? '数据存疑' : '数据不足';
  return {
    tier,
    actionable: meta.gate.actionable,
    // 与 extractDataQualityGate 的形状对齐：confidence 命名 + notes 数组（meta 不携带则空）
    confidence: meta.gate.overallConfidence ?? null,
    notes: [],
    emoji,
    label,
  };
}

function dualFromMeta(meta) {
  if (!meta?.dual) return null;
  return {
    llm: meta.dual.llmScore,
    quant: meta.dual.quantScore,
    delta: meta.dual.delta,
    conflict: meta.dual.actionPolicy === 'hold_on_conflict'
      || meta.dual.alignment === 'conflict',
    alignment: meta.dual.alignment,
    actionPolicy: meta.dual.actionPolicy,
  };
}

/**
 * 用 sidecar 驱动三期决策条视图；缺字段时返回 null，调用方回落 MD 解析。
 */
function horizonViewFromMeta(meta) {
  if (!meta?.short) return null;
  return {
    short: {
      horizon: 'short',
      title: '短期',
      subtitle: '约 5 个交易日',
      direction: meta.short.direction,
      score: meta.short.score,
      band: meta.scoreLow != null && meta.scoreHigh != null
        ? `${meta.scoreLow}–${meta.scoreHigh}`
        : null,
      positionPct: meta.position?.targetPct ?? null,
      positionLabel: meta.position?.label ?? null,
    },
    mid: meta.mid
      ? {
          horizon: 'mid',
          title: '中期',
          subtitle: '1～3 个月',
          direction: meta.mid.direction,
          score: meta.mid.score,
          confidence: meta.mid.confidence,
          stance: meta.mid.stance,
          rows: meta.midTerm?.horizons ?? [],
        }
      : null,
    long: meta.long
      ? {
          horizon: 'long',
          title: '长期',
          subtitle: '1 / 3 / 5 年',
          direction: meta.long.direction,
          score: meta.long.score,
          confidence: meta.long.confidence,
          stance: meta.long.stance,
          rows: meta.longTerm?.horizons ?? [],
        }
      : null,
  };
}

module.exports = {
  REPORT_META_SCHEMA,
  metaPathForMarkdown,
  loadReportMeta,
  scoreInfoFromMeta,
  quantInfoFromMeta,
  positionFromMeta,
  adviceFromMeta,
  gateFromMeta,
  dualFromMeta,
  horizonViewFromMeta,
};
