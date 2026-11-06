// 当前仓位推荐 — 相对「计划黄金仓位」的 0–100% 建议（非绝对账户杠杆）
//
// v2：在门禁/双分约束之上增加：
//   - 波动缩放（金价晃得厉害 → 少拿一点）
//   - 近窗回撤刹车
//   - 相对昨日目标仓日平滑（别一天跳 30%）

import type { Direction } from '../types/analysis.js';
import {
  buildDualConflictOverride,
  dualDirectionFromScore,
} from './dual-score.js';

export type PositionLabel = '极轻' | '偏轻' | '标配' | '偏积极' | '积极';

/** 风险角标（给人看的） */
export type PositionRiskBadge = '平稳' | '偏高波动' | '高波动' | '近窗回撤' | '日调受限';

export interface PositionRecommendation {
  /** 相对计划黄金总仓 0–100 */
  targetPct: number;
  /** 平滑/约束前的原始目标（便于解释） */
  rawTargetPct: number;
  /** 其中定投/底仓占比（占 target 的百分比） */
  coreSharePct: number;
  /** 波段/卫星仓占比（占 target） */
  satelliteSharePct: number;
  label: PositionLabel;
  emoji: string;
  headline: string;
  action: string;
  reasons: string[];
  /** 约束标记：门禁红、双分冲突、波动等 */
  constraints: string[];
  /** 建议操作：减/持/加 */
  tilt: 'reduce' | 'hold' | 'add';
  /** 风险摘要（Web 角标） */
  risk: {
    /** 近 20 日年化波动近似 %（由日收益标准差推算） */
    vol20AnnPct: number | null;
    /** 近 60 日从高点回撤 %（正数表示已回撤） */
    drawdown60Pct: number | null;
    /** 昨日目标仓（若有） */
    prevTargetPct: number | null;
    /** 相对昨日调整（百分点） */
    deltaFromPrev: number | null;
    /** 波动缩放系数 0.7–1.0 */
    volScalar: number;
    /** 回撤缩放系数 */
    ddScalar: number;
    badges: PositionRiskBadge[];
    /** 一句人话 */
    summary: string;
  };
}

export interface PositionRecommendInput {
  llmScore: number;
  quantScore?: number | null;
  dataActionable?: boolean;
  /** dual-score actionPolicy */
  dualPolicy?: string | null;
  flowScore?: number | null;
  longTermStance?: 'overweight' | 'neutral' | 'underweight' | null;
  consistencyLevel?: 'strong' | 'moderate' | 'weak' | null;
  direction?: Direction | null;
  /**
   * 伦敦金收盘序列（旧→新），用于波动与回撤。
   * 不足时跳过风险缩放。
   */
  closes?: number[] | null;
  /** 昨日/上一报告目标仓 %（日平滑） */
  previousTargetPct?: number | null;
  /** 单日最大变动百分点，默认 10 */
  maxDailyDelta?: number;
}

/** 日平滑默认上限（百分点） */
export const POSITION_MAX_DAILY_DELTA = 10;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * 综合分 → 基础目标仓 %（仓位推荐的核心映射，单一来源）。
 * 纸面权益回放等历史重建场景必须复用本映射，禁止另写一套档位表。
 */
export function scoreToBasePct(score: number): number {
  if (score <= 25) return 25;
  if (score <= 35) return 35;
  if (score <= 45) return 45;
  if (score <= 55) return 55;
  if (score <= 65) return 65;
  if (score <= 75) return 75;
  return 85;
}

function labelFromPct(pct: number): PositionLabel {
  if (pct <= 30) return '极轻';
  if (pct <= 45) return '偏轻';
  if (pct <= 60) return '标配';
  if (pct <= 75) return '偏积极';
  return '积极';
}

function emojiFromLabel(l: PositionLabel): string {
  if (l === '极轻') return '🔴';
  if (l === '偏轻') return '🟠';
  if (l === '标配') return '🟡';
  if (l === '偏积极') return '🟢';
  return '🔵';
}

/**
 * 从收盘价序列估计：
 * - 近 20 日收益标准差 × √252 → 年化波动%近似
 * - 近 60 日从峰值回撤%（正=已从高点回落）
 */
export function computePriceRiskMetrics(closes: number[]): {
  vol20AnnPct: number | null;
  drawdown60Pct: number | null;
} {
  const c = closes.filter(x => Number.isFinite(x) && x > 0);
  if (c.length < 5) {
    return { vol20AnnPct: null, drawdown60Pct: null };
  }

  // 日简单收益
  const rets: number[] = [];
  for (let i = 1; i < c.length; i++) {
    rets.push((c[i] - c[i - 1]) / c[i - 1]);
  }
  const last20 = rets.slice(-20);
  let vol20AnnPct: number | null = null;
  if (last20.length >= 10) {
    const mean = last20.reduce((a, b) => a + b, 0) / last20.length;
    const varSum = last20.reduce((a, b) => a + (b - mean) ** 2, 0) / last20.length;
    const dailyStd = Math.sqrt(varSum);
    vol20AnnPct = Math.round(dailyStd * Math.sqrt(252) * 1000) / 10; // 1 位小数
  }

  // 60 日回撤
  const win = c.slice(-60);
  let peak = win[0];
  let maxDd = 0;
  for (const px of win) {
    if (px > peak) peak = px;
    const dd = peak > 0 ? (peak - px) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }
  const drawdown60Pct = Math.round(maxDd * 1000) / 10;

  return { vol20AnnPct, drawdown60Pct };
}

/**
 * 波动 → 缩放系数：平静 1.0，偏高略降，很高再降（地板 0.72）
 * 经验阈值（黄金年化波动常见约 12–20%+）：
 *   <14% → 1.0
 *   14–18% → 0.92
 *   18–24% → 0.85
 *   >24% → 0.75
 */
export function volToScalar(vol20AnnPct: number | null): number {
  if (vol20AnnPct == null || !Number.isFinite(vol20AnnPct)) return 1;
  if (vol20AnnPct < 14) return 1;
  if (vol20AnnPct < 18) return 0.92;
  if (vol20AnnPct < 24) return 0.85;
  return 0.75;
}

/**
 * 回撤 → 缩放：从高点已回撤较多时进一步收卫星
 *   <5% → 1
 *   5–10% → 0.95
 *   10–15% → 0.88
 *   >15% → 0.8
 */
export function drawdownToScalar(ddPct: number | null): number {
  if (ddPct == null || !Number.isFinite(ddPct)) return 1;
  if (ddPct < 5) return 1;
  if (ddPct < 10) return 0.95;
  if (ddPct < 15) return 0.88;
  return 0.8;
}

/** 相对昨日目标仓平滑：单日最多动 maxDelta 个百分点 */
export function smoothTargetPct(
  raw: number,
  previous: number | null | undefined,
  maxDelta = POSITION_MAX_DAILY_DELTA,
): { target: number; applied: boolean; delta: number | null } {
  if (previous == null || !Number.isFinite(previous)) {
    return { target: raw, applied: false, delta: null };
  }
  const lo = previous - maxDelta;
  const hi = previous + maxDelta;
  const target = clamp(raw, lo, hi);
  return {
    target: Math.round(target),
    applied: target !== raw,
    delta: Math.round(target - previous),
  };
}

/**
 * 计算当前仓位推荐（相对计划仓，非杠杆倍数）
 */
export function recommendPosition(input: PositionRecommendInput): PositionRecommendation {
  const reasons: string[] = [];
  const constraints: string[] = [];
  const badges: PositionRiskBadge[] = [];

  // 1) 主分：有量化则取中点，避免单边极端
  let score = input.llmScore;
  if (input.quantScore != null && Number.isFinite(input.quantScore)) {
    score = Math.round((input.llmScore + input.quantScore) / 2);
    reasons.push(`综合参考分 ${score}（LLM ${input.llmScore} / 量化 ${input.quantScore} 均值）`);
  } else {
    reasons.push(`参考 LLM 分 ${input.llmScore}`);
  }

  let target = scoreToBasePct(score);

  // 2) 数据门禁红档：强制偏轻
  if (input.dataActionable === false) {
    target = Math.min(target, 35);
    constraints.push('数据门禁红档：上限 35%');
  }

  // 3) 双打分冲突弃权：压到标配以下
  if (input.dualPolicy === 'hold_on_conflict') {
    target = Math.min(target, 50);
    constraints.push('双分分歧：仓位上限 50%，定投层为主');
  }

  // 4) 弱一致
  if (input.consistencyLevel === 'weak') {
    target = Math.min(target, 50);
    constraints.push('四维一致性弱：不加仓');
  }

  // 5) 主力 flow
  if (input.flowScore != null) {
    if (input.flowScore <= 35) {
      target -= 8;
      reasons.push(`主力偏空（flow ${input.flowScore}）：卫星仓收缩`);
    } else if (input.flowScore >= 65) {
      target += 5;
      reasons.push(`主力偏多（flow ${input.flowScore}）：可略积极`);
    }
  }

  // 6) 长期配置档
  if (input.longTermStance === 'underweight') {
    target -= 5;
    reasons.push('长期档偏谨慎：总仓略降');
  } else if (input.longTermStance === 'overweight') {
    target += 5;
    reasons.push('长期档偏积极：总仓略升');
  }

  target = clamp(target, 15, 90);

  // 7) 波动 + 回撤风险缩放（v2）
  const metrics = computePriceRiskMetrics(input.closes ?? []);
  const volScalar = volToScalar(metrics.vol20AnnPct);
  const ddScalar = drawdownToScalar(metrics.drawdown60Pct);
  const riskScalar = volScalar * ddScalar;

  if (metrics.vol20AnnPct != null) {
    if (volScalar < 0.8) {
      badges.push('高波动');
      constraints.push(`高波动（近20日年化约 ${metrics.vol20AnnPct}%）：仓位×${volScalar}`);
    } else if (volScalar < 1) {
      badges.push('偏高波动');
      constraints.push(`偏高波动（近20日年化约 ${metrics.vol20AnnPct}%）：仓位×${volScalar}`);
    } else {
      badges.push('平稳');
      reasons.push(`波动正常（近20日年化约 ${metrics.vol20AnnPct}%）`);
    }
  }
  if (metrics.drawdown60Pct != null && ddScalar < 1) {
    badges.push('近窗回撤');
    constraints.push(`近60日自高点回撤约 ${metrics.drawdown60Pct}%：仓位×${ddScalar}`);
  }

  if (riskScalar < 0.999) {
    const before = target;
    target = target * riskScalar;
    reasons.push(`风险缩放 ${before.toFixed(0)}% → ${target.toFixed(0)}%（波动×回撤）`);
  }

  target = Math.round(clamp(target, 15, 90));
  const rawTargetPct = target;

  // 8) 日平滑（相对昨日）
  const maxDelta = input.maxDailyDelta ?? POSITION_MAX_DAILY_DELTA;
  const sm = smoothTargetPct(target, input.previousTargetPct, maxDelta);
  target = sm.target;
  if (sm.applied) {
    badges.push('日调受限');
    constraints.push(
      `日平滑：相对昨日 ${input.previousTargetPct}% 单日最多±${maxDelta}点 → 今日 ${target}%（原 ${rawTargetPct}%）`,
    );
  }

  // 定投层 vs 波段层：越谨慎，定投层占比越高；高波动再抬定投层
  let coreShare = 70;
  if (target <= 40) coreShare = 85;
  else if (target <= 55) coreShare = 75;
  else if (target >= 75) coreShare = 60;
  if (input.dualPolicy === 'hold_on_conflict' || input.dataActionable === false) {
    coreShare = Math.max(coreShare, 85);
  }
  if (volScalar <= 0.85 || ddScalar <= 0.88) {
    coreShare = Math.max(coreShare, 80);
  }
  const satelliteShare = 100 - coreShare;

  const label = labelFromPct(target);
  const emoji = emojiFromLabel(label);

  let tilt: PositionRecommendation['tilt'] = 'hold';
  if (target <= 40) tilt = 'reduce';
  else if (target >= 70) tilt = 'add';

  let headline: string;
  let action: string;
  if (input.dataActionable === false) {
    headline = '数据不可靠，建议维持轻仓纪律仓';
    action = `建议相对计划仓约 ${target}%（定投层 ${coreShare}% / 波段层 ${satelliteShare}%）；暂停加仓，修好数据再评估`;
  } else if (input.dualPolicy === 'hold_on_conflict') {
    // 与 evaluateDualScore / buildDualConflictOverride 共用同一套标题
    const q = input.quantScore;
    if (q != null && Number.isFinite(q)) {
      const llmDirection = dualDirectionFromScore(input.llmScore);
      const quantDirection = dualDirectionFromScore(q);
      const ov = buildDualConflictOverride({
        llmScore: input.llmScore,
        quantScore: Math.round(q),
        llmDirection,
        quantDirection,
        delta: Math.round(input.llmScore - q),
        sameDirection: llmDirection === quantDirection,
      });
      headline = ov.headline;
    } else {
      headline = '双分分歧，维持纪律仓、不追单边';
    }
    action = `建议相对计划仓约 ${target}%（${label}）；定投层为主（${coreShare}%），波段仓轻仓或空仓`;
  } else if (badges.includes('高波动') || badges.includes('近窗回撤')) {
    headline = '风险偏高，仓位已自动收一收';
    action = `建议相对计划仓约 ${target}%（${label}）；定投层为主（${coreShare}%），少做波段加仓`;
  } else if (tilt === 'reduce') {
    headline = '建议偏轻：控制黄金风险暴露';
    action = `建议相对计划仓约 ${target}%（${label}）；可降单次定投额，波段仓观望`;
  } else if (tilt === 'add') {
    headline = '可偏积极，但仍忌一次性重仓';
    action = `建议相对计划仓约 ${target}%（${label}）；定投维持，急跌再小加卫星仓`;
  } else {
    headline = '标配附近：纪律定投为主';
    action = `建议相对计划仓约 ${target}%（${label}）；按日历定投，少做择时加减`;
  }

  // 风险人话摘要
  const riskBits: string[] = [];
  if (metrics.vol20AnnPct != null) riskBits.push(`波动约${metrics.vol20AnnPct}%`);
  if (metrics.drawdown60Pct != null && metrics.drawdown60Pct >= 3) {
    riskBits.push(`近高点回撤${metrics.drawdown60Pct}%`);
  }
  if (sm.delta != null) riskBits.push(`较昨日${sm.delta > 0 ? '+' : ''}${sm.delta}点`);
  const riskSummary = riskBits.length
    ? riskBits.join(' · ')
    : '风险指标样本不足，未做波动缩放';

  return {
    targetPct: target,
    rawTargetPct,
    coreSharePct: coreShare,
    satelliteSharePct: satelliteShare,
    label,
    emoji,
    headline,
    action,
    reasons,
    constraints,
    tilt,
    risk: {
      vol20AnnPct: metrics.vol20AnnPct,
      drawdown60Pct: metrics.drawdown60Pct,
      prevTargetPct: input.previousTargetPct ?? null,
      deltaFromPrev: sm.delta,
      volScalar,
      ddScalar,
      badges: badges.length ? badges : ['平稳'],
      summary: riskSummary,
    },
  };
}

/**
 * 从上一份报告 JSON / 已解析报告中尽量取出昨日目标仓 %
 */
export function extractPreviousTargetPct(previous: unknown): number | null {
  if (!previous || typeof previous !== 'object') return null;
  const r = previous as Record<string, unknown>;
  // 直接字段（若将来写入 report）
  if (typeof r.positionTargetPct === 'number' && Number.isFinite(r.positionTargetPct)) {
    return Math.round(r.positionTargetPct);
  }
  const overall = r.overall as Record<string, unknown> | undefined;
  if (overall && typeof overall.positionTargetPct === 'number') {
    return Math.round(overall.positionTargetPct as number);
  }
  // MD 文本里解析（若只有字符串缓存）
  return null;
}

/** 从仓位 MD 小节文本解析目标 % */
export function parseTargetPctFromPositionMarkdown(md: string): number | null {
  const m = md.match(/相对计划仓\s*\*{0,2}(\d+)\s*%/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

export function formatPositionConsole(p: PositionRecommendation, indent = '  '): string {
  const riskBadges = p.risk.badges.join('·');
  const lines = [
    `${indent}📦 当前仓位推荐（相对计划黄金仓 · 风险约束 v2）`,
    `${indent}  ${p.emoji} ${p.label} · 目标 ${p.targetPct}%` +
      (p.rawTargetPct !== p.targetPct ? `（平滑前 ${p.rawTargetPct}%）` : '') +
      ` · 定投层 ${p.coreSharePct}% / 波段层 ${p.satelliteSharePct}%`,
    `${indent}  🛡️ 风险：${riskBadges} · ${p.risk.summary}`,
    `${indent}  ${p.headline}`,
    `${indent}  → ${p.action}`,
  ];
  if (p.constraints.length) {
    lines.push(`${indent}  约束：${p.constraints.join('；')}`);
  }
  if (p.reasons.length) {
    lines.push(`${indent}  依据：${p.reasons.slice(0, 4).join('；')}`);
  }
  lines.push(`${indent}  （非绝对账户比例，亦非杠杆建议）`);
  return lines.join('\n');
}

export function formatPositionMarkdown(p: PositionRecommendation): string {
  const riskBadges = p.risk.badges.map(b => `\`${b}\``).join(' ');
  const lines = [
    '## 📦 当前仓位推荐',
    '',
    `> ${p.emoji} **${p.label}** · 相对计划仓 **${p.targetPct}%**` +
      (p.rawTargetPct !== p.targetPct ? `（风险/平滑前 ${p.rawTargetPct}%）` : '') +
      ` · 定投层 ${p.coreSharePct}% / 波段层 ${p.satelliteSharePct}%`,
    '',
    `- **结论**：${p.headline}`,
    `- **操作**：${p.action}`,
    `- **倾向**：${p.tilt === 'reduce' ? '减仓/偏轻' : p.tilt === 'add' ? '可小幅积极' : '维持'}`,
    `- **风险角标**：${riskBadges}`,
    `- **风险摘要**：${p.risk.summary}`,
  ];
  if (p.risk.vol20AnnPct != null) {
    lines.push(`- **近20日波动（年化近似）**：${p.risk.vol20AnnPct}%（缩放×${p.risk.volScalar}）`);
  }
  if (p.risk.drawdown60Pct != null) {
    lines.push(`- **近60日自高点回撤**：${p.risk.drawdown60Pct}%（缩放×${p.risk.ddScalar}）`);
  }
  if (p.risk.prevTargetPct != null) {
    const d = p.risk.deltaFromPrev;
    lines.push(
      `- **较昨日目标仓**：${p.risk.prevTargetPct}% → ${p.targetPct}%` +
        (d != null ? `（${d > 0 ? '+' : ''}${d} 点，单日限幅±${POSITION_MAX_DAILY_DELTA}）` : ''),
    );
  }
  if (p.constraints.length) {
    lines.push(`- **约束**：${p.constraints.join('；')}`);
  }
  if (p.reasons.length) {
    lines.push(`- **依据**：${p.reasons.join('；')}`);
  }
  lines.push('');
  lines.push(
    '> 仓位百分比均相对于你预设的「黄金计划仓」=100%，不是总资产杠杆。' +
      '波动大/刚从高点回撤时会自动少拿一点；相对昨天单日最多调整约 10 个百分点，避免建议乱跳。不构成投资建议。',
  );
  lines.push('');
  return lines.join('\n');
}
