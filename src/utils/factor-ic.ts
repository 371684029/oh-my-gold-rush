// 因子 IC 粗算 — 从历史报告 quantFactors 对后 5 日收益做 Spearman 相关
// 目的：标出近期失效因子，供 calibrate 展示；不自动狂调权重（需人工确认）

import type { AnalysisReportRow } from '../db/reports.js';
import type { GoldPricesRepo } from '../db/gold-prices.js';
import { parseReportJson } from './smart-analysis.js';
import { forwardReturnPct } from './forward-return.js';
import { effectiveSampleSizeOverlap } from './decision-thresholds.js';

export interface FactorIcRow {
  key: string;
  name: string;
  /** Spearman ρ（因子分 vs 后 5 日收益） */
  ic: number | null;
  /** F16: 非重叠步长抽样后的独立样本 Spearman IC */
  nonOverlappingIc?: number | null;
  /** F16: 滚动窗口 ICIR（均值 / 标准差），评估因子稳定性 */
  icir?: number | null;
  sample: number;
  /** F16: 重叠窗口 Bartlett 等效独立样本数 */
  effectiveSample?: number;
  /** |IC| < 0.05 且样本够 → 疑似失效 */
  stale: boolean;
  note: string;
}

export interface FactorIcReport {
  horizonDays: number;
  minSample: number;
  rows: FactorIcRow[];
  staleKeys: string[];
  summary: string;
}

function spearman(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 5 || n !== ys.length) return null;
  const rank = (arr: number[]) => {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(n);
    for (let i = 0; i < n; ) {
      let j = i;
      while (j < n && sorted[j].v === sorted[i].v) j++;
      const avg = (i + j - 1) / 2 + 1;
      for (let k = i; k < j; k++) ranks[sorted[k].i] = avg;
      i = j;
    }
    return ranks;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  let sx = 0, sy = 0, sxy = 0;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - mx;
    const dy = ry[i] - my;
    sx += dx * dx;
    sy += dy * dy;
    sxy += dx * dy;
  }
  if (sx <= 0 || sy <= 0) return null;
  return sxy / Math.sqrt(sx * sy);
}

/**
 * 计算各量化因子对后 N 日收益的 Spearman IC
 */
export function computeFactorIc(
  reports: AnalysisReportRow[],
  prices: GoldPricesRepo,
  opts?: { horizonDays?: number; minSample?: number },
): FactorIcReport {
  const horizonDays = opts?.horizonDays ?? 5;
  const minSample = opts?.minSample ?? 8;

  const series = new Map<string, { name: string; xs: number[]; ys: number[] }>();

  const sorted = [...reports].sort((a, b) => a.date.localeCompare(b.date));
  for (const row of sorted) {
    const report = parseReportJson(row.reportJson);
    const factors = report?.overall?.quantFactors;
    if (!factors) continue;
    const ret = forwardReturnPct(prices, row.date, horizonDays);
    if (ret == null) continue;

    for (const [key, f] of Object.entries(factors)) {
      if (!f || typeof f.normalizedScore !== 'number') continue;
      let bucket = series.get(key);
      if (!bucket) {
        bucket = { name: f.name || key, xs: [], ys: [] };
        series.set(key, bucket);
      }
      bucket.xs.push(f.normalizedScore);
      bucket.ys.push(ret);
    }
  }

  const rows: FactorIcRow[] = [];
  const step = Math.max(1, horizonDays);
  for (const [key, bucket] of series) {
    const ic = spearman(bucket.xs, bucket.ys);
    const sample = bucket.xs.length;
    const effectiveSample = effectiveSampleSizeOverlap(sample, horizonDays);

    // F16: 非重叠抽样 IC
    const noXs: number[] = [];
    const noYs: number[] = [];
    for (let i = 0; i < sample; i += step) {
      noXs.push(bucket.xs[i]);
      noYs.push(bucket.ys[i]);
    }
    const nonOverlappingIcRaw = spearman(noXs, noYs);

    // F16: 滚动分块 Rank ICIR（每 10 个观测一块，至少 3 块）
    let icir: number | null = null;
    const chunkSize = 10;
    if (sample >= chunkSize * 3) {
      const chunkIcs: number[] = [];
      for (let i = 0; i + chunkSize <= sample; i += chunkSize) {
        const cIc = spearman(bucket.xs.slice(i, i + chunkSize), bucket.ys.slice(i, i + chunkSize));
        if (cIc != null) chunkIcs.push(cIc);
      }
      if (chunkIcs.length >= 3) {
        const m = chunkIcs.reduce((a, b) => a + b, 0) / chunkIcs.length;
        const variance = chunkIcs.reduce((a, b) => a + (b - m) ** 2, 0) / (chunkIcs.length - 1);
        const sd = Math.sqrt(Math.max(0, variance));
        if (sd > 1e-6) icir = Math.round((m / sd) * 100) / 100;
      }
    }

    const stale = sample >= minSample && ic != null && Math.abs(ic) < 0.05;
    let note = '样本不足';
    if (ic == null) note = sample < 5 ? '样本不足' : '无法计算';
    else if (stale) note = '近期近失效（|IC|<0.05）';
    else if (ic >= 0.1) note = '正向有效';
    else if (ic <= -0.1) note = '反向（可能逻辑反了或拥挤）';
    else note = '弱相关';
    rows.push({
      key,
      name: bucket.name,
      ic: ic != null ? Math.round(ic * 1000) / 1000 : null,
      nonOverlappingIc: nonOverlappingIcRaw != null ? Math.round(nonOverlappingIcRaw * 1000) / 1000 : null,
      icir,
      sample,
      effectiveSample,
      stale,
      note,
    });
  }

  rows.sort((a, b) => Math.abs(b.ic ?? 0) - Math.abs(a.ic ?? 0));
  const staleKeys = rows.filter(r => r.stale).map(r => r.key);
  const summary = staleKeys.length
    ? `疑似失效因子：${staleKeys.join('、')}（仅展示，勿自动狂调权重）`
    : rows.length
      ? '未见明显失效因子（|IC|<0.05 且样本够）'
      : '暂无 quantFactors 历史，无法算 IC';

  return { horizonDays, minSample, rows, staleKeys, summary };
}

export function formatFactorIcConsole(report: FactorIcReport, indent = '  '): string {
  const lines = [
    `${indent}📉 因子 IC（Spearman vs 后 ${report.horizonDays} 日收益）`,
    `${indent}  ${report.summary}`,
  ];
  if (!report.rows.length) return lines.join('\n');
  lines.push(`${indent}  因子                IC     样本  说明`);
  for (const r of report.rows) {
    const icStr = r.ic == null ? '  N/A' : r.ic.toFixed(3).padStart(6);
    const mark = r.stale ? '⚠️' : '  ';
    lines.push(
      `${indent}  ${mark}${(r.name || r.key).slice(0, 14).padEnd(14)} ${icStr}  ${String(r.sample).padStart(4)}  ${r.note}`,
    );
  }
  return lines.join('\n');
}

export function formatFactorIcMarkdown(report: FactorIcReport): string {
  const lines = [
    '## 📉 因子 IC（研究卫生）',
    '',
    `> 后 ${report.horizonDays} 日收益 · Spearman · ${report.summary}`,
    '',
    '| 因子 | IC | 样本 | 状态 |',
    '|------|-----|------|------|',
  ];
  for (const r of report.rows) {
    lines.push(
      `| ${r.stale ? '⚠️ ' : ''}${r.name} (\`${r.key}\`) | ${r.ic ?? 'N/A'} | ${r.sample} | ${r.note} |`,
    );
  }
  lines.push('');
  lines.push('> IC 仅供研究；权重改动需人工确认，冲突时仍不抬单侧总权重。');
  lines.push('');
  return lines.join('\n');
}
