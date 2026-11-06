// 校准 Tearsheet — 区间收益分布 + 纸面权益回放
//
// 权益部分自 2026-11 起改用 paper-equity 引擎（日频不重叠 + MaxDD）。
// 旧实现把重叠的 5 日前瞻收益逐报告复利，报告日更时同一段行情被记多次账，
// 净值被系统性放大（且硬编码 55/45 违反口径单一来源），已废弃。

import type { AnalysisReportRow } from '../db/reports.js';
import type { GoldPricesRepo } from '../db/gold-prices.js';
import { renderLineChartSvg } from './chart-svg.js';
import { SCORE_BUCKETS } from './score-buckets.js';
import { forwardReturn, validClose } from './forward-return.js';
import {
  buildPaperEquity,
  extractPositionDecisions,
  formatPaperEquityConsole,
  formatPaperEquityMarkdown,
  type PaperEquityBar,
  type PaperEquityResult,
} from './paper-equity.js';

export interface BucketReturnStats {
  scoreRange: string;
  sampleSize: number;
  upRate: number;
  avgReturn: number;
  minReturn: number;
  maxReturn: number;
  medianReturn: number;
}

export interface CalibrationTearsheet {
  bucketStats: BucketReturnStats[];
  /** 纸面权益回放（策略 vs 满仓 vs 半仓，日频不重叠） */
  equity: PaperEquityResult;
  /** 有完整 5 日前瞻收益、参与分桶统计的报告数 */
  sampleCount: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 从最早报告日起拉出有效收盘序列（升序），供纸面权益日频回放 */
function buildBars(reports: AnalysisReportRow[], prices: GoldPricesRepo): PaperEquityBar[] {
  const sorted = [...reports].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) return [];
  const earliest = sorted[0].date;
  const bars: PaperEquityBar[] = [];
  const first = prices.getByDate(earliest);
  if (validClose(first?.londonClose)) {
    bars.push({ date: earliest, close: first!.londonClose! });
  }
  for (const p of prices.getAfter(earliest, 10_000)) {
    if (validClose(p.londonClose)) {
      bars.push({ date: p.date, close: p.londonClose! });
    }
  }
  return bars;
}

/** 从报告与金价构建 tearsheet（分桶 + 纸面权益） */
export function buildCalibrationTearsheet(
  reports: AnalysisReportRow[],
  prices: GoldPricesRepo,
  holdDays = 5,
): CalibrationTearsheet {
  const bucketReturns = new Map<string, number[]>();
  for (const { range } of SCORE_BUCKETS) {
    bucketReturns.set(range, []);
  }

  const sorted = [...reports].sort((a, b) => a.date.localeCompare(b.date));
  let sampleCount = 0;

  for (const report of sorted) {
    // 分桶统计：只认完整前瞻窗口（与校准/命中口径一致，走 forward-return 单一来源）
    const fwd = forwardReturn(prices, report.date, holdDays, { allowPartial: false });
    if (fwd == null) continue;
    const return5d = fwd.returnPct;
    sampleCount++;

    for (const { range, min, max } of SCORE_BUCKETS) {
      const isLast = max === 100;
      if (report.overallScore >= min && (isLast ? report.overallScore <= max : report.overallScore < max)) {
        bucketReturns.get(range)!.push(return5d);
        break;
      }
    }
  }

  const bucketStats: BucketReturnStats[] = [];
  for (const { range } of SCORE_BUCKETS) {
    const returns = bucketReturns.get(range)!;
    if (returns.length === 0) continue;
    const upRate = returns.filter(r => r > 0).length / returns.length;
    bucketStats.push({
      scoreRange: range,
      sampleSize: returns.length,
      upRate,
      avgReturn: returns.reduce((a, b) => a + b, 0) / returns.length,
      minReturn: Math.min(...returns),
      maxReturn: Math.max(...returns),
      medianReturn: median(returns),
    });
  }

  const equity = buildPaperEquity(buildBars(reports, prices), extractPositionDecisions(reports));

  return {
    bucketStats,
    equity,
    sampleCount,
  };
}

/** CLI 表格输出 */
export function formatTearsheetConsole(sheet: CalibrationTearsheet): string {
  const lines: string[] = [];
  lines.push('\n  📉 区间 5 日收益分布（Tearsheet）');
  lines.push('  区间      样本  上涨率  均收益  中位数  最小~最大');
  lines.push('  ' + '─'.repeat(52));

  for (const b of sheet.bucketStats) {
    lines.push(
      `  ${b.scoreRange.padEnd(8)} ${String(b.sampleSize).padStart(4)}  `
      + `${(b.upRate * 100).toFixed(0).padStart(5)}%  `
      + `${(b.avgReturn >= 0 ? '+' : '')}${b.avgReturn.toFixed(2).padStart(6)}%  `
      + `${(b.medianReturn >= 0 ? '+' : '')}${b.medianReturn.toFixed(2).padStart(6)}%  `
      + `${b.minReturn.toFixed(1)}~${b.maxReturn.toFixed(1)}%`,
    );
  }

  lines.push('');
  lines.push(formatPaperEquityConsole(sheet.equity));

  return lines.join('\n');
}

/** 策略 vs 满仓 持有净值曲线 SVG（最多取最近 40 个点） */
export function renderPaperEquitySvg(equity: PaperEquityResult, maxPoints = 40): string {
  const slice = equity.points.length > maxPoints ? equity.points.slice(-maxPoints) : equity.points;
  if (slice.length < 2) {
    return renderLineChartSvg([], []);
  }
  return renderLineChartSvg(
    slice.map(p => p.date),
    [
      { label: '策略(推荐仓位)', color: '#f59e0b', values: slice.map(p => p.strategyNav) },
      { label: '满仓持有', color: '#60a5fa', values: slice.map(p => p.holdNav) },
      { label: '固定50%', color: '#94a3b8', values: slice.map(p => p.halfNav) },
    ],
  );
}

/** Markdown 导出 */
export function formatTearsheetMarkdown(sheet: CalibrationTearsheet, periodLabel: string): string {
  const lines: string[] = [
    '# 📊 GoldRush 校准 Tearsheet',
    '',
    `> 区间：${periodLabel}　|　有效样本：${sheet.sampleCount}`,
    '',
    '## 评分区间 · 5 日收益分布',
    '',
    '| 区间 | 样本 | 上涨率 | 均收益 | 中位数 | 最小 | 最大 |',
    '|------|------|--------|--------|--------|------|------|',
  ];

  for (const b of sheet.bucketStats) {
    lines.push(
      `| ${b.scoreRange} | ${b.sampleSize} | ${(b.upRate * 100).toFixed(0)}% `
      + `| ${b.avgReturn.toFixed(2)}% | ${b.medianReturn.toFixed(2)}% `
      + `| ${b.minReturn.toFixed(2)}% | ${b.maxReturn.toFixed(2)}% |`,
    );
  }

  lines.push('');
  if (sheet.equity.points.length >= 2) {
    lines.push('<div class="equity-chart">');
    lines.push('');
    lines.push(renderPaperEquitySvg(sheet.equity));
    lines.push('');
    lines.push('</div>');
    lines.push('');
  }
  lines.push(formatPaperEquityMarkdown(sheet.equity));
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('> 仅供研究参考，不构成投资建议。模拟假设简化，未计费率与滑点。');
  lines.push('');

  return lines.join('\n');
}
