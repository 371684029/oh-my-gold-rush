// 历史预测对错统计 — 基于 analysis_reports + gold_prices
//
// 写入 docs/goldrush-stats-latest.json 供 Web 展示；日报 MD 嵌入摘要表

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { ReportsRepo } from '../db/reports.js';
import { GoldPricesRepo } from '../db/gold-prices.js';
import { CalibrationRepo } from '../db/calibration.js';
import { SCORE_BUCKETS } from './score-buckets.js';
import { DUAL_CONFLICT_THRESHOLD } from './dual-score.js';
import { forwardReturnPct, validClose } from './forward-return.js';
import {
  predictDirectionFromScore,
  isHit,
  classifyReturn,
  wilsonInterval,
  wilsonIntervalHac,
  effectiveSampleSizeOverlap,
  beatsBaseline,
  formatHitRate,
  HIT_RULE_TEXT,
  MIN_HITRATE_SAMPLE,
} from './decision-thresholds.js';

export interface PredictionRecentRow {
  date: string;
  llmScore: number;
  quantScore: number | null;
  direction: string;
  pred: 'up' | 'down' | 'flat';
  actual5dPct: number | null;
  hit: boolean | null; // null = 未回填/持平不计
  status: 'hit' | 'miss' | 'pending' | 'flat';
  /**
   * 顺预测幅度（%）：预测涨则取实际涨幅；预测跌则取 -实际涨幅。
   * 正=价格朝预测方向走；负=逆预测。持平/待回填为 null。
   */
  alignPct: number | null;
  /** 同评分区间历史 5 日均涨幅（%），用于「相对同档偏差」 */
  bucketAvgReturn: number | null;
  /** 本日实际 − 同档均值（百分点） */
  vsBucketPct: number | null;
  /** 量化方向预测（有 quant_score 时） */
  quantPred: 'up' | 'down' | 'flat' | null;
  quantHit: boolean | null;
  quantStatus: 'hit' | 'miss' | 'pending' | 'flat' | null;
}

export interface PredictionBucketStat {
  range: string;
  sample: number;
  upRate: number; // 0-100
  avgReturn: number;
}

export interface HitStat {
  hits: number;
  total: number;
  /** 0-100；样本为 0 时为 null */
  hitRate: number | null;
  /** Wilson 95% 置信区间下界（0-100） */
  ciLow: number | null;
  /** Wilson 95% 置信区间上界（0-100） */
  ciHigh: number | null;
  /** F16: 重叠窗口 HAC 修正 95% 置信区间下界（0-100） */
  ciLowHac?: number | null;
  /** F16: 重叠窗口 HAC 修正 95% 置信区间上界（0-100） */
  ciHighHac?: number | null;
  /** F16: 重叠窗口等效独立样本数 */
  effectiveN?: number;
  /** 样本量是否达到可解读门槛 */
  significant: boolean;
  /** 是否在 95% 置信度下跑赢「永远看涨」基准 */
  beatsBaseline: boolean;
}

export interface PredictionTrackStats {
  asOf: string;
  windowDays: number;
  sampleEligible: number;
  llm: HitStat;
  quant: HitStat;
  /**
   * 中期方向命中（mid_term_score → 20 个交易日）。
   * 样本不足时 hitRate 为 null，文案会说明「待积累」。
   */
  midTerm: HitStat;
  /** 中期标签用的交易日数（默认 20） */
  midTermHorizonDays: number;
  /** F16: 每隔 T 个交易日抽样的非重叠独立命中统计 */
  nonOverlapping?: {
    stepDays: number;
    llm: HitStat;
    quant: HitStat;
  };
  /**
   * 「永远看涨」的朴素基准命中率（0-100）。
   * 黄金长期偏多头，不跟基准比就无法判断模型是有信息量还是只是蹭了趋势。
   */
  baselineUpRate: number | null;
  baselineN: number;
  /** 高分段(≥60) 实际 5 日涨概率 */
  highScoreUpRate: number | null;
  highScoreN: number;
  /** 低分段(≤40) 实际 5 日涨概率 */
  lowScoreUpRate: number | null;
  lowScoreN: number;
  conflictDays: number;
  conflictFollowQuantHits: number;
  conflictFollowLlmHits: number;
  buckets: PredictionBucketStat[];
  recent: PredictionRecentRow[];
  summary: string;
}

function toHitStat(
  hits: number,
  total: number,
  baseline: number | null,
  horizonDays = 5,
): HitStat {
  if (total <= 0) {
    return {
      hits,
      total,
      hitRate: null,
      ciLow: null,
      ciHigh: null,
      ciLowHac: null,
      ciHighHac: null,
      effectiveN: 0,
      significant: false,
      beatsBaseline: false,
    };
  }
  const [lo, hi] = wilsonInterval(hits, total);
  const [loHac, hiHac] = wilsonIntervalHac(hits, total, horizonDays);
  const effN = effectiveSampleSizeOverlap(total, horizonDays);
  return {
    hits,
    total,
    hitRate: Math.round((hits / total) * 1000) / 10,
    ciLow: Math.round(lo * 1000) / 10,
    ciHigh: Math.round(hi * 1000) / 10,
    ciLowHac: Math.round(loHac * 1000) / 10,
    ciHighHac: Math.round(hiHac * 1000) / 10,
    effectiveN: effN,
    significant: total >= MIN_HITRATE_SAMPLE,
    beatsBaseline: beatsBaseline(hits, total, baseline ?? 0.5),
  };
}

function futureReturn(
  prices: GoldPricesRepo,
  date: string,
  T: number,
): number | null {
  // 与 factor-ic / calibration 同一口径；窗口不足 T 天时允许部分窗口，
  // 以便最近几天的报告也能先给出方向反馈
  return forwardReturnPct(prices, date, T, { allowPartial: true, minPartialDays: 3 });
}

export function buildPredictionTrackStats(
  db: Database.Database,
  windowDays = 90,
  T = 5,
): PredictionTrackStats {
  const reports = new ReportsRepo(db);
  const prices = new GoldPricesRepo(db);
  const cal = new CalibrationRepo(db);

  // 复用已有双重命中统计（已排除红档/无效价）
  const dual = cal.computeDualTrackHitStats(windowDays, T);
  const llmHitRate = dual.llmTotal > 0 ? dual.llmHits / dual.llmTotal : null;
  const quantHitRate = dual.quantTotal > 0 ? dual.quantHits / dual.quantTotal : null;

  // 分桶（LLM）
  const eligible = reports.getRecent(windowDays).filter(r => {
    const p = prices.getByDate(r.date);
    return validClose(p?.londonClose);
  });

  const buckets: PredictionBucketStat[] = [];
  for (const { range, min, max } of SCORE_BUCKETS) {
    const isLast = max === 100;
    const matching = eligible.filter(r =>
      r.overallScore >= min && (isLast ? r.overallScore <= max : r.overallScore < max),
    );
    let up = 0;
    let sum = 0;
    let n = 0;
    for (const r of matching) {
      const ret = futureReturn(prices, r.date, T);
      if (ret == null) continue;
      n++;
      sum += ret;
      if (ret > 0) up++;
    }
    if (n === 0) continue;
    buckets.push({
      range,
      sample: n,
      upRate: Math.round((up / n) * 1000) / 10,
      avgReturn: Math.round((sum / n) * 100) / 100,
    });
  }

  // 高/低分段涨概率
  let highUp = 0, highN = 0, lowUp = 0, lowN = 0;
  for (const r of eligible) {
    const ret = futureReturn(prices, r.date, T);
    if (ret == null) continue;
    if (r.overallScore >= 60) {
      highN++;
      if (ret > 0) highUp++;
    }
    if (r.overallScore <= 40) {
      lowN++;
      if (ret > 0) lowUp++;
    }
  }

  // 全窗明细（供 Web 列表按日挂对错；MD/控制台仍只展示近若干条）
  const bucketAvgByRange = new Map(buckets.map(b => [b.range, b.avgReturn]));
  const recent: PredictionRecentRow[] = [];
  for (const r of eligible) {
    const ret = futureReturn(prices, r.date, T);
    const predDir = predictDirectionFromScore(r.overallScore);
    let pred: PredictionRecentRow['pred'] = 'flat';
    if (predDir === 'up') pred = 'up';
    else if (predDir === 'down') pred = 'down';

    let status: PredictionRecentRow['status'] = 'pending';
    let hit: boolean | null = null;
    if (ret == null) {
      status = 'pending';
    } else {
      hit = isHit(predDir, ret);
      status = hit == null ? 'flat' : hit ? 'hit' : 'miss';
    }

    let alignPct: number | null = null;
    if (ret != null && pred === 'up') alignPct = Math.round(ret * 100) / 100;
    else if (ret != null && pred === 'down') alignPct = Math.round((-ret) * 100) / 100;

    const bucketRange = SCORE_BUCKETS.find(({ min, max }) => {
      const isLast = max === 100;
      return r.overallScore >= min && (isLast ? r.overallScore <= max : r.overallScore < max);
    })?.range ?? null;
    const bucketAvgReturn = bucketRange != null
      ? (bucketAvgByRange.get(bucketRange) ?? null)
      : null;
    const vsBucketPct = ret != null && bucketAvgReturn != null
      ? Math.round((ret - bucketAvgReturn) * 100) / 100
      : null;

    let quantPred: PredictionRecentRow['quantPred'] = null;
    let quantHit: boolean | null = null;
    let quantStatus: PredictionRecentRow['quantStatus'] = null;
    if (r.quantScore != null) {
      const qDir = predictDirectionFromScore(r.quantScore);
      quantPred = qDir === 'up' ? 'up' : qDir === 'down' ? 'down' : 'flat';
      if (ret == null) {
        quantStatus = 'pending';
      } else {
        quantHit = isHit(qDir, ret);
        quantStatus = quantHit == null ? 'flat' : quantHit ? 'hit' : 'miss';
      }
    }

    recent.push({
      date: r.date,
      llmScore: r.overallScore,
      quantScore: r.quantScore,
      direction: r.direction,
      pred,
      actual5dPct: ret != null ? Math.round(ret * 100) / 100 : null,
      hit,
      status,
      alignPct,
      bucketAvgReturn,
      vsBucketPct,
      quantPred,
      quantHit,
      quantStatus,
    });
  }

  // 「永远看涨」基准：同一批可评估日里实际上涨的比例（持平不计入）
  let baselineUp = 0;
  let baselineN = 0;
  for (const r of eligible) {
    const ret = futureReturn(prices, r.date, T);
    if (ret == null) continue;
    const cls = classifyReturn(ret);
    if (cls === 'flat') continue;
    baselineN++;
    if (cls === 'up') baselineUp++;
  }
  const baselineRate = baselineN > 0 ? baselineUp / baselineN : null;

  const llmStat = toHitStat(dual.llmHits, dual.llmTotal, baselineRate, T);
  const quantStat = toHitStat(dual.quantHits, dual.quantTotal, baselineRate, T);

  // F16: 按步长 T 抽样非重叠独立样本（消除逐日 T 天重叠窗口的自相关）
  const sortedAsc = [...eligible].sort((a, b) => a.date.localeCompare(b.date));
  let noLlmHits = 0; let noLlmTotal = 0;
  let noQuantHits = 0; let noQuantTotal = 0;
  const step = Math.max(1, T);
  for (let i = 0; i < sortedAsc.length; i += step) {
    const r = sortedAsc[i];
    const ret = forwardReturnPct(prices, r.date, T, { allowPartial: false });
    if (ret == null) continue;
    const lHit = isHit(predictDirectionFromScore(r.overallScore), ret);
    if (lHit != null) {
      noLlmTotal++;
      if (lHit) noLlmHits++;
    }
    if (r.quantScore != null) {
      const qHit = isHit(predictDirectionFromScore(r.quantScore), ret);
      if (qHit != null) {
        noQuantTotal++;
        if (qHit) noQuantHits++;
      }
    }
  }
  const nonOverlapping = {
    stepDays: step,
    llm: toHitStat(noLlmHits, noLlmTotal, baselineRate, 1),
    quant: toHitStat(noQuantHits, noQuantTotal, baselineRate, 1),
  };

  // 中期：mid_term_score → 20 个交易日方向，与短期 5 日分轨
  const MID_T = 20;
  let midHits = 0;
  let midTotal = 0;
  let midBaselineUp = 0;
  let midBaselineN = 0;
  for (const r of eligible) {
    if (r.midTermScore == null || !Number.isFinite(r.midTermScore)) continue;
    // 中期窗口不允许部分凑合：不足 20 日就不计，避免和短期混窗
    const full = forwardReturnPct(prices, r.date, MID_T, { allowPartial: false });
    if (full == null) continue;
    const cls = classifyReturn(full);
    if (cls === 'flat') continue;
    midBaselineN++;
    if (cls === 'up') midBaselineUp++;
    const hit = isHit(predictDirectionFromScore(r.midTermScore), full);
    if (hit == null) continue;
    midTotal++;
    if (hit) midHits++;
  }
  const midBaseline = midBaselineN > 0 ? midBaselineUp / midBaselineN : baselineRate;
  const midStat = toHitStat(midHits, midTotal, midBaseline, MID_T);

  const parts: string[] = [];
  parts.push(`LLM 方向命中 ${formatHitRate(dual.llmHits, dual.llmTotal, baselineRate ?? undefined)}`);
  parts.push(`量化命中 ${formatHitRate(dual.quantHits, dual.quantTotal, baselineRate ?? undefined)}`);
  if (midTotal > 0) {
    parts.push(`中期(${MID_T}日)命中 ${formatHitRate(midHits, midTotal, midBaseline ?? undefined)}`);
  } else {
    parts.push(`中期(${MID_T}日)命中 待积累 mid_term_score`);
  }
  if (baselineRate != null) {
    parts.push(`永远看涨基准 ${(baselineRate * 100).toFixed(0)}%（${baselineUp}/${baselineN}）`);
  }
  if (highN >= 3) {
    parts.push(`高分段(≥60) 5日涨 ${(highUp / highN * 100).toFixed(0)}%`);
  }
  if (lowN >= 3) {
    parts.push(`低分段(≤40) 5日涨 ${(lowUp / lowN * 100).toFixed(0)}%`);
  }
  if (dual.conflictDays > 0) {
    parts.push(`冲突日 ${dual.conflictDays}（跟量化 ${dual.conflictFollowQuantHits} / 跟LLM ${dual.conflictFollowLlmHits}）`);
  }

  return {
    asOf: new Date().toISOString().slice(0, 10),
    windowDays,
    sampleEligible: eligible.length,
    llm: llmStat,
    quant: quantStat,
    midTerm: midStat,
    midTermHorizonDays: MID_T,
    nonOverlapping,
    baselineUpRate: baselineRate != null ? Math.round(baselineRate * 1000) / 10 : null,
    baselineN,
    highScoreUpRate: highN >= 1 ? Math.round((highUp / highN) * 1000) / 10 : null,
    highScoreN: highN,
    lowScoreUpRate: lowN >= 1 ? Math.round((lowUp / lowN) * 1000) / 10 : null,
    lowScoreN: lowN,
    conflictDays: dual.conflictDays,
    conflictFollowQuantHits: dual.conflictFollowQuantHits,
    conflictFollowLlmHits: dual.conflictFollowLlmHits,
    buckets,
    recent,
    summary: parts.join(' · '),
  };
}

/** 写入 docs/ 供 Web 直接读取 */
export function savePredictionTrackJson(
  stats: PredictionTrackStats,
  projectRoot: string = process.cwd(),
): string {
  const docsDir = path.join(projectRoot, 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
  const out = path.join(docsDir, 'goldrush-stats-latest.json');
  fs.writeFileSync(out, JSON.stringify(stats, null, 2), 'utf-8');
  return out;
}

export function formatPredictionTrackConsole(stats: PredictionTrackStats, indent = '  '): string {
  const lines = [
    `${indent}📊 历史预测对错（近 ${stats.windowDays} 日 · 5 日标签）`,
    `${indent}  ${stats.summary}`,
    `${indent}  样本报告 ${stats.sampleEligible} 条`,
  ];
  if (stats.recent.length) {
    lines.push(`${indent}  近况：`);
    for (const r of stats.recent.slice(0, 8)) {
      const mark = r.status === 'hit' ? '✅' : r.status === 'miss' ? '❌' : r.status === 'flat' ? '➖' : '⏳';
      const ret = r.actual5dPct != null ? `${r.actual5dPct > 0 ? '+' : ''}${r.actual5dPct}%` : '待回填';
      const align = r.alignPct != null
        ? (r.alignPct >= 0 ? `顺+${r.alignPct}%` : `逆${r.alignPct}%`)
        : '';
      lines.push(`${indent}    ${mark} ${r.date} LLM=${r.llmScore} 预测=${r.pred} 5日=${ret}${align ? ` ${align}` : ''}`);
    }
  }
  return lines.join('\n');
}

/** 命中率单元格：点估计 + 置信区间 + 是否跑赢基准，避免 7/10=70% 被读成「挺准」 */
function formatHitStatCell(stat: HitStat, emptyNote = 'N/A'): string {
  if (stat.hitRate == null) return emptyNote;
  const base = `**${stat.hitRate}%**（${stat.hits}/${stat.total}）`;
  if (!stat.significant) return `${base} · ⚠️ 样本不足 ${MIN_HITRATE_SAMPLE}，不具统计意义`;
  const ci = stat.ciLow != null && stat.ciHigh != null ? ` · 95%CI ${stat.ciLow}–${stat.ciHigh}%` : '';
  return `${base}${ci} · ${stat.beatsBaseline ? '显著跑赢基准' : '未显著跑赢基准'}`;
}

export function formatPredictionTrackMarkdown(stats: PredictionTrackStats): string {
  const lines = [
    '## 📊 历史预测对错',
    '',
    `> 窗口近 **${stats.windowDays}** 日 · 标签：**5 个交易日**涨跌 · 样本 **${stats.sampleEligible}** 条 · 统计日 ${stats.asOf}`,
    '',
    stats.summary,
    '',
    '### 关键统计',
    '',
    '| 指标 | 数值 |',
    '|------|------|',
    `| LLM 方向命中 | ${formatHitStatCell(stats.llm)} |`,
    `| 量化方向命中 | ${formatHitStatCell(stats.quant, '待积累 quant_score')} |`,
    `| 中期(${stats.midTermHorizonDays ?? 20}日)命中 | ${formatHitStatCell(stats.midTerm, '待积累 mid_term_score')} |`,
    `| 永远看涨基准 | ${stats.baselineUpRate != null ? `**${stats.baselineUpRate}%**（${stats.baselineN} 个可评估日）` : 'N/A'} |`,
    `| 高分段(≥60) 5日涨概率 | ${stats.highScoreUpRate != null ? `**${stats.highScoreUpRate}%**（n=${stats.highScoreN}）` : 'N/A'} |`,
    `| 低分段(≤40) 5日涨概率 | ${stats.lowScoreUpRate != null ? `**${stats.lowScoreUpRate}%**（n=${stats.lowScoreN}）` : 'N/A'} |`,
    `| 双分冲突日 | **${stats.conflictDays}**（跟量化对 ${stats.conflictFollowQuantHits} / 跟LLM对 ${stats.conflictFollowLlmHits}） |`,
    '',
  ];

  if (stats.buckets.length) {
    lines.push('### 评分区间 vs 实际 5 日');
    lines.push('');
    lines.push('| 评分区间 | 样本 | 实际涨概率 | 平均涨幅 |');
    lines.push('|----------|------|------------|----------|');
    for (const b of stats.buckets) {
      lines.push(`| ${b.range} | ${b.sample} | ${b.upRate}% | ${b.avgReturn > 0 ? '+' : ''}${b.avgReturn}% |`);
    }
    lines.push('');
  }

  if (stats.recent.length) {
    lines.push('### 最近预测明细');
    lines.push('');
    lines.push('| 日期 | LLM | 量化 | 预测 | 5日涨跌 | 对错 | 顺/逆预测 | 相对同档 |');
    lines.push('|------|-----|------|------|---------|------|-----------|----------|');
    for (const r of stats.recent.slice(0, 12)) {
      const mark = r.status === 'hit' ? '✅' : r.status === 'miss' ? '❌' : r.status === 'flat' ? '➖' : '⏳';
      const ret = r.actual5dPct != null ? `${r.actual5dPct > 0 ? '+' : ''}${r.actual5dPct}%` : '—';
      const q = r.quantScore != null ? String(r.quantScore) : '—';
      const align = r.alignPct == null ? '—'
        : r.alignPct >= 0 ? `顺 +${r.alignPct}%` : `逆 ${Math.abs(r.alignPct)}%`;
      const vs = r.vsBucketPct == null ? '—'
        : `${r.vsBucketPct > 0 ? '+' : ''}${r.vsBucketPct}%`;
      lines.push(`| ${r.date} | ${r.llmScore} | ${q} | ${r.pred} | ${ret} | ${mark} | ${align} | ${vs} |`);
    }
    lines.push('');
  }

  lines.push(`> 记账口径：${HIT_RULE_TEXT}**顺/逆预测**：价格是否朝预测方向走；**相对同档**：本日 5 日涨跌 − 同评分区间历史均值。`);
  lines.push('>');
  lines.push('> 命中率须与「永远看涨」基准对比才有意义——黄金长期偏多头，不比基准就分不清模型有信息量还是只是蹭了趋势。样本不足 10 次时百分比不具统计意义。非投资业绩承诺。');
  lines.push('');
  return lines.join('\n');
}
