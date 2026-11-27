// S2 政策面（宏观监管分析）— 纯本地纯函数，零 LLM / 零 DB / 零网络
// 正交边界：聚焦「货币/财政政策周期 + 官方央行黄金储备战略 + 监管制度」，
// 与 B1 基本面（TIPS/CPI/DXY 定价锚）及 B2 消息面（短期突发事件）严格解耦。

import type { Direction } from '../types/analysis.js';
import { directionFromScore } from '../utils/decision-thresholds.js';

export interface PolicyCycleMetric {
  key: string;
  label: string;
  rawValue: number;
  displayValue: string;
  score: number;
  weight: number;
  effectiveWeight: number;
  tone: 'bull' | 'bear' | 'neutral';
  source: string;
  obsDate?: string | null;
}

export interface PolicyCycleInput {
  /** 美联储有效联邦基金利率 FEDFUNDS (%) */
  fedFunds?: number | null;
  /** 2 年期美债收益率 DGS2 (%) — 市场对未来 1–2 年货币政策路径的核心定价锚 */
  us2y?: number | null;
  /** 10 年期美债收益率 DGS10 (%)，用于构造 2s10s 期限利差（宽松/衰退前瞻） */
  us10y?: number | null;
  /** 联邦基金利率近 6 个月/12 个月变化（bp，负值=已进入降息周期） */
  fedFundsChange6mBp?: number | null;
  /** 央行（PBOC）连续增持月数 */
  pbocConsecutiveMonths?: number | null;
  /** 央行（PBOC）最新月度储备变动（吨） */
  pbocMonthlyChangeTons?: number | null;
  /** 可选监管/财政制度评分（0-100，默认不传则剔除重归一） */
  regulatoryScore?: number | null;
  regulatoryNote?: string | null;
  obsDates?: {
    fedFunds?: string | null;
    us2y?: string | null;
    pboc?: string | null;
  };
}

export interface PolicyCycleResult {
  score: number;
  direction: Direction;
  coverage: number;
  metrics: PolicyCycleMetric[];
  missingMetrics: string[];
  cycleLabel: string;
  summary: string;
}

const WEIGHTS = {
  fed_rate_expectation: 0.40,
  pboc_reserve_cycle: 0.35,
  yield_curve_cycle: 0.15,
  regulatory_stance: 0.10,
} as const;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round(v: number, digits = 2): number {
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}

function toneOf(score: number): 'bull' | 'bear' | 'neutral' {
  return score >= 58 ? 'bull' : score <= 42 ? 'bear' : 'neutral';
}

export function computePolicyCycleDimension(input: PolicyCycleInput): PolicyCycleResult {
  const metrics: PolicyCycleMetric[] = [];
  const missingMetrics: string[] = [];
  let cycleLabel = '政策中性观察期';

  // 1) 美联储货币周期与 2Y-FFR 降息预期利差（DGS2 < FEDFUNDS 表明市场定价降息，利多黄金）
  if (input.fedFunds != null && Number.isFinite(input.fedFunds)) {
    const ff = input.fedFunds;
    const has2y = input.us2y != null && Number.isFinite(input.us2y);
    const spreadBp = has2y ? (input.us2y! - ff) * 100 : 0; // 负值=降息预期
    const ch6mBp = input.fedFundsChange6mBp != null && Number.isFinite(input.fedFundsChange6mBp)
      ? input.fedFundsChange6mBp
      : 0;

    // 2Y 低于政策利率 50bp -> 偏多；政策利率近半年已降息 -> 偏多
    const expectationPart = has2y ? -spreadBp / 3.5 : 0; // -70bp -> +20
    const trendPart = -ch6mBp / 5; // -50bp -> +10
    const score = Math.round(clamp(50 + expectationPart + trendPart, 15, 85));

    if (spreadBp <= -35 || ch6mBp <= -25) cycleLabel = '联储降息/宽松周期';
    else if (spreadBp >= 35 || ch6mBp >= 25) cycleLabel = '联储紧缩/鹰派周期';
    else cycleLabel = '政策利率平台观察期';

    metrics.push({
      key: 'fed_rate_expectation',
      label: '美联储政策利率与2Y预期',
      rawValue: round(spreadBp, 0),
      displayValue: has2y
        ? `FFR ${ff.toFixed(2)}% · 2Y-FFR ${spreadBp >= 0 ? '+' : ''}${Math.round(spreadBp)}bp`
        : `FFR ${ff.toFixed(2)}%`,
      score,
      weight: WEIGHTS.fed_rate_expectation,
      effectiveWeight: 0,
      tone: toneOf(score),
      source: 'FRED FEDFUNDS / DGS2',
      obsDate: input.obsDates?.fedFunds ?? input.obsDates?.us2y ?? null,
    });
  } else {
    missingMetrics.push('fed_rate_expectation');
  }

  // 2) 全球央行（PBOC）官方黄金储备增持周期
  if (
    (input.pbocConsecutiveMonths != null && Number.isFinite(input.pbocConsecutiveMonths))
    || (input.pbocMonthlyChangeTons != null && Number.isFinite(input.pbocMonthlyChangeTons))
  ) {
    const months = Math.max(0, input.pbocConsecutiveMonths ?? 0);
    const chTons = input.pbocMonthlyChangeTons ?? 0;
    const streakScore = months > 0 ? Math.min(86, 54 + months * 2.5) : 50;
    const chScore = 50 + 24 * Math.tanh(chTons / 8);
    const score = Math.round(clamp(0.6 * streakScore + 0.4 * chScore, 15, 88));
    metrics.push({
      key: 'pboc_reserve_cycle',
      label: '央行(PBOC)官方购金周期',
      rawValue: months,
      displayValue: months > 0
        ? `连续${months}月增持 (${chTons >= 0 ? '+' : ''}${chTons.toFixed(1)}t)`
        : `月度变动 ${chTons >= 0 ? '+' : ''}${chTons.toFixed(1)}t`,
      score,
      weight: WEIGHTS.pboc_reserve_cycle,
      effectiveWeight: 0,
      tone: toneOf(score),
      source: 'PBOC / 外管局官方储备',
      obsDate: input.obsDates?.pboc ?? null,
    });
  } else {
    missingMetrics.push('pboc_reserve_cycle');
  }

  // 3) 2s10s 收益率曲线周期（倒挂解除陡峭化通常对应宽松与衰退避险）
  if (
    input.us10y != null && Number.isFinite(input.us10y)
    && input.us2y != null && Number.isFinite(input.us2y)
  ) {
    const spread2s10s = (input.us10y - input.us2y) * 100; // bp
    // 适度正斜率陡峭化对黄金温和偏多，深度倒挂（紧缩顶部）偏压制
    const score = Math.round(clamp(50 + 18 * Math.tanh(spread2s10s / 80), 25, 75));
    metrics.push({
      key: 'yield_curve_cycle',
      label: '美债 10Y-2Y 政策曲线',
      rawValue: round(spread2s10s, 0),
      displayValue: `${spread2s10s >= 0 ? '+' : ''}${Math.round(spread2s10s)}bp`,
      score,
      weight: WEIGHTS.yield_curve_cycle,
      effectiveWeight: 0,
      tone: toneOf(score),
      source: 'FRED DGS10 / DGS2',
      obsDate: input.obsDates?.us2y ?? null,
    });
  } else {
    missingMetrics.push('yield_curve_cycle');
  }

  // 4) 国内外交易监管与财政制度（可选）
  if (input.regulatoryScore != null && Number.isFinite(input.regulatoryScore)) {
    const score = Math.round(clamp(input.regulatoryScore, 10, 90));
    metrics.push({
      key: 'regulatory_stance',
      label: '监管与财政制度环境',
      rawValue: score,
      displayValue: input.regulatoryNote || `${score}/100`,
      score,
      weight: WEIGHTS.regulatory_stance,
      effectiveWeight: 0,
      tone: toneOf(score),
      source: '央行/上金所监管公告',
      obsDate: null,
    });
  } else {
    missingMetrics.push('regulatory_stance');
  }

  const coverage = round(metrics.reduce((s, m) => s + m.weight, 0), 4);
  let score = 50;
  if (coverage > 0) {
    let sum = 0;
    for (const m of metrics) {
      m.effectiveWeight = round(m.weight / coverage, 4);
      sum += m.score * (m.weight / coverage);
    }
    score = Math.round(clamp(sum, 0, 100));
  }

  const direction = directionFromScore(score);
  const detailText = metrics.length > 0
    ? metrics.slice(0, 2).map(m => `${m.label} ${m.displayValue}`).join('；')
    : '政策利率/央行储备数据暂缺';

  return {
    score,
    direction,
    coverage,
    metrics,
    missingMetrics,
    cycleLabel,
    summary: `政策面 ${score}/100（${cycleLabel}，覆盖 ${Math.round(coverage * 100)}%）：${detailText}`,
  };
}
