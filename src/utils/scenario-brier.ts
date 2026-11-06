// 情景概率校准（Brier）— ROADMAP-FINENG 包 G
//
// 报告每天给出三情景（上行/基准/下行）概率。预报「上行 30%」时，
// 历史 5 日实际上涨频率是否接近 30%？——这是概率预报的基本功（reliability），
// 比「方向对错」更细：方向可以对，概率差得远（30% vs 60% 的仓位含义完全不同）。
//
// 口径：
//   - 预报 pUp = scenarios.upside.probability / 100（三分类中只取上行支）；
//   - 实际 y = 1（5 日涨）/ 0（5 日跌），持平死区与命中口径一致不计；
//   - Brier = mean (pUp - y)²，越低越好；
//   - 基准①：气候学（永远预报样本内实际上涨占比）；基准②：永远 50%。

import type { AnalysisReportRow } from '../db/reports.js';
import type { GoldPricesRepo } from '../db/gold-prices.js';
import { forwardReturnPct } from './forward-return.js';
import { classifyReturn, MIN_HITRATE_SAMPLE } from './decision-thresholds.js';

export interface BrierReliabilityBucket {
  /** 预报上行概率区间，如 "20–40%" */
  range: string;
  sample: number;
  /** 该区间平均预报上行概率 % */
  avgForecastPct: number | null;
  /** 该区间实际上涨频率 %（0-100） */
  empiricalUpRate: number | null;
}

export interface ScenarioBrierResult {
  horizonDays: number;
  /** 已回填且非持平、参与评分的样本数 */
  evaluatedCount: number;
  /** 窗口不足（待回填）的报告数 */
  pendingCount: number;
  /** 情景缺失/损坏、无法取上行概率的报告数 */
  unusableCount: number;
  /** Brier 分数（mean (pUp - y)²），越低越好；样本不足为 null */
  brierScore: number | null;
  /** 气候学基准的 Brier（永远预报实际上涨占比） */
  brierClimatology: number | null;
  /** 永远预报 50% 的 Brier（=0.25） */
  brierAlwaysHalf: number | null;
  /** Brier 技巧分 1 - b/bClim：>0 优于气候学，<0 更差 */
  skillVsClimatology: number | null;
  /** 样本内实际上涨占比 % */
  upRatePct: number | null;
  /** 平均预报上行概率 % */
  avgForecastUpPct: number | null;
  buckets: BrierReliabilityBucket[];
  notes: string[];
}

const FORECAST_BUCKETS: Array<{ range: string; min: number; max: number }> = [
  { range: '0–20%', min: 0, max: 20 },
  { range: '20–40%', min: 20, max: 40 },
  { range: '40–60%', min: 40, max: 60 },
  { range: '60–80%', min: 60, max: 80 },
  { range: '80–100%', min: 80, max: 100 },
];

interface ScenarioRow {
  date: string;
  pUp: number; // 0-1
  y: 0 | 1 | null; // null = flat/pending
}

function extractScenarioRows(
  reports: AnalysisReportRow[],
  prices: GoldPricesRepo,
  horizonDays: number,
): { rows: ScenarioRow[]; pending: number; unusable: number } {
  const rows: ScenarioRow[] = [];
  let pending = 0;
  let unusable = 0;

  for (const r of [...reports].sort((a, b) => a.date.localeCompare(b.date))) {
    let pUp: number | null = null;
    try {
      const parsed = JSON.parse(r.reportJson) as {
        overall?: { scenarios?: { upside?: { probability?: unknown } } };
      };
      const v = parsed?.overall?.scenarios?.upside?.probability;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100) {
        pUp = v / 100;
      }
    } catch {
      // report_json 损坏 → unusable
    }
    if (pUp == null) {
      unusable++;
      continue;
    }

    // 与 prediction-track 短期口径一致：允许部分窗口（≥3 日）先给反馈
    const ret = forwardReturnPct(prices, r.date, horizonDays, { allowPartial: true, minPartialDays: 3 });
    if (ret == null) {
      pending++;
      continue;
    }
    const cls = classifyReturn(ret);
    if (cls === 'flat') {
      // 持平死区：方向不可判，不计入 Brier 分母
      pending++;
      continue;
    }
    rows.push({ date: r.date, pUp, y: cls === 'up' ? 1 : 0 });
  }

  return { rows, pending, unusable };
}

export function computeScenarioBrier(
  reports: AnalysisReportRow[],
  prices: GoldPricesRepo,
  horizonDays = 5,
): ScenarioBrierResult {
  const { rows, pending, unusable } = extractScenarioRows(reports, prices, horizonDays);
  const notes: string[] = [
    `预报取三情景中的上行支（upside.probability），实际为 ${horizonDays} 个交易日涨跌（持平死区不计）。`,
  ];

  if (rows.length === 0) {
    return {
      horizonDays,
      evaluatedCount: 0,
      pendingCount: pending,
      unusableCount: unusable,
      brierScore: null,
      brierClimatology: null,
      brierAlwaysHalf: null,
      skillVsClimatology: null,
      upRatePct: null,
      avgForecastUpPct: null,
      buckets: [],
      notes: [...notes, '暂无可评估样本（情景缺失或前瞻窗口未回填）。'],
    };
  }

  const n = rows.length;
  const upCount = rows.filter(r => r.y === 1).length;
  const upRate = upCount / n;
  const avgForecast = rows.reduce((a, r) => a + r.pUp, 0) / n;

  const brier = rows.reduce((a, r) => a + (r.pUp - r.y!) ** 2, 0) / n;
  const brierClimo = rows.reduce((a, r) => a + (upRate - r.y!) ** 2, 0) / n;
  const brierHalf = 0.25;
  const skill = brierClimo > 0 ? 1 - brier / brierClimo : null;

  if (n < MIN_HITRATE_SAMPLE) {
    notes.push(`样本 ${n} < ${MIN_HITRATE_SAMPLE}，Brier 数字不具统计意义，仅作记录。`);
  }

  const buckets: BrierReliabilityBucket[] = [];
  for (const b of FORECAST_BUCKETS) {
    const matching = rows.filter(r => r.pUp * 100 >= b.min && r.pUp * 100 < (b.max === 100 ? 100.01 : b.max));
    if (matching.length === 0) continue;
    const bUp = matching.filter(r => r.y === 1).length;
    buckets.push({
      range: b.range,
      sample: matching.length,
      avgForecastPct: Math.round((matching.reduce((a, r) => a + r.pUp, 0) / matching.length) * 1000) / 10,
      empiricalUpRate: Math.round((bUp / matching.length) * 1000) / 10,
    });
  }

  const round4 = (v: number) => Math.round(v * 10000) / 10000;

  return {
    horizonDays,
    evaluatedCount: n,
    pendingCount: pending,
    unusableCount: unusable,
    brierScore: round4(brier),
    brierClimatology: round4(brierClimo),
    brierAlwaysHalf: brierHalf,
    skillVsClimatology: skill == null ? null : Math.round(skill * 1000) / 1000,
    upRatePct: Math.round(upRate * 1000) / 10,
    avgForecastUpPct: Math.round(avgForecast * 1000) / 10,
    buckets,
    notes,
  };
}

export function formatScenarioBrierConsole(r: ScenarioBrierResult, indent = '  '): string {
  const lines: string[] = [];
  lines.push(`${indent}🎯 情景概率校准（Brier · ${r.horizonDays} 日标签）`);
  if (r.evaluatedCount === 0) {
    lines.push(`${indent}  暂无可评估样本（待回填 ${r.pendingCount} / 情景缺失 ${r.unusableCount}）`);
    return lines.join('\n');
  }
  lines.push(
    `${indent}  样本 ${r.evaluatedCount}（待回填 ${r.pendingCount}） · 实际上涨占比 ${r.upRatePct}% · 平均预报上行 ${r.avgForecastUpPct}%`,
  );
  lines.push(
    `${indent}  Brier ${r.brierScore}（越低越好） · 气候学基准 ${r.brierClimatology} · 技巧分 ${r.skillVsClimatology ?? '—'}${r.skillVsClimatology != null ? (r.skillVsClimatology > 0 ? '（优于气候学）' : '（差于气候学）') : ''}`,
  );
  if (r.buckets.length) {
    lines.push(`${indent}  可靠性（预报区间 → 实际上涨频率）：`);
    for (const b of r.buckets) {
      lines.push(`${indent}    ${b.range}  n=${b.sample}  预报均值 ${b.avgForecastPct}% → 实际 ${b.empiricalUpRate}%`);
    }
  }
  for (const note of r.notes) lines.push(`${indent}  · ${note}`);
  return lines.join('\n');
}

export function formatScenarioBrierMarkdown(r: ScenarioBrierResult): string {
  const lines: string[] = ['## 🎯 情景概率校准（Brier）', ''];
  if (r.evaluatedCount === 0) {
    lines.push(`暂无可评估样本（待回填 ${r.pendingCount} / 情景缺失 ${r.unusableCount}）。`);
    lines.push('');
    return lines.join('\n');
  }
  lines.push(
    `> 标签：**${r.horizonDays} 个交易日**涨跌 · 样本 **${r.evaluatedCount}**（待回填 ${r.pendingCount}） · 实际上涨占比 **${r.upRatePct}%**`,
    '',
    '| 指标 | 数值 |',
    '|------|------|',
    `| Brier 分数（越低越好） | **${r.brierScore}** |`,
    `| 气候学基准 Brier | ${r.brierClimatology} |`,
    `| 永远 50% Brier | ${r.brierAlwaysHalf} |`,
    `| 技巧分（vs 气候学） | ${r.skillVsClimatology == null ? '—' : `**${r.skillVsClimatology}**（${r.skillVsClimatology > 0 ? '优于' : '差于'}气候学）`} |`,
    `| 平均预报上行概率 | ${r.avgForecastUpPct}% |`,
    '',
  );
  if (r.buckets.length) {
    lines.push('### 可靠性分桶', '');
    lines.push('| 预报上行概率 | 样本 | 预报均值 | 实际上涨频率 |');
    lines.push('|--------------|------|----------|--------------|');
    for (const b of r.buckets) {
      lines.push(`| ${b.range} | ${b.sample} | ${b.avgForecastPct}% | ${b.empiricalUpRate}% |`);
    }
    lines.push('');
  }
  for (const note of r.notes) lines.push(`> ${note}`);
  lines.push('');
  lines.push('> 预报 30% 时历史上涨频率应接近 30% 才算校准良好。Brier 同时惩罚「方向错」与「概率离谱」。非投资建议。');
  lines.push('');
  return lines.join('\n');
}
