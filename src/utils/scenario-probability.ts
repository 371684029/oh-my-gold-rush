// 情景概率统计化（v2.4 F05 重构）
// 引入 Dirichlet/Beta 经验贝叶斯收缩（向历史无条件基率收缩，先验强度 k=15）
// + 波动率自适应三情景边界（±0.5 * sigma5d），消除 n=3 极小样本过拟合与固定 ±1% 阈值失真。

import type { PatternMatch } from '../types/calibration.js';
import type { Scenarios } from '../types/analysis.js';

export interface ScenarioProbabilities {
  base: number;
  upside: number;
  downside: number;
  sampleSize: number;
  source: 'historical' | 'insufficient';
  /** 实际采用的上行/下行阈值（%） */
  thresholdPct?: number;
  note: string;
}

export interface ScenarioProbabilityOptions {
  /** 5 日波动率（%，如 2.8 表示 2.8%）；传入后自动使用 ±0.5 * sigma5d 边界 */
  sigma5dPct?: number | null;
  /** 经验贝叶斯先验强度 k（默认 15） */
  priorStrength?: number;
  /** 历史无条件基率先验（默认 50 / 27 / 23，合计 100） */
  priorRates?: { base: number; upside: number; downside: number };
}

const DEFAULT_THRESHOLD_PCT = 1.0;
const DEFAULT_PRIOR_K = 15;
const DEFAULT_PRIOR = { base: 0.50, upside: 0.27, downside: 0.23 };

/**
 * F05: 从已回填相似日统计三情景概率（Dirichlet 经验贝叶斯收缩 + 波动率自适应阈值）。
 * 样本 < 3 时返回 insufficient；样本 >= 3 时按 k=15 先验平滑收缩，保证下行 >= 15% 且总和严格 100%。
 */
export function computeScenarioProbabilities(
  matches: PatternMatch[],
  options: ScenarioProbabilityOptions = {},
): ScenarioProbabilities {
  const filled = matches.filter(m => m.actual5dReturn != null && Number.isFinite(m.actual5dReturn));
  const threshold = options.sigma5dPct != null && Number.isFinite(options.sigma5dPct) && options.sigma5dPct > 0
    ? Math.max(0.6, Math.min(4.0, Math.round(options.sigma5dPct * 0.5 * 100) / 100))
    : DEFAULT_THRESHOLD_PCT;

  if (filled.length < 3) {
    return {
      base: 50,
      upside: 25,
      downside: 25,
      sampleSize: filled.length,
      source: 'insufficient',
      thresholdPct: threshold,
      note: `相似日样本 ${filled.length} 不足 3，保留历史先验概率`,
    };
  }

  let up = 0;
  let down = 0;
  let base = 0;
  for (const m of filled) {
    const r = m.actual5dReturn!;
    if (r >= threshold) up++;
    else if (r <= -threshold) down++;
    else base++;
  }

  const n = filled.length;
  const k = options.priorStrength ?? DEFAULT_PRIOR_K;
  const prior = options.priorRates ?? DEFAULT_PRIOR;
  const priorSum = prior.base + prior.upside + prior.downside || 1;
  const p0Base = prior.base / priorSum;
  const p0Up = prior.upside / priorSum;
  const p0Down = prior.downside / priorSum;

  // Dirichlet 后验均值：(count + k * p0) / (n + k)
  const denom = n + k;
  let pUp = Math.round(((up + k * p0Up) / denom) * 100);
  let pDown = Math.round(((down + k * p0Down) / denom) * 100);
  let pBase = 100 - pUp - pDown;

  if (pDown < 15) {
    const need = 15 - pDown;
    pDown = 15;
    pBase = Math.max(0, pBase - need);
    if (pUp + pBase + pDown > 100) pUp = 100 - pDown - pBase;
  }

  const sum = pBase + pUp + pDown;
  if (sum !== 100) {
    pBase += 100 - sum;
  }

  return {
    base: pBase,
    upside: pUp,
    downside: pDown,
    sampleSize: n,
    source: 'historical',
    thresholdPct: threshold,
    note: `基于 ${n} 个相似日 5 日收益（阈值 ±${threshold}%，Dirichlet 先验 k=${k} 贝叶斯收缩）`,
  };
}

/** 将统计概率写入情景（保留 LLM 叙述） */
export function applyScenarioProbabilities(
  scenarios: Scenarios,
  probs: ScenarioProbabilities,
): Scenarios {
  if (probs.source !== 'historical') return scenarios;
  return {
    base: { ...scenarios.base, probability: probs.base },
    upside: { ...scenarios.upside, probability: probs.upside },
    downside: { ...scenarios.downside, probability: probs.downside },
  };
}

export function formatScenarioProbLine(probs: ScenarioProbabilities): string {
  if (probs.source === 'historical') {
    return `统计概率（${probs.note}）：基准 ${probs.base}% / 上行 ${probs.upside}% / 下行 ${probs.downside}%`;
  }
  return probs.note;
}
