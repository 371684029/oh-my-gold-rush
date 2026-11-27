// S3 情绪面（行为金融学分析）— 纯本地纯函数，零 LLM / 零 DB / 零网络
// 正交边界：聚焦「恐惧/贪婪、羊群效应与过度反应」，与客观资金流（S1）及存量筹码（S4）彻底解耦。
// 核心纪律：仅在短期（5D / 20D）赋予权重，季度与多年视野严格置 0%。

import type { Direction } from '../types/analysis.js';
import { directionFromScore } from '../utils/decision-thresholds.js';

export interface BehavioralSentimentMetric {
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

export interface BehavioralSentimentInput {
  /** CBOE 黄金隐含波动率 GVZ */
  gvz?: number | null;
  /** CBOE 美股恐慌指数 VIX */
  vix?: number | null;
  /** RSI(14) 数值（0-100） */
  rsi14?: number | null;
  /** 连续同向涨跌交易日数（正=连涨天数，负=连跌天数） */
  consecutiveDirectionDays?: number | null;
  /** 价格相对 MA20 偏离的 Z-score（正=高于均线，负=低于均线） */
  ma20DevZscore?: number | null;
  obsDate?: string | null;
}

export interface BehavioralSentimentResult {
  score: number;
  direction: Direction;
  coverage: number;
  metrics: BehavioralSentimentMetric[];
  missingMetrics: string[];
  /** 行为金融风控警示（如「防 FOMO 追高」或「防恐慌割肉」） */
  behaviorWarning: string | null;
  summary: string;
}

const WEIGHTS = {
  gvz_vix_regime: 0.35,
  rsi_extreme_behavior: 0.35,
  herding_overreaction: 0.30,
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

export function computeBehavioralSentimentDimension(input: BehavioralSentimentInput): BehavioralSentimentResult {
  const metrics: BehavioralSentimentMetric[] = [];
  const missingMetrics: string[] = [];
  const warnings: string[] = [];

  // 1) GVZ 与 VIX 跨资产恐慌结构（区分「黄金避险溢价」vs「跨市场流动性恐慌抛售」）
  if (input.gvz != null && Number.isFinite(input.gvz) && input.gvz > 0) {
    const gvz = input.gvz;
    const vix = input.vix != null && Number.isFinite(input.vix) && input.vix > 0 ? input.vix : null;
    const ratio = vix != null ? gvz / vix : null;

    let score = 50;
    let stateText = '情绪常态';
    if (vix != null && vix >= 35 && gvz >= 28) {
      // 极端流动性危机（类似 2020-03），连黄金都会被无差别抛售换现金
      score = 38;
      stateText = '流动性恐慌警戒';
      warnings.push('VIX 与 GVZ 同步飙升，警惕流动性追缴抛压');
    } else if (gvz >= 26) {
      // 黄金自身波动极端狂热，短线均值回归风险上升
      score = 40;
      stateText = '金市波动过热';
      warnings.push('GVZ 处高位，短线情绪偏躁动，忌追高');
    } else if (vix != null && vix >= 22 && gvz < 22) {
      // 股市恐慌而金市平稳 -> 黄金避险买盘温和受益
      score = 62;
      stateText = '跨市场避险受益';
    } else if (gvz <= 13) {
      score = 52;
      stateText = '低波平静期';
    }

    metrics.push({
      key: 'gvz_vix_regime',
      label: 'GVZ / VIX 恐慌结构',
      rawValue: round(ratio ?? gvz, 2),
      displayValue: vix != null
        ? `GVZ ${gvz.toFixed(1)} / VIX ${vix.toFixed(1)} (${stateText})`
        : `GVZ ${gvz.toFixed(1)} (${stateText})`,
      score,
      weight: WEIGHTS.gvz_vix_regime,
      effectiveWeight: 0,
      tone: toneOf(score),
      source: 'CBOE ^GVZ / ^VIX',
      obsDate: input.obsDate ?? null,
    });
  } else {
    missingMetrics.push('gvz_vix_regime');
  }

  // 2) RSI(14) 极端行为分段（与 F08 完全对齐：>75 狂热过热警示，<25 恐慌逆向修复）
  if (input.rsi14 != null && Number.isFinite(input.rsi14)) {
    const rsi = input.rsi14;
    let score = 50;
    let tag = '情绪平衡';
    if (rsi >= 75) {
      score = Math.round(clamp(44 - (rsi - 75) * 0.8, 22, 44));
      tag = 'FOMO狂热过热';
      warnings.push(`RSI(14)=${rsi.toFixed(1)} 过热，防 FOMO 追高`);
    } else if (rsi >= 68) {
      score = 48;
      tag = '偏热警惕';
    } else if (rsi <= 25) {
      score = Math.round(clamp(58 + (25 - rsi) * 0.8, 58, 78));
      tag = '恐慌超卖逆向';
      warnings.push(`RSI(14)=${rsi.toFixed(1)} 恐慌超卖，防情绪化割肉`);
    } else if (rsi <= 32) {
      score = 55;
      tag = '悲观偏冷';
    } else if (rsi > 50) {
      score = 54;
      tag = '温和乐观';
    } else {
      score = 46;
      tag = '温和谨慎';
    }

    metrics.push({
      key: 'rsi_extreme_behavior',
      label: 'RSI(14) 过度反应段',
      rawValue: round(rsi, 1),
      displayValue: `${rsi.toFixed(1)}（${tag}）`,
      score,
      weight: WEIGHTS.rsi_extreme_behavior,
      effectiveWeight: 0,
      tone: toneOf(score),
      source: '本地价格行为衍生',
      obsDate: input.obsDate ?? null,
    });
  } else {
    missingMetrics.push('rsi_extreme_behavior');
  }

  // 3) 羊群效应与偏离 MA20 Z-score（连涨/连跌天数 + 均值偏离拥挤度，逆向行为修正）
  const hasConsec = input.consecutiveDirectionDays != null && Number.isFinite(input.consecutiveDirectionDays);
  const hasZ = input.ma20DevZscore != null && Number.isFinite(input.ma20DevZscore);
  if (hasConsec || hasZ) {
    const consec = hasConsec ? input.consecutiveDirectionDays! : 0;
    const z = hasZ ? input.ma20DevZscore! : 0;
    let score = 50;
    if (z >= 2.0 || consec >= 5) {
      score = Math.round(clamp(50 - Math.max(z * 8, consec * 3), 24, 44));
      warnings.push('短期羊群追涨拥挤，均值回归压力上升');
    } else if (z <= -2.0 || consec <= -5) {
      score = Math.round(clamp(50 + Math.max(Math.abs(z) * 8, Math.abs(consec) * 3), 56, 76));
      warnings.push('连续杀跌触发恐慌羊群，关注逆向修复');
    } else {
      score = Math.round(clamp(50 - z * 4, 40, 60));
    }

    const parts: string[] = [];
    if (hasZ) parts.push(`Z=${z >= 0 ? '+' : ''}${z.toFixed(2)}σ`);
    if (hasConsec && consec !== 0) parts.push(`${consec > 0 ? '连涨' : '连跌'}${Math.abs(consec)}日`);

    metrics.push({
      key: 'herding_overreaction',
      label: '羊群效应 / MA20 Z-score',
      rawValue: round(hasZ ? z : consec, 2),
      displayValue: parts.join(' · ') || '常态',
      score,
      weight: WEIGHTS.herding_overreaction,
      effectiveWeight: 0,
      tone: toneOf(score),
      source: '本地价格行为衍生',
      obsDate: input.obsDate ?? null,
    });
  } else {
    missingMetrics.push('herding_overreaction');
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
  const behaviorWarning = warnings.length > 0 ? warnings[0]! : null;
  const note = metrics.length > 0
    ? metrics.map(m => `${m.label} ${m.displayValue}`).slice(0, 2).join('；')
    : '行为情绪观测暂缺';

  return {
    score,
    direction,
    coverage,
    metrics,
    missingMetrics,
    behaviorWarning,
    summary: `情绪面 ${score}/100（覆盖 ${Math.round(coverage * 100)}%）：${note}${behaviorWarning ? `；⚠️ ${behaviorWarning}` : ''}`,
  };
}
