// S4 筹码面（供需关系与持仓成本结构）— 纯本地纯函数，零 LLM / 零 DB / 零网络
// 正交边界：聚焦「存量持仓拥挤度 + 筹码成本锚 + 实体金矿供给成本底盘」，
// 与 S1 资金面（4 周边际增量）严格正交，彻底消除 F09 CFTC 跨模块双计。

import type { Direction } from '../types/analysis.js';
import { directionFromScore } from '../utils/decision-thresholds.js';

export interface PositioningChipMetric {
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

export interface PositioningChipInput {
  /** CFTC 非商业净多头占总持仓比例 (Net / OI) 的 3 年滚动分位（0-100，反向拥挤信号） */
  cftcNetOiPercentile3y?: number | null;
  /** 当前金价（USD/oz） */
  spotUsd?: number | null;
  /** 60D 或 250D 成交量加权平均成本（VWAP）或长周期均线成本锚（USD/oz） */
  costAnchorUsd?: number | null;
  /** 成本锚说明标签（如「60D VWAP」或「MA36M 周期成本锚」） */
  costAnchorLabel?: string;
  /** 全球金矿平均全维持成本 AISC（USD/oz，默认 1450，WGC 季度数据锚，显式标注滞后） */
  globalAiscUsd?: number | null;
  /** COMEX 可交割库存 20 日变化（%），负值=库存下降紧缺偏多 */
  comexInventoryChangePct?: number | null;
  obsDates?: {
    cftc?: string | null;
    costAnchor?: string | null;
    aisc?: string | null;
  };
}

export interface PositioningChipResult {
  score: number;
  direction: Direction;
  coverage: number;
  metrics: PositioningChipMetric[];
  missingMetrics: string[];
  crowdingWarning: string | null;
  summary: string;
}

const WEIGHTS = {
  cftc_crowding_3y: 0.45,
  cost_anchor_profit_ratio: 0.35,
  aisc_supply_floor: 0.20,
} as const;

/** WGC 全球金矿全维持成本参考锚（季度滞后，仅作极端长期供给硬支撑） */
export const DEFAULT_GLOBAL_AISC_USD = 1450;

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

export function computePositioningChipDimension(input: PositioningChipInput): PositioningChipResult {
  const metrics: PositioningChipMetric[] = [];
  const missingMetrics: string[] = [];
  let crowdingWarning: string | null = null;

  // 1) CFTC Net/OI 3 年存量拥挤分位（反向：>=85% 筹码拥挤警示，<=15% 筹码出清弹性高）
  if (input.cftcNetOiPercentile3y != null && Number.isFinite(input.cftcNetOiPercentile3y)) {
    const pct = clamp(input.cftcNetOiPercentile3y, 0, 100);
    let score: number;
    let tag: string;
    if (pct >= 85) {
      score = Math.round(clamp(32 - (pct - 85) * 0.8, 18, 32));
      tag = '多头筹码拥挤';
      crowdingWarning = `CFTC Net/OI 处 3 年第 ${Math.round(pct)}% 分位，存量筹码高度拥挤`;
    } else if (pct <= 15) {
      score = Math.round(clamp(68 + (15 - pct) * 0.8, 68, 82));
      tag = '筹码出清低位';
    } else {
      score = Math.round(50 - ((pct - 50) / 50) * 14);
      tag = '筹码分布均衡';
    }

    metrics.push({
      key: 'cftc_crowding_3y',
      label: 'CFTC Net/OI 3年拥挤分位',
      rawValue: round(pct, 1),
      displayValue: `第 ${Math.round(pct)}% 分位（${tag}）`,
      score,
      weight: WEIGHTS.cftc_crowding_3y,
      effectiveWeight: 0,
      tone: toneOf(score),
      source: 'CFTC COT (Net/OI 3Y)',
      obsDate: input.obsDates?.cftc ?? null,
    });
  } else {
    missingMetrics.push('cftc_crowding_3y');
  }

  // 2) 持仓成本锚偏离（现价相对 VWAP / 长周期成本均线：显著高估意味着获利盘丰厚、回吐压力上升）
  if (
    input.spotUsd != null && Number.isFinite(input.spotUsd) && input.spotUsd > 0
    && input.costAnchorUsd != null && Number.isFinite(input.costAnchorUsd) && input.costAnchorUsd > 0
  ) {
    const devPct = ((input.spotUsd - input.costAnchorUsd) / input.costAnchorUsd) * 100;
    // 贴近成本锚（0%~+8%）支撑强偏多；偏离 >+25% 获利盘获利了结压力上升；深度跌破成本锚 <-10% 性价比显现
    let score: number;
    let tag: string;
    if (devPct >= 25) {
      score = Math.round(clamp(44 - (devPct - 25) * 0.6, 24, 44));
      tag = '获利盘丰厚';
    } else if (devPct >= 0) {
      score = Math.round(clamp(56 - devPct * 0.4, 46, 58));
      tag = '成本线上方稳健';
    } else if (devPct >= -12) {
      score = Math.round(clamp(54 + Math.abs(devPct) * 0.8, 54, 64));
      tag = '贴近成本支撑带';
    } else {
      score = Math.round(clamp(64 + Math.min(16, (Math.abs(devPct) - 12) * 0.8), 64, 80));
      tag = '跌破筹码成本区';
    }

    metrics.push({
      key: 'cost_anchor_profit_ratio',
      label: input.costAnchorLabel || '市场持仓成本锚(VWAP/均线)',
      rawValue: round(devPct, 2),
      displayValue: `相对 $${Math.round(input.costAnchorUsd)} ${devPct >= 0 ? '+' : ''}${devPct.toFixed(1)}%（${tag}）`,
      score,
      weight: WEIGHTS.cost_anchor_profit_ratio,
      effectiveWeight: 0,
      tone: toneOf(score),
      source: '本地量价成本分布',
      obsDate: input.obsDates?.costAnchor ?? null,
    });
  } else {
    missingMetrics.push('cost_anchor_profit_ratio');
  }

  // 3) 全球金矿 AISC 全维持成本供给硬底（仅提供长周期供给安全边际参考）
  if (input.spotUsd != null && Number.isFinite(input.spotUsd) && input.spotUsd > 0) {
    const aisc = input.globalAiscUsd != null && input.globalAiscUsd > 0
      ? input.globalAiscUsd
      : DEFAULT_GLOBAL_AISC_USD;
    const ratio = input.spotUsd / aisc;
    // ratio <= 1.2 矿企利润薄、供给硬支撑极强（偏多）；ratio > 2.2 矿企扩产激励强（中性偏谨慎）
    let score: number;
    let tag: string;
    if (ratio <= 1.25) {
      score = 72;
      tag = '贴近全球矿企硬成本底';
    } else if (ratio <= 1.75) {
      score = 56;
      tag = '成本安全边际适中';
    } else if (ratio <= 2.3) {
      score = 46;
      tag = '矿企利润丰厚';
    } else {
      score = 40;
      tag = '显著高于矿企成本';
    }

    metrics.push({
      key: 'aisc_supply_floor',
      label: '全球矿企 AISC 供给底盘',
      rawValue: round(ratio, 2),
      displayValue: `${ratio.toFixed(2)}x AISC ($${aisc}/oz · WGC季滞后 · ${tag})`,
      score,
      weight: WEIGHTS.aisc_supply_floor,
      effectiveWeight: 0,
      tone: toneOf(score),
      source: 'WGC 全球金矿 AISC（季度滞后）',
      obsDate: input.obsDates?.aisc ?? 'quarterly-anchor',
    });
  } else {
    missingMetrics.push('aisc_supply_floor');
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
  const note = metrics.length > 0
    ? metrics.slice(0, 2).map(m => `${m.label} ${m.displayValue}`).join('；')
    : '筹码供需数据暂缺';

  return {
    score,
    direction,
    coverage,
    metrics,
    missingMetrics,
    crowdingWarning,
    summary: `筹码面 ${score}/100（覆盖 ${Math.round(coverage * 100)}%）：${note}`,
  };
}
