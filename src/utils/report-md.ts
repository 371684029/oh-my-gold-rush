// Markdown 投资日报格式化器
//
// 将一次 analysis 的完整报告渲染为人类可读的 Markdown「日报」，
// 用于 `goldrush analysis --md` 导出存档/分享。纯函数、无副作用、无 ANSI 颜色，
// 对 LLM 可能缺失的字段做了防御（缺失显示 N/A）。

import type { GoldAnalysisReport } from '../types/analysis.js';
import type { Horizon } from '../types/config.js';
import { buildScoreBreakdown, formatScoreBreakdownMarkdown } from './score-breakdown.js';
import { computeTailRiskIndex } from './tail-risk.js';
import { getConfig } from './config.js';
import type { MacroRegime } from './macro-regime.js';
import type { JudgeVerdict } from './judge-verdict.js';
import { formatJudgeVerdictMarkdown } from './judge-verdict.js';
import { formatLongTermOutlookMarkdown } from './long-term-outlook.js';
import { formatMidTermOutlookMarkdown, type MidTermOutlook } from './mid-term-outlook.js';
import { formatCausalChainsMarkdown } from './gold-causal-rules.js';
import type { LongTermOutlook } from '../types/analysis.js';
import type { PatternMatch } from '../types/calibration.js';
import type { ScoreBreakdown } from './score-breakdown.js';
import type { DataQualityGate } from './data-quality-gate.js';
import { formatDataQualityGateMarkdown } from './data-quality-gate.js';
import type { DualScoreVerdict } from './dual-score.js';
import { formatDualScoreMarkdown } from './dual-score.js';
import { formatQuantScoreMarkdown } from '../indicators/quant-score.js';
import type { PositionRecommendation } from './position-recommend.js';
import { formatPositionMarkdown } from './position-recommend.js';
import type { PredictionTrackStats } from './prediction-track.js';
import { formatPredictionTrackMarkdown } from './prediction-track.js';
import type { ReliabilityCard } from './reliability-card.js';
import { formatReliabilityMarkdown } from './reliability-card.js';
import type { ConsistencyCheck } from './plain-advice.js';
import { consistencyEmoji, resolveOperationalAdvice } from './plain-advice.js';
import type { DayDelta } from './day-delta.js';
import { formatDayDeltaMarkdown } from './day-delta.js';
import type { EventGoldTransmission } from './event-transmission.js';
import { formatTransmissionMarkdown } from './event-transmission.js';
import type { ReadingChecklist } from './reading-checklist.js';
import { formatReadingChecklistMarkdown } from './reading-checklist.js';
import type { ProbPathMeta } from './prob-path-types.js';
import { formatProbPathMarkdown } from './prob-path-md.js';

export interface ReportMarkdownExtras {
  macroRegime?: MacroRegime;
  judgeVerdict?: JudgeVerdict;
  similarPatterns?: PatternMatch[];
  scoreBreakdown?: ScoreBreakdown;
  longTermOutlook?: LongTermOutlook;
  midTermOutlook?: MidTermOutlook;
  dataQualityGate?: DataQualityGate;
  dualVerdict?: DualScoreVerdict;
  positionRec?: PositionRecommendation;
  predictionTrack?: PredictionTrackStats;
  reliabilityCard?: ReliabilityCard;
  consistency?: ConsistencyCheck;
  dayDelta?: DayDelta;
  transmission?: EventGoldTransmission;
  readingChecklist?: ReadingChecklist;
  probPath?: ProbPathMeta | null;
  probPathSvgs?: { svg5?: string; svg20?: string };
}

function dirText(d: string | undefined): string {
  switch (d) {
    case 'bullish': return '📈 偏多';
    case 'bearish': return '📉 偏空';
    case 'neutral': return '➡️ 中性';
    default: return d ?? 'N/A';
  }
}

function pct(v: number | null | undefined): string {
  return v == null ? 'N/A' : `${v}%`;
}

function na<T>(v: T | null | undefined): string {
  return v == null || v === '' ? 'N/A' : String(v);
}

function horizonText(h: Horizon): string {
  return h === 'short' ? '仅短期视角' : h === 'mid' ? '仅中长期视角' : '双视角（短期 + 中长期）';
}

/** 将完整分析报告渲染为 Markdown 日报 */
export function formatReportMarkdown(
  report: GoldAnalysisReport,
  horizon: Horizon = 'all',
  extras?: ReportMarkdownExtras,
): string {
  const { overall, technical, fundamental, sentiment, fund, rebuttal } = report;
  const tailRisks = report.tailRisks ?? rebuttal?.tailRisks ?? [];
  const lines: string[] = [];

  lines.push('# 🥇 GoldRush 黄金投资日报');
  lines.push('');
  lines.push(`> 生成时间：${na(report.timestamp)}　|　视角：${horizonText(horizon)}　|　数据置信度：${na(report.dataQuality?.overallConfidence)}%`);
  lines.push('');

  // 最前：必看清单 → 可信度 → 较昨日 → …
  const checklist = extras?.readingChecklist;
  if (checklist) {
    lines.push(formatReadingChecklistMarkdown(checklist));
  }

  const rel = extras?.reliabilityCard;
  if (rel) {
    lines.push(formatReliabilityMarkdown(rel));
  }

  const dayDelta = extras?.dayDelta;
  if (dayDelta) {
    lines.push(formatDayDeltaMarkdown(dayDelta));
  }

  const transmission = extras?.transmission;
  if (transmission) {
    lines.push(formatTransmissionMarkdown(transmission));
  }

  const dq = extras?.dataQualityGate;
  if (dq) {
    lines.push(formatDataQualityGateMarkdown(dq));
  }

  const dual = extras?.dualVerdict;
  if (dual) {
    lines.push(formatDualScoreMarkdown(dual));
  } else if (overall?.quantScore != null) {
    // 无 verdict 时仍展示双分摘要
    const d = (overall.score ?? 0) - overall.quantScore;
    lines.push('## ⚖️ 双打分机制（LLM × 量化）');
    lines.push('');
    lines.push(`- LLM：**${na(overall.score)}/100** · 量化：**${overall.quantScore}/100** · 偏差：${d > 0 ? '+' : ''}${d}`);
    lines.push('');
  }

  if (overall?.quantFactors) {
    lines.push(formatQuantScoreMarkdown(overall.quantFactors, overall.quantScore));
  }

  const pos = extras?.positionRec;
  if (pos) {
    lines.push(formatPositionMarkdown(pos));
  }

  if (extras?.probPath) {
    lines.push(formatProbPathMarkdown(extras.probPath, extras.probPathSvgs));
  }

  const predTrack = extras?.predictionTrack;
  if (predTrack) {
    lines.push(formatPredictionTrackMarkdown(predTrack));
  }

  const macro = extras?.macroRegime;
  if (macro) {
    lines.push('## 🌐 宏观阶段');
    lines.push('');
    lines.push(`- **${macro.label}**（\`${macro.tag}\`）`);
    lines.push(`- ${macro.description}`);
    if (macro.signals.length) {
      lines.push(`- 依据：${macro.signals.join('；')}`);
    }
    const cal = overall?.calibration;
    if (cal?.regimeTag && cal.regimeHistoricalAccuracy != null) {
      const pct = Math.round(cal.regimeHistoricalAccuracy * 100);
      const n = cal.regimeSampleSize ?? 0;
      lines.push(
        `- **同阶段校准**：\`${cal.regimeTag}\` 历史 5 日涨概率 **${pct}%**（样本 ${n}${cal.regimeSystematicBias ? `，${cal.regimeSystematicBias}` : ''}）`,
      );
    }
    lines.push('');
  }

  // 综合研判
  lines.push('## 综合研判');
  lines.push('');
  if (rel) {
    lines.push(`- 综合评分：**${rel.scoreBand.low}–${rel.scoreBand.high}/100**（中心 ${rel.scoreBand.center}，${dirText(overall?.direction)}）`);
  } else {
    lines.push(`- 综合评分：**${na(overall?.score)}/100**（${dirText(overall?.direction)}）`);
  }
  const cons = extras?.consistency;
  if (cons) {
    lines.push(`- ${consistencyEmoji(cons.level)} 维度一致性：${cons.summary}`);
  }
  // 统一操作建议（与 CLI / Web 同一优先级）
  const opAdvice = resolveOperationalAdvice({
    llmScore: overall?.score,
    direction: overall?.direction,
    dataActionable: dq?.actionable,
    dualActionOverride: dual?.actionOverride ?? null,
    dualPolicy: dual?.actionPolicy ?? null,
    position: pos
      ? {
          headline: pos.headline,
          action: pos.action,
          emoji: pos.emoji,
          label: pos.label,
          tilt: pos.tilt,
          targetPct: pos.targetPct,
        }
      : null,
  });
  if (opAdvice) {
    const srcTag =
      opAdvice.source === 'data_gate' ? '⛔ 数据门禁'
        : opAdvice.source === 'dual_conflict' ? '⚖️ 双分分歧'
          : opAdvice.source === 'position' ? '📦 仓位'
            : '💡 评分';
    lines.push(`- **操作建议**（${srcTag}）：${opAdvice.emoji} ${opAdvice.headline}`);
    lines.push(`- **操作**：${opAdvice.action}`);
  } else if (dq?.tier === 'yellow') {
    lines.push('- ⚠️ **降级可用**：建议结合量化分、CFTC 主力与置信度阅读操作建议');
  }
  const cal = overall?.calibration;
  if (cal && cal.historicalAccuracy != null) {
    const pct5 = Math.round(cal.historicalAccuracy * 100);
    const pct20 = cal.historicalAccuracy20d != null ? Math.round(cal.historicalAccuracy20d * 100) : null;
    const t20 = pct20 != null ? `，20日涨概率 ${pct20}%` : '';
    lines.push(`- 校准参考：${na(cal.scoreRange)} 区间 5日涨概率 ${pct5}%${t20}（${na(cal.systematicBias)}，样本 ${na(cal.sampleSize)}）`);
    if (cal.calibrationApplied && cal.calibrationOffset != null && cal.calibrationOffset !== 0) {
      lines.push(`- 数值校准：反驳后 ${cal.rawScore} 分 → 偏移 ${cal.calibrationOffset > 0 ? '+' : ''}${cal.calibrationOffset} → **展示 ${overall?.score} 分**（${na(cal.calibrationReason)}）`);
    }
  } else if (cal?.systematicBias === '样本不足') {
    lines.push(`- 校准参考：样本不足（${na(cal.sampleSize)} 条），分数未经统计修正`);
  }
  if (overall?.quantScore !== undefined) {
    const diff = (overall.score ?? 0) - overall.quantScore;
    const absDiff = Math.abs(diff);
    const diffLabel = diff > 0 ? `LLM偏高 +${absDiff}` : diff < 0 ? `LLM偏低 -${absDiff}` : '一致';
    const diffEmoji = diff > 5 ? '⚠️' : diff < -5 ? '✅' : '➡️';
    lines.push(`- 🔢 量化评分: **${overall.quantScore}/100** | LLM: ${na(overall.score)}/100 | ${diffEmoji} ${diffLabel}`);
  }
  lines.push('');

  if (report.causalChains?.length) {
    lines.push(...formatCausalChainsMarkdown(report.causalChains));
  }

  if (report.scenarioProbSource === 'historical') {
    lines.push(`> 情景概率已按历史相似日 5 日收益统计修正（叙述仍为 LLM 生成）。`);
    lines.push('');
  }

  if (technical && fundamental && sentiment && rebuttal) {
    const bd = extras?.scoreBreakdown ?? buildScoreBreakdown(technical, fundamental, sentiment, rebuttal);
    lines.push(...formatScoreBreakdownMarkdown(bd));
  }

  const judge = extras?.judgeVerdict;
  if (judge) {
    lines.push(...formatJudgeVerdictMarkdown(judge));
  }

  const patterns = extras?.similarPatterns;
  if (patterns && patterns.length > 0) {
    lines.push('## 📜 历史相似日');
    lines.push('');
    lines.push('| 日期 | 相似度 | 当时评分 | 5日后涨跌 |');
    lines.push('|------|--------|----------|-----------|');
    for (const p of patterns) {
      const ret = p.actual5dReturn != null ? `${p.actual5dReturn > 0 ? '+' : ''}${p.actual5dReturn.toFixed(2)}%` : '待回填';
      lines.push(`| ${p.date} | ${(p.similarity * 100).toFixed(0)}% | ${p.score} | ${ret} |`);
    }
    lines.push('');
  }

  // 情景分析
  const sc = overall?.scenarios;
  if (sc) {
    lines.push('## ⚡ 情景分析');
    lines.push('');
    lines.push('| 情景 | 概率 | 描述 | 操作 | 触发条件 |');
    lines.push('|------|------|------|------|----------|');
    lines.push(`| 基准 | ${pct(sc.base?.probability)} | ${na(sc.base?.description)} | ${na(sc.base?.action)} | - |`);
    lines.push(`| 上行 | ${pct(sc.upside?.probability)} | ${na(sc.upside?.description)} | ${na(sc.upside?.action)} | ${na(sc.upside?.trigger)} |`);
    lines.push(`| 下行 | ${pct(sc.downside?.probability)} | ${na(sc.downside?.description)} | ${na(sc.downside?.action)} | ${na(sc.downside?.trigger)} |`);
    lines.push('');
  }

  // 四维度摘要
  lines.push('## 📈 四维度摘要');
  lines.push('');
  lines.push('| 维度 | 评分 | 方向 | 摘要 |');
  lines.push('|------|------|------|------|');
  lines.push(`| 技术面 | ${na(technical?.score)}/100 | ${dirText(technical?.direction)} | ${na(technical?.summary)} |`);
  lines.push(`| 基本面 | ${na(fundamental?.score)}/100 | ${dirText(fundamental?.direction)} | ${na(fundamental?.summary)} |`);
  lines.push(`| 情绪面 | ${na(sentiment?.score)}/100 | ${dirText(sentiment?.direction)} | ${na(sentiment?.summary)} |`);
  lines.push(`| 基金面 | - | - | 估值水位：${na(fund?.valuation?.level)} |`);
  lines.push('');

  // 强制反驳
  if (rebuttal) {
    lines.push('## 🔴 强制反驳');
    lines.push('');
    lines.push(`- 反驳强度：**${na(rebuttal.rebuttalStrength)}**　|　看空力度：${na(rebuttal.bearScore)}/100`);
    for (const p of (rebuttal.bearPoints ?? []).slice(0, 5)) {
      lines.push(`  - 看空论据：${na(p.point)}（${pct(p.probability)} 概率）`);
    }
    for (const v of (rebuttal.bullVulnerabilities ?? []).slice(0, 3)) {
      lines.push(`  - 看多漏洞：${na(v.vulnerability)}`);
    }
    if (rebuttal.adjustedScore != null) {
      lines.push(`- 评分修正：调整为 **${rebuttal.adjustedScore} 分**（${na(rebuttal.netEffect)}）`);
    }
    lines.push('');
  }

  // 短期策略
  if (horizon !== 'mid' && overall?.shortTerm) {
    const s = overall.shortTerm;
    lines.push('## ⏱️ 短期策略（日线级别）');
    lines.push('');
    lines.push(`- 操作：${na(s.action)}`);
    lines.push(`- 入场区间：${na(s.entryZone)}`);
    lines.push(`- 目标：${na(s.target)}　|　止损：${na(s.stopLoss)}`);
    lines.push(`- 推荐品种：${na(s.recommendedProduct)}`);
    lines.push(`- ⚠️ 风险提示：${na(s.riskWarning)}`);
    lines.push('');
  }

  // 中长期策略
  if (horizon !== 'short' && overall?.midTerm) {
    const m = overall.midTerm;
    lines.push('## 📅 中长期策略（周线级别）');
    lines.push('');
    lines.push(`- 定投建议：${na(m.investAdvice?.dipInvest)}　|　仓位调整：${na(m.investAdvice?.positionAdjust)}`);
    lines.push(`- 推荐基金：${na(m.investAdvice?.recommendedFund)}`);
    lines.push(`- 支撑区：${na(m.keyLevels?.supportZone)}　|　阻力区：${na(m.keyLevels?.resistanceZone)}`);
    lines.push(`- ⚠️ 风险提示：${na(m.riskWarning)}`);
    lines.push('');
  }

  const midTerm = extras?.midTermOutlook ?? report.midTermOutlook;
  if (midTerm) {
    lines.push(formatMidTermOutlookMarkdown(midTerm));
  }

  const longTerm = extras?.longTermOutlook ?? report.longTermOutlook;
  if (longTerm) {
    lines.push(formatLongTermOutlookMarkdown(longTerm));
  }

  // 尾部风险
  if (tailRisks.length > 0) {
    lines.push('## ⚠️ 尾部风险');
    lines.push('');
    lines.push('| 概率 | 风险 | 影响 | 触发条件 | 对冲建议 |');
    lines.push('|------|------|------|----------|----------|');
    for (const r of tailRisks) {
      lines.push(`| ${pct(r.probability)} | ${na(r.risk)} | ${na(r.impact)} | ${na(r.trigger)} | ${na(r.mitigation)} |`);
    }
    const maxCap = getConfig().investment.maxTailRiskIndex * 2.5;
    const { index, rawUnion } = computeTailRiskIndex(tailRisks, maxCap);
    lines.push('');
    lines.push(`综合尾部风险指数：**${index.toFixed(1)}%**`);
    if (rawUnion - index > 5) {
      lines.push(`> 注：朴素并概率 ${rawUnion.toFixed(1)}%，已做互斥修正`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('> 本报告由 GoldRush 自动生成，仅供投资研究参考，**不构成投资建议**。');
  lines.push('');

  return lines.join('\n');
}
