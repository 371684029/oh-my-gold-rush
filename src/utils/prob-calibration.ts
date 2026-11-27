// GoldRush v2.6 — 概率扇面实证校准（CRPS + P10–P90 覆盖率）与防钓鱼消息面事后审计
// 纯函数，零 DB/网络依赖，复用于 `goldrush calibrate --crps / --news-audit` 与 Web `/forecast` 成绩单。

import {
  predictDirectionFromScore,
  isHit,
  wilsonIntervalHac,
} from './decision-thresholds.js';

export interface QuantileForecastSample {
  date: string;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  /** 无条件基准分位（用于计算 CRPSS 相对基准技能提升） */
  baselineP10?: number | null;
  baselineP25?: number | null;
  baselineP50?: number | null;
  baselineP75?: number | null;
  baselineP90?: number | null;
  /** 事后真实收益（%） */
  actualPct: number;
  /** 可选：消息面真伪分类（供 --news-audit 联动） */
  veracityStatus?: 'confirmed' | 'bait_suspected' | 'noise_filtered' | 'quiet';
}

export interface ProbFanCalibrationReport {
  horizonDays: number;
  sampleCount: number;
  /** P10–P90 实盘覆盖率（目标 75%–85%，名义 80%） */
  coverage80Pct: number | null;
  /** P25–P75 实盘覆盖率（目标 45%–55%，名义 50%） */
  coverage50Pct: number | null;
  /** 实盘跌破 P10 尾部的比例（名义 10%） */
  lowerTailBreachPct: number | null;
  /** 实盘突破 P90 尾部的比例（名义 10%） */
  upperTailBreachPct: number | null;
  /** 平均 CRPS（百分点，越小越好） */
  meanCrps: number | null;
  /** 无条件基准平均 CRPS */
  baselineCrps: number | null;
  /** CRPS Skill Score = 1 - meanCrps / baselineCrps（>0 代表优于无条件历史基准） */
  crpss: number | null;
  /** 中位数方向胜率（非持平样本） */
  directionHitRatePct: number | null;
  directionHits: number;
  directionTotal: number;
  directionWilson95: { lowPct: number; highPct: number } | null;
  /** 校准诊断结论 */
  calibrationVerdict: 'well_calibrated' | 'too_narrow' | 'too_wide' | 'insufficient';
  calibrationLabel: string;
}

export interface NewsAuditSample {
  date: string;
  veracityStatus: 'confirmed' | 'bait_suspected' | 'noise_filtered' | 'quiet';
  /** 预测方向分数（0-100） */
  score: number;
  /** 若有过滤前原始文本方向分，可用于对比过滤前后净提升 */
  rawHeadlineScore?: number | null;
  actual1dPct: number | null;
  actual5dPct: number | null;
}

export interface NewsAuditBucketStats {
  status: 'confirmed' | 'bait_suspected' | 'noise_filtered' | 'quiet';
  label: string;
  count: number;
  avg1dPct: number | null;
  avg5dPct: number | null;
  hitCount5d: number;
  validCount5d: number;
  hitRate5dPct: number | null;
  wilson95: { lowPct: number; highPct: number } | null;
  brierScore5d: number | null;
}

export interface NewsAuditReport {
  totalSamples: number;
  buckets: NewsAuditBucketStats[];
  /** 全样本（含钓鱼/噪音）5D 命中率 */
  allSamplesHitRatePct: number | null;
  /** 剔除钓鱼与噪音后（仅 confirmed + quiet）5D 命中率 */
  filteredHitRatePct: number | null;
  /** 滤网带来的命中率净变化（百分点） */
  filterLiftPctPoints: number | null;
  summary: string;
}

function round(v: number, digits = 2): number {
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}

/** 单个分位 τ 的 Pinball Loss：ρ_τ(y - q) */
export function pinballLoss(actual: number, quantileValue: number, tau: number): number {
  const err = actual - quantileValue;
  return err >= 0 ? tau * err : (tau - 1) * err;
}

/**
 * 5 分位（P10/P25/P50/P75/P90）梯形积分近似 CRPS（Continuous Ranked Probability Score）。
 * CRPS = 2 * ∫_0^1 ρ_τ(y - F^{-1}(τ)) dτ，单位与收益（%）一致，越小越准。
 */
export function computeFiveQuantileCrps(
  actual: number,
  q: { p10: number; p25: number; p50: number; p75: number; p90: number },
): number {
  const taus = [0.10, 0.25, 0.50, 0.75, 0.90];
  const vals = [q.p10, q.p25, q.p50, q.p75, q.p90];
  const losses = taus.map((t, i) => pinballLoss(actual, vals[i], t));
  // 梯形权重近似 [0.10, 0.25, 0.50, 0.75, 0.90] 上的积分（含两端尾部近似）
  const weights = [0.175, 0.20, 0.25, 0.20, 0.175];
  let integral = 0;
  for (let i = 0; i < losses.length; i++) {
    integral += losses[i] * weights[i];
  }
  return round(2 * integral, 4);
}

/** 评估一组概率扇面历史预测的 CRPS、CRPSS、P10–P90 覆盖率与方向命中率 */
export function evaluateProbFanCalibration(
  samples: QuantileForecastSample[],
  horizonDays: number,
): ProbFanCalibrationReport {
  const valid = (samples || []).filter(
    s => Number.isFinite(s.actualPct) && Number.isFinite(s.p10) && Number.isFinite(s.p50) && Number.isFinite(s.p90),
  );
  const n = valid.length;
  if (n === 0) {
    return {
      horizonDays,
      sampleCount: 0,
      coverage80Pct: null,
      coverage50Pct: null,
      lowerTailBreachPct: null,
      upperTailBreachPct: null,
      meanCrps: null,
      baselineCrps: null,
      crpss: null,
      directionHitRatePct: null,
      directionHits: 0,
      directionTotal: 0,
      directionWilson95: null,
      calibrationVerdict: 'insufficient',
      calibrationLabel: '样本不足（待积累）',
    };
  }

  let in80 = 0;
  let in50 = 0;
  let belowP10 = 0;
  let aboveP90 = 0;
  let crpsSum = 0;
  let baseCrpsSum = 0;
  let baseCrpsCount = 0;
  let dirHits = 0;
  let dirTotal = 0;

  for (const s of valid) {
    if (s.actualPct >= s.p10 && s.actualPct <= s.p90) in80++;
    if (s.actualPct >= s.p25 && s.actualPct <= s.p75) in50++;
    if (s.actualPct < s.p10) belowP10++;
    if (s.actualPct > s.p90) aboveP90++;

    crpsSum += computeFiveQuantileCrps(s.actualPct, s);
    if (
      s.baselineP10 != null && s.baselineP25 != null && s.baselineP50 != null
      && s.baselineP75 != null && s.baselineP90 != null
    ) {
      baseCrpsSum += computeFiveQuantileCrps(s.actualPct, {
        p10: s.baselineP10,
        p25: s.baselineP25,
        p50: s.baselineP50,
        p75: s.baselineP75,
        p90: s.baselineP90,
      });
      baseCrpsCount++;
    }

    // 方向胜率：仅在预测中位数显著偏离 0（±0.2%）且实盘非持平时计入
    if (Math.abs(s.p50) >= 0.2 && Math.abs(s.actualPct) >= 0.1) {
      dirTotal++;
      if ((s.p50 > 0 && s.actualPct > 0) || (s.p50 < 0 && s.actualPct < 0)) {
        dirHits++;
      }
    }
  }

  const coverage80Pct = round((in80 / n) * 100, 1);
  const coverage50Pct = round((in50 / n) * 100, 1);
  const lowerTailBreachPct = round((belowP10 / n) * 100, 1);
  const upperTailBreachPct = round((aboveP90 / n) * 100, 1);
  const meanCrps = round(crpsSum / n, 3);
  const baselineCrps = baseCrpsCount > 0 ? round(baseCrpsSum / baseCrpsCount, 3) : null;
  const crpss = (baselineCrps != null && baselineCrps > 0)
    ? round(1 - meanCrps / baselineCrps, 3)
    : null;

  const directionHitRatePct = dirTotal > 0 ? round((dirHits / dirTotal) * 100, 1) : null;
  const wilson = dirTotal > 0 ? wilsonIntervalHac(dirHits, dirTotal, horizonDays) : null;
  const directionWilson95 = wilson
    ? { lowPct: round(wilson[0] * 100, 1), highPct: round(wilson[1] * 100, 1) }
    : null;

  let calibrationVerdict: ProbFanCalibrationReport['calibrationVerdict'] = 'well_calibrated';
  let calibrationLabel = '校准良好（落入 75%–85% 目标带）';
  if (n < 10) {
    calibrationVerdict = 'insufficient';
    calibrationLabel = `样本偏少（n=${n} < 10，仅供参考）`;
  } else if (coverage80Pct < 72) {
    calibrationVerdict = 'too_narrow';
    calibrationLabel = `区间偏窄（${coverage80Pct}% < 75%，尾部低估）`;
  } else if (coverage80Pct > 88) {
    calibrationVerdict = 'too_wide';
    calibrationLabel = `区间偏宽（${coverage80Pct}% > 85%，略保守）`;
  }

  return {
    horizonDays,
    sampleCount: n,
    coverage80Pct,
    coverage50Pct,
    lowerTailBreachPct,
    upperTailBreachPct,
    meanCrps,
    baselineCrps,
    crpss,
    directionHitRatePct,
    directionHits: dirHits,
    directionTotal: dirTotal,
    directionWilson95,
    calibrationVerdict,
    calibrationLabel,
  };
}

const STATUS_LABELS: Record<NewsAuditSample['veracityStatus'], string> = {
  confirmed: '✅ 实证真消息',
  bait_suspected: '⚠️ 疑似钓鱼背离',
  noise_filtered: '🚫 噪音/谣言滤除',
  quiet: '⚪ 平静无强催化',
};

/** 统计防钓鱼消息面分桶回测结果（供 `calibrate --news-audit`） */
export function buildNewsAuditStats(samples: NewsAuditSample[]): NewsAuditReport {
  const statuses: Array<NewsAuditSample['veracityStatus']> = [
    'confirmed',
    'bait_suspected',
    'noise_filtered',
    'quiet',
  ];

  const buckets: NewsAuditBucketStats[] = statuses.map(status => {
    const group = samples.filter(s => s.veracityStatus === status);
    const rets1 = group.map(g => g.actual1dPct).filter((v): v is number => v != null && Number.isFinite(v));
    const rets5 = group.map(g => g.actual5dPct).filter((v): v is number => v != null && Number.isFinite(v));

    let hits = 0;
    let valid = 0;
    let brierSum = 0;
    let brierN = 0;

    for (const g of group) {
      if (g.actual5dPct == null || !Number.isFinite(g.actual5dPct)) continue;
      const predDir = predictDirectionFromScore(g.score);
      const hit = isHit(predDir, g.actual5dPct);
      if (hit !== null) {
        valid++;
        if (hit) hits++;
      }
      const pUp = Math.max(0.05, Math.min(0.95, g.score / 100));
      const yUp = g.actual5dPct > 0 ? 1 : 0;
      brierSum += (pUp - yUp) * (pUp - yUp);
      brierN++;
    }

    const w = valid > 0 ? wilsonIntervalHac(hits, valid, 5) : null;
    return {
      status,
      label: STATUS_LABELS[status],
      count: group.length,
      avg1dPct: rets1.length > 0 ? round(rets1.reduce((a, b) => a + b, 0) / rets1.length, 2) : null,
      avg5dPct: rets5.length > 0 ? round(rets5.reduce((a, b) => a + b, 0) / rets5.length, 2) : null,
      hitCount5d: hits,
      validCount5d: valid,
      hitRate5dPct: valid > 0 ? round((hits / valid) * 100, 1) : null,
      wilson95: w ? { lowPct: round(w[0] * 100, 1), highPct: round(w[1] * 100, 1) } : null,
      brierScore5d: brierN > 0 ? round(brierSum / brierN, 4) : null,
    };
  });

  const allValid = buckets.reduce((s, b) => s + b.validCount5d, 0);
  const allHits = buckets.reduce((s, b) => s + b.hitCount5d, 0);
  const cleanBuckets = buckets.filter(b => b.status === 'confirmed' || b.status === 'quiet');
  const cleanValid = cleanBuckets.reduce((s, b) => s + b.validCount5d, 0);
  const cleanHits = cleanBuckets.reduce((s, b) => s + b.hitCount5d, 0);

  const allSamplesHitRatePct = allValid > 0 ? round((allHits / allValid) * 100, 1) : null;
  const filteredHitRatePct = cleanValid > 0 ? round((cleanHits / cleanValid) * 100, 1) : null;
  const filterLiftPctPoints = (allSamplesHitRatePct != null && filteredHitRatePct != null)
    ? round(filteredHitRatePct - allSamplesHitRatePct, 1)
    : null;

  const summary = allValid === 0
    ? '暂无足够已回填 5D 收益的消息面审计样本。'
    : `全样本 5D 命中 ${allSamplesHitRatePct}%（${allHits}/${allValid}），剔除疑似钓鱼/噪音后 ${filteredHitRatePct ?? '—'}%（净变化 ${filterLiftPctPoints != null ? (filterLiftPctPoints >= 0 ? '+' : '') + filterLiftPctPoints + 'pp' : '—'}）。`;

  return {
    totalSamples: samples.length,
    buckets,
    allSamplesHitRatePct,
    filteredHitRatePct,
    filterLiftPctPoints,
    summary,
  };
}

export function formatProbFanConsole(reports: ProbFanCalibrationReport[]): string {
  const lines = ['\n  🎯 概率扇面实证校准（CRPS + P10–P90 区间覆盖率，严格零前视）\n'];
  for (const r of reports) {
    const cov80 = r.coverage80Pct != null ? `${r.coverage80Pct}%` : 'N/A';
    const cov50 = r.coverage50Pct != null ? `${r.coverage50Pct}%` : 'N/A';
    const crps = r.meanCrps != null ? r.meanCrps.toFixed(3) : 'N/A';
    const crpss = r.crpss != null ? `${r.crpss >= 0 ? '+' : ''}${(r.crpss * 100).toFixed(1)}%` : 'N/A';
    const dir = r.directionHitRatePct != null
      ? `${r.directionHitRatePct}% (${r.directionHits}/${r.directionTotal}${r.directionWilson95 ? `, 95%CI ${r.directionWilson95.lowPct}%–${r.directionWilson95.highPct}%` : ''})`
      : 'N/A';
    lines.push(`  [${r.horizonDays}D 视野 · 样本 ${r.sampleCount}] ${r.calibrationLabel}`);
    lines.push(`    · P10–P90 覆盖率: ${cov80}（目标 75%–85%） · P25–P75: ${cov50} · 越界(下/上): ${r.lowerTailBreachPct ?? '—'}% / ${r.upperTailBreachPct ?? '—'}%`);
    lines.push(`    · CRPS: ${crps}% · 相对基准 CRPSS: ${crpss} · 中位数方向胜率: ${dir}`);
  }
  return lines.join('\n');
}

export function formatProbFanMarkdown(reports: ProbFanCalibrationReport[]): string {
  const rows = reports.map(r =>
    `| ${r.horizonDays}D | ${r.sampleCount} | ${r.coverage80Pct != null ? r.coverage80Pct + '%' : '—'} | ${r.coverage50Pct != null ? r.coverage50Pct + '%' : '—'} | ${r.meanCrps != null ? r.meanCrps.toFixed(3) : '—'} | ${r.crpss != null ? (r.crpss >= 0 ? '+' : '') + (r.crpss * 100).toFixed(1) + '%' : '—'} | ${r.directionHitRatePct != null ? r.directionHitRatePct + '%' : '—'} | ${r.calibrationLabel} |`,
  );
  return [
    '## 🎯 概率扇面实证校准（CRPS + P10–P90 覆盖率）',
    '',
    '| 视野 | 样本 | P10–P90覆盖 | P25–P75覆盖 | CRPS(%) | CRPSS | 方向胜率 | 校准诊断 |',
    '|------|------|------------|------------|---------|-------|---------|---------|',
    ...rows,
    '',
  ].join('\n');
}

export function formatNewsAuditConsole(report: NewsAuditReport): string {
  const lines = [
    '\n  🛡️ 消息面真伪与防钓鱼事后审计（5D 收益分桶）\n',
    `  ${report.summary}`,
  ];
  for (const b of report.buckets) {
    if (b.count === 0) continue;
    const hitStr = b.hitRate5dPct != null
      ? `${b.hitRate5dPct}% (${b.hitCount5d}/${b.validCount5d}${b.wilson95 ? `, CI ${b.wilson95.lowPct}%–${b.wilson95.highPct}%` : ''})`
      : 'N/A';
    const avg5 = b.avg5dPct != null ? `${b.avg5dPct >= 0 ? '+' : ''}${b.avg5dPct}%` : '—';
    const brier = b.brierScore5d != null ? b.brierScore5d.toFixed(3) : '—';
    lines.push(`    · ${b.label}: ${b.count}天 | 5D均收益 ${avg5} | 5D命中 ${hitStr} | Brier ${brier}`);
  }
  return lines.join('\n');
}

export function formatNewsAuditMarkdown(report: NewsAuditReport): string {
  const rows = report.buckets
    .filter(b => b.count > 0)
    .map(b =>
      `| ${b.label} | ${b.count} | ${b.avg1dPct != null ? (b.avg1dPct >= 0 ? '+' : '') + b.avg1dPct + '%' : '—'} | ${b.avg5dPct != null ? (b.avg5dPct >= 0 ? '+' : '') + b.avg5dPct + '%' : '—'} | ${b.hitRate5dPct != null ? `${b.hitRate5dPct}% (${b.hitCount5d}/${b.validCount5d})` : '—'} | ${b.brierScore5d != null ? b.brierScore5d.toFixed(3) : '—'} |`,
    );
  return [
    '## 🛡️ 消息面真伪与防钓鱼事后审计',
    '',
    `> ${report.summary}`,
    '',
    '| 分类 | 天数 | 1D均收益 | 5D均收益 | 5D方向命中 | Brier |',
    '|------|------|---------|---------|-----------|-------|',
    ...(rows.length ? rows : ['| 暂无数据 | 0 | — | — | — | — |']),
    '',
  ].join('\n');
}
