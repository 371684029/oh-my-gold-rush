#!/usr/bin/env node
/**
 * GoldRush v2.6 — 历史老日报 .meta.json Sidecar 一次性回填脚本
 *
 * 为 docs/ 下所有尚未生成 .meta.json 的 goldrush-analysis-YYYY-MM-DD.md
 * 使用 web/report-extract.cjs + 统一阈值口径生成 schemaVersion: 1 契约，
 * 并显式标注 backfilledFromMarkdown: true 保持审计诚实性。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');

const { extractScore, extractQuantScore, extractQuantCoverage } = require('../web/report-extract.cjs');
const { REPORT_META_SCHEMA, metaPathForMarkdown } = require('../web/report-meta.cjs');

function scoreToDirection(score) {
  if (score >= 58) return 'bullish';
  if (score <= 42) return 'bearish';
  return 'neutral';
}

function extractConfidence(md) {
  const m = md.match(/数据置信度[：:]\s*(\d+)%/);
  return m ? parseInt(m[1], 10) : null;
}

function extractGate(md, confidence) {
  const sec = md.match(/##\s*[🚦\s]*数据质量门禁([\s\S]*?)(?=\n##\s|$)/);
  const body = sec ? sec[1] : md.slice(0, 1500);
  if (/🔴|门禁[：:]\s*红|数据不足|操作结论已关闭/.test(body)) {
    return { tier: 'red', actionable: false, overallConfidence: confidence ?? 30 };
  }
  if (/🟡|门禁[：:]\s*黄|数据存疑/.test(body)) {
    return { tier: 'yellow', actionable: true, overallConfidence: confidence ?? 60 };
  }
  if (/🟢|门禁[：:]\s*绿|数据可信/.test(body) || (confidence != null && confidence >= 70)) {
    return { tier: 'green', actionable: true, overallConfidence: confidence ?? 75 };
  }
  return { tier: 'yellow', actionable: true, overallConfidence: confidence ?? 60 };
}

function extractPosition(md) {
  const sec = md.match(/##\s*[📦\s]*当前仓位推荐([\s\S]*?)(?=\n##\s|$)/);
  if (!sec) return null;
  const body = sec[1];
  const pctM = body.match(/相对计划仓\s*\*{0,2}(\d+)%/);
  if (!pctM) return null;
  const targetPct = parseInt(pctM[1], 10);
  const labelM = body.match(/(极轻|偏轻|标配|偏积极|积极)/);
  const headlineM = body.match(/\*\*结论\*\*[：:]\s*(.+)/);
  const actionM = body.match(/\*\*操作\*\*[：:]\s*(.+)/);
  const tilt = targetPct <= 40 ? 'reduce' : targetPct >= 70 ? 'add' : 'hold';
  return {
    targetPct,
    label: labelM ? labelM[1] : (targetPct <= 30 ? '极轻' : targetPct <= 45 ? '偏轻' : targetPct <= 60 ? '标配' : targetPct <= 75 ? '偏积极' : '积极'),
    tilt,
    headline: headlineM ? headlineM[1].trim() : `建议相对计划仓 ${targetPct}%`,
    action: actionM ? actionM[1].trim() : `按相对计划仓 ${targetPct}% 分批执行`,
  };
}

function buildAdvice(score, direction, gate, dual, position) {
  if (gate && !gate.actionable) {
    return {
      source: 'gate',
      label: '数据不足',
      headline: '今日数据未过门禁，暂停依据结论调仓',
      action: '保持原定投计划，待数据恢复后再评估。',
    };
  }
  if (dual && dual.actionPolicy === 'hold_on_conflict') {
    const pctNote = position ? `目标仓位受限于 ${position.targetPct}%（${position.label}）` : '仓位上限 ≤50%';
    return {
      source: 'dual_conflict',
      label: '双分分歧',
      headline: `LLM(${dual.llmScore}) 与量化(${dual.quantScore}) 存在分歧，${pctNote}`,
      action: '双体系未共振，以定投为主、暂不追单。',
    };
  }
  if (position) {
    return {
      source: 'position',
      label: position.label,
      headline: position.headline,
      action: position.action,
    };
  }
  if (direction === 'bullish') {
    return {
      source: 'score',
      label: '偏多',
      headline: `综合分 ${score}/100 偏多`,
      action: '维持定投或逢回踩分批小额加仓，控制单次节奏。',
    };
  }
  if (direction === 'bearish') {
    return {
      source: 'score',
      label: '偏空',
      headline: `综合分 ${score}/100 偏空`,
      action: '暂缓主动加仓，仅保留极小额底仓定投观察。',
    };
  }
  return {
    source: 'score',
    label: '中性',
    headline: `综合分 ${score}/100 震荡中性`,
    action: '按原定投节奏持有观望，等待趋势明朗。',
  };
}

export function backfillReportMetaFiles(docsDir = DOCS_DIR) {
  const files = fs.readdirSync(docsDir)
    .filter(f => /^goldrush-analysis-\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();

  let created = 0;
  let skippedExisting = 0;
  let skippedUnparseable = 0;

  for (const filename of files) {
    const mdPath = path.join(docsDir, filename);
    const metaPath = metaPathForMarkdown(mdPath);
    if (fs.existsSync(metaPath)) {
      skippedExisting++;
      continue;
    }

    const md = fs.readFileSync(mdPath, 'utf-8');
    const scoreInfo = extractScore(md);
    if (!scoreInfo || typeof scoreInfo.score !== 'number') {
      skippedUnparseable++;
      continue;
    }

    const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : '';
    const direction = scoreInfo.direction || scoreToDirection(scoreInfo.score);
    const quant = extractQuantScore(md);
    const quantCoverage = extractQuantCoverage(md);
    const confidence = extractConfidence(md);
    const gate = extractGate(md, confidence);
    const position = extractPosition(md);

    let dual = null;
    if (quant && typeof quant.quantScore === 'number') {
      const delta = scoreInfo.score - quant.quantScore;
      const quantDir = scoreToDirection(quant.quantScore);
      const opposite = (direction === 'bullish' && quantDir === 'bearish') || (direction === 'bearish' && quantDir === 'bullish');
      const conflict = Math.abs(delta) > 15 || opposite;
      dual = {
        llmScore: scoreInfo.score,
        quantScore: quant.quantScore,
        delta,
        alignment: conflict ? 'conflict' : Math.abs(delta) > 8 ? 'mild_divergence' : 'aligned',
        actionPolicy: conflict ? 'hold_on_conflict' : Math.abs(delta) > 8 ? 'quant_preferred' : 'both',
      };
    }

    const advice = buildAdvice(scoreInfo.score, direction, gate, dual, position);
    const meta = {
      schemaVersion: REPORT_META_SCHEMA,
      date,
      generatedAt: new Date().toISOString(),
      backfilledFromMarkdown: true,
      score: scoreInfo.score,
      scoreLow: scoreInfo.low ?? null,
      scoreHigh: scoreInfo.high ?? null,
      direction,
      quantScore: quant?.quantScore ?? null,
      quantCoverage: quantCoverage ?? null,
      gate,
      dual,
      position,
      advice,
      short: {
        score: scoreInfo.score,
        direction,
      },
      mid: null,
      long: null,
    };

    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
    created++;
  }

  return { totalMd: files.length, created, skippedExisting, skippedUnparseable };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const res = backfillReportMetaFiles();
  console.log(`✅ Meta backfill complete: total=${res.totalMd}, created=${res.created}, existing=${res.skippedExisting}, unparseable=${res.skippedUnparseable}`);
}
