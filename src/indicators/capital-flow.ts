// S1 资金面（市场微观结构分析）— 纯本地纯函数，零 LLM / 零 DB / 零网络
// 正交边界：仅衡量「边际资金流入/流出与跨市场微观价差」：
//   1. GLD 5D/20D 平滑 tanh 资金流（或 GLD 20日量价动量代理）
//   2. CFTC 非商业净多头 4 周边际变化 Δ(Net/OI)（绝不含 3 年存量拥挤分位，后者归 S4 筹码面）
//   3. 上海金（SGE Au99.99）相对伦敦金折溢价（¥/克）
//   4. COMEX 成交量与价格配合动能
//   5. 国内黄金 ETF（518880）份额净流

import type { Direction } from '../types/analysis.js';
import { directionFromScore } from '../utils/decision-thresholds.js';

export interface CapitalFlowMetric {
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

export interface CapitalFlowInput {
  /** GLD 近 5 日持仓变化（吨） */
  gldChange5dTons?: number | null;
  /** GLD 近 20 日持仓变化（吨） */
  gldChange20dTons?: number | null;
  /** GLD 20 日价格动量（%），无吨数时作为次级代理 */
  gld20dReturnPct?: number | null;
  /** CFTC 近 4 周 Net/OI 边际变化（如 +0.03 表示 +3 个百分点） */
  cftcDelta4wNetOi?: number | null;
  /** CFTC 近 4 周净多手数变化（缺少 OI 时的回退） */
  cftcDelta4wContracts?: number | null;
  /** 上海金 Au99.99 相对伦敦金折算人民币价的溢价（¥/克） */
  sgePremiumCny?: number | null;
  /** COMEX 当日成交量相对 20 日均量比值（如 1.35 表示放量 35%） */
  comexVolumeRatio?: number | null;
  /** 黄金近 5 日涨跌幅（%），用于判断放量方向（放量上涨 vs 放量下跌） */
  gold5dReturnPct?: number | null;
  /** 国内 518880 黄金 ETF 近 5 日份额净流入（亿份） */
  cnEtf5dFlow?: number | null;
  /** 数据观测日期映射 */
  obsDates?: {
    gld?: string | null;
    cftc?: string | null;
    sge?: string | null;
    comex?: string | null;
    cnEtf?: string | null;
  };
}

export interface CapitalFlowResult {
  score: number;
  direction: Direction;
  coverage: number;
  metrics: CapitalFlowMetric[];
  missingMetrics: string[];
  summary: string;
}

const WEIGHTS = {
  gld_flow: 0.30,
  cftc_delta_4w: 0.28,
  sge_premium: 0.20,
  comex_vol_flow: 0.12,
  cn_etf_flow: 0.10,
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

export function computeCapitalFlowDimension(input: CapitalFlowInput): CapitalFlowResult {
  const metrics: CapitalFlowMetric[] = [];
  const missingMetrics: string[] = [];

  // 1) GLD ETF 边际资金流（平滑 tanh，零悬崖）
  if (input.gldChange5dTons != null && Number.isFinite(input.gldChange5dTons)) {
    const ch5 = input.gldChange5dTons;
    const ch20 = input.gldChange20dTons != null && Number.isFinite(input.gldChange20dTons)
      ? input.gldChange20dTons
      : ch5 * 2;
    const s5 = 50 + 28 * Math.tanh(ch5 / 8);
    const s20 = 50 + 24 * Math.tanh(ch20 / 20);
    const score = Math.round(clamp(0.55 * s5 + 0.45 * s20, 12, 88));
    metrics.push({
      key: 'gld_flow',
      label: 'SPDR GLD 边际资金流',
      rawValue: round(ch5, 2),
      displayValue: `5日 ${ch5 >= 0 ? '+' : ''}${ch5.toFixed(1)}t / 20日 ${ch20 >= 0 ? '+' : ''}${ch20.toFixed(1)}t`,
      score,
      weight: WEIGHTS.gld_flow,
      effectiveWeight: 0,
      tone: toneOf(score),
      source: 'SPDR GLD / 东财',
      obsDate: input.obsDates?.gld ?? null,
    });
  } else if (input.gld20dReturnPct != null && Number.isFinite(input.gld20dReturnPct)) {
    const r20 = input.gld20dReturnPct;
    const score = Math.round(clamp(50 + 26 * Math.tanh(r20 / 5), 15, 85));
    metrics.push({
      key: 'gld_flow',
      label: 'GLD ETF 20日资金动量',
      rawValue: round(r20, 2),
      displayValue: `20日 ${r20 >= 0 ? '+' : ''}${r20.toFixed(2)}%`,
      score,
      weight: WEIGHTS.gld_flow,
      effectiveWeight: 0,
      tone: toneOf(score),
      source: 'Yahoo GLD',
      obsDate: input.obsDates?.gld ?? null,
    });
  } else {
    missingMetrics.push('gld_flow');
  }

  // 2) CFTC 4 周边际变化 Δ(Net/OI)（纯边际动能，与 S4 3年分位严格正交）
  if (input.cftcDelta4wNetOi != null && Number.isFinite(input.cftcDelta4wNetOi)) {
    const d = input.cftcDelta4wNetOi;
    const score = Math.round(clamp(50 + 28 * Math.tanh(d / 0.05), 12, 88));
    metrics.push({
      key: 'cftc_delta_4w',
      label: 'CFTC 4周边际 Δ(Net/OI)',
      rawValue: round(d * 100, 2),
      displayValue: `${d >= 0 ? '+' : ''}${(d * 100).toFixed(2)}pp`,
      score,
      weight: WEIGHTS.cftc_delta_4w,
      effectiveWeight: 0,
      tone: toneOf(score),
      source: 'CFTC COT',
      obsDate: input.obsDates?.cftc ?? null,
    });
  } else if (input.cftcDelta4wContracts != null && Number.isFinite(input.cftcDelta4wContracts)) {
    const dc = input.cftcDelta4wContracts;
    const score = Math.round(clamp(50 + 26 * Math.tanh(dc / 25000), 12, 88));
    metrics.push({
      key: 'cftc_delta_4w',
      label: 'CFTC 4周净多变动',
      rawValue: Math.round(dc),
      displayValue: `${dc >= 0 ? '+' : ''}${Math.round(dc).toLocaleString()} 手`,
      score,
      weight: WEIGHTS.cftc_delta_4w,
      effectiveWeight: 0,
      tone: toneOf(score),
      source: 'CFTC COT',
      obsDate: input.obsDates?.cftc ?? null,
    });
  } else {
    missingMetrics.push('cftc_delta_4w');
  }

  // 3) 上海金 SGE Au99.99 相对伦敦金溢价（反映中国现货买盘紧缺度）
  if (input.sgePremiumCny != null && Number.isFinite(input.sgePremiumCny)) {
    const prem = input.sgePremiumCny;
    // 常态溢价约 +1~+4 元/克，显著正溢价偏多，贴水偏弱
    const score = Math.round(clamp(50 + 24 * Math.tanh((prem - 2) / 6), 18, 82));
    metrics.push({
      key: 'sge_premium',
      label: '上海金 SGE 现货溢价',
      rawValue: round(prem, 2),
      displayValue: `${prem >= 0 ? '+' : ''}¥${prem.toFixed(2)}/克`,
      score,
      weight: WEIGHTS.sge_premium,
      effectiveWeight: 0,
      tone: toneOf(score),
      source: '上金所 Au99.99 vs 伦敦金',
      obsDate: input.obsDates?.sge ?? null,
    });
  } else {
    missingMetrics.push('sge_premium');
  }

  // 4) COMEX 成交量与价格配合（放量上涨偏多，放量下跌偏空，缩量归中性）
  if (input.comexVolumeRatio != null && Number.isFinite(input.comexVolumeRatio) && input.comexVolumeRatio > 0) {
    const vr = input.comexVolumeRatio;
    const ret5 = input.gold5dReturnPct ?? 0;
    const signedVol = (vr - 1) * Math.tanh(ret5 / 2.5);
    const score = Math.round(clamp(50 + 22 * Math.tanh(signedVol * 1.6), 20, 80));
    metrics.push({
      key: 'comex_vol_flow',
      label: 'COMEX 量价资金配合',
      rawValue: round(vr, 2),
      displayValue: `量比 ${vr.toFixed(2)}x`,
      score,
      weight: WEIGHTS.comex_vol_flow,
      effectiveWeight: 0,
      tone: toneOf(score),
      source: 'Yahoo GC=F Volume',
      obsDate: input.obsDates?.comex ?? null,
    });
  } else {
    missingMetrics.push('comex_vol_flow');
  }

  // 5) 国内 518880 黄金 ETF 份额净流
  if (input.cnEtf5dFlow != null && Number.isFinite(input.cnEtf5dFlow)) {
    const fl = input.cnEtf5dFlow;
    const score = Math.round(clamp(50 + 22 * Math.tanh(fl / 1.5), 20, 80));
    metrics.push({
      key: 'cn_etf_flow',
      label: '国内黄金ETF(518880)份额流',
      rawValue: round(fl, 2),
      displayValue: `${fl >= 0 ? '+' : ''}${fl.toFixed(2)} 亿份`,
      score,
      weight: WEIGHTS.cn_etf_flow,
      effectiveWeight: 0,
      tone: toneOf(score),
      source: '华安黄金ETF 518880',
      obsDate: input.obsDates?.cnEtf ?? null,
    });
  } else {
    missingMetrics.push('cn_etf_flow');
  }

  const coverage = round(metrics.reduce((s, m) => s + m.weight, 0), 4);
  let score = 50;
  if (coverage > 0) {
    let weightedSum = 0;
    for (const m of metrics) {
      m.effectiveWeight = round(m.weight / coverage, 4);
      weightedSum += m.score * (m.weight / coverage);
    }
    score = Math.round(clamp(weightedSum, 0, 100));
  }

  const direction = directionFromScore(score);
  const topNote = metrics.length > 0
    ? metrics.slice(0, 2).map(m => `${m.label} ${m.displayValue}`).join('；')
    : '资金面高频观测暂缺，按中性重归一';

  return {
    score,
    direction,
    coverage,
    metrics,
    missingMetrics,
    summary: `资金面 ${score}/100（覆盖 ${Math.round(coverage * 100)}%）：${topNote}`,
  };
}
