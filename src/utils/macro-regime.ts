// 金市宏观阶段标签 — 纯本地规则，不依赖 LLM（v2.4 F11 重构）
// 升级为慢变量平滑窗口 + 滞后确认（Hysteresis）+ 多标签并存，解决单日 DXY 抖动与 TIPS>=2.0 优先级死锁。

import type { MarketData } from '../types/market.js';

export interface MacroRegime {
  /** 主体制机器可读标签 */
  tag: string;
  /** 中文展示名 */
  label: string;
  /** 一句话说明 */
  description: string;
  /** 判定依据 */
  signals: string[];
  /** F11: 并存次级/组合标签（避免互斥覆盖，如「实际利率压制 + 强美元」） */
  tags?: string[];
  /** F11: 是否因滞后确认暂缓切换 */
  hysteresisHeld?: boolean;
}

export interface MacroRegimeSlowContext {
  /** DXY 相对 MA60 偏离（%），优先替代单日 dxyChange */
  dxyDevMa60Pct?: number | null;
  /** TIPS 近 60 日基点变化（bp），负值=实际利率下行 */
  tipsChange60dBp?: number | null;
  /** 20 日 / 60 日相对波动率比值 */
  volRatio20to60?: number | null;
  /** 上一期体制标签（用于滞后防抖） */
  previousTag?: string | null;
  /** 新体制已连续满足天数（>= 3 才切换；不传则即时判定，保持历史调用兼容） */
  consecutiveDays?: number | null;
}

/**
 * 根据市场数据（+ 可选金价偏离 MA20% + 可选慢变量上下文）判定当前宏观阶段。
 * F11:
 *  - 优先使用慢变量（DXY 相对 MA60、TIPS 60D 趋势、20D/60D 波动比），缺省时回退到单日快照兼容旧调用；
 *  - 均衡各分支得分，消除 `tips >= 2.0` 时锁死 `dollar_strength` / `rate_volatility` 的优先级死锁；
 *  - 输出并存 `tags` 数组与可选滞后确认。
 */
export function detectMacroRegime(
  marketData: MarketData,
  goldDeviationPct: number | null = null,
  slowCtx?: MacroRegimeSlowContext,
): MacroRegime {
  const tips = marketData.usTreasury?.tips?.value ?? null;
  const dxyChange = marketData.dollarIndex?.value?.change ?? 0;
  const yield10y = marketData.usTreasury?.yield10y?.value ?? null;

  const dxyDev60 = slowCtx?.dxyDevMa60Pct ?? null;
  const tipsTrendBp = slowCtx?.tipsChange60dBp ?? null;
  const volRatio = slowCtx?.volRatio20to60 ?? null;

  const candidates: Array<{ score: number; regime: MacroRegime }> = [];

  // 1) 实际利率压制（高位且未显著下行）
  if (tips != null && tips >= 2.0 && (tipsTrendBp == null || tipsTrendBp > -20)) {
    const trendBoost = tipsTrendBp != null && tipsTrendBp > 15 ? Math.min(8, tipsTrendBp / 10) : 0;
    candidates.push({
      score: 26 + Math.min(6, (tips - 2.0) * 4) + trendBoost,
      regime: {
        tag: 'real_rate_headwind',
        label: '实际利率压制',
        description: 'TIPS 实际利率处偏高位，持有黄金机会成本上升，反弹易遇阻。',
        signals: [
          `TIPS ${tips.toFixed(2)}% ≥ 2.0%`,
          ...(tipsTrendBp != null ? [`TIPS 60D ${tipsTrendBp >= 0 ? '+' : ''}${tipsTrendBp.toFixed(0)}bp`] : []),
        ],
      },
    });
  }

  // 2) 降息预期 / 实际利率下行（优先慢变量，回退兼容旧接口）
  const dxyWeak = dxyDev60 != null ? dxyDev60 <= -1.0 : dxyChange < -0.2;
  const tipsEasing = (tips != null && tips < 1.5) || (tipsTrendBp != null && tipsTrendBp <= -25);
  if (tipsEasing && dxyWeak) {
    const score = 28 + (tipsTrendBp != null && tipsTrendBp <= -25 ? Math.min(8, Math.abs(tipsTrendBp) / 10) : 0);
    candidates.push({
      score,
      regime: {
        tag: 'dovish_pivot_watch',
        label: '降息预期升温',
        description: '实际利率回落且美元走弱，利于黄金中长期估值修复。',
        signals: [
          ...(tips != null ? [`TIPS ${tips.toFixed(2)}%`] : []),
          ...(tipsTrendBp != null ? [`TIPS 60D ${tipsTrendBp.toFixed(0)}bp`] : []),
          dxyDev60 != null ? `DXY相对MA60 ${dxyDev60.toFixed(2)}%` : `美元 ${dxyChange > 0 ? '+' : ''}${dxyChange.toFixed(2)}%`,
        ],
      },
    });
  }

  // 3) 美元走强段（F11: 强美元可与高 TIPS 竞争主导权，不再被 TIPS >= 2.0 死锁）
  const dxyStrong = dxyDev60 != null ? dxyDev60 >= 1.5 : dxyChange > 0.4;
  if (dxyStrong) {
    const strengthMag = dxyDev60 != null ? dxyDev60 * 3 : Math.abs(dxyChange) * 6;
    candidates.push({
      score: 25 + Math.min(12, strengthMag),
      regime: {
        tag: 'dollar_strength',
        label: '美元走强段',
        description: '美元指数持续走强压制以美元计价的黄金，需关注反弹持续性。',
        signals: [
          dxyDev60 != null
            ? `DXY相对MA60 +${dxyDev60.toFixed(2)}%`
            : `美元 ${dxyChange > 0 ? '+' : ''}${dxyChange.toFixed(2)}%`,
        ],
      },
    });
  }

  // 4) 超卖修复段
  if (goldDeviationPct != null && goldDeviationPct <= -5) {
    candidates.push({
      score: 27 + Math.min(10, Math.abs(goldDeviationPct)),
      regime: {
        tag: 'oversold_repair',
        label: '超卖修复段',
        description: '金价显著低于 MA20，技术性反弹概率上升，但趋势未必反转。',
        signals: [`偏离 MA20 ${goldDeviationPct.toFixed(1)}%`],
      },
    });
  }

  // 5) 偏离过热段
  if (goldDeviationPct != null && goldDeviationPct >= 8) {
    candidates.push({
      score: 24 + Math.min(10, goldDeviationPct),
      regime: {
        tag: 'extended_rally',
        label: '偏离过热段',
        description: '金价显著高于 MA20，追高风险上升，定投宜控节奏。',
        signals: [`偏离 MA20 +${goldDeviationPct.toFixed(1)}%`],
      },
    });
  }

  // 6) 利率高位震荡（F11: 高利率 + 波动扩张时可竞争成为主标签，不再被固定 18 分锁死）
  const highRate = yield10y != null && yield10y >= 4.5 && tips != null && tips >= 1.8;
  const volExpanding = volRatio != null && volRatio >= 1.25;
  if (highRate) {
    const score = 24 + (volExpanding ? 10 : 0) + Math.min(6, (yield10y - 4.5) * 6);
    candidates.push({
      score,
      regime: {
        tag: 'rate_volatility',
        label: '利率高位震荡',
        description: '名义与实际利率均处偏高位且波动偏大，黄金方向取决于数据与联储预期。',
        signals: [
          `10Y ${yield10y.toFixed(2)}%`,
          `TIPS ${tips.toFixed(2)}%`,
          ...(volRatio != null ? [`20D/60D波动比 ${volRatio.toFixed(2)}x`] : []),
        ],
      },
    });
  }

  if (candidates.length === 0) {
    return {
      tag: 'range_bound',
      label: '震荡整理',
      description: '宏观信号未形成单一主导因素，宜区间思维、定投纪律为主。',
      signals: ['美元/TIPS/偏离度均未触发极端阈值'],
      tags: ['range_bound'],
    };
  }

  candidates.sort((a, b) => b.score - a.score);
  const allTags = candidates.map(c => c.regime.tag);
  const top = {
    ...candidates[0]!.regime,
    tags: allTags,
  };

  // F11: 滞后防抖（Hysteresis）— 当显式提供 previousTag 且 consecutiveDays < 3 时维持原体制
  if (
    slowCtx?.previousTag
    && slowCtx.previousTag !== top.tag
    && slowCtx.consecutiveDays != null
    && slowCtx.consecutiveDays < 3
  ) {
    const prevCandidate = candidates.find(c => c.regime.tag === slowCtx.previousTag);
    if (prevCandidate) {
      return {
        ...prevCandidate.regime,
        tags: allTags,
        hysteresisHeld: true,
        signals: [...prevCandidate.regime.signals, `新体制 ${top.tag} 仅连续 ${slowCtx.consecutiveDays} 日（需≥3日确认）`],
      };
    }
  }

  return top;
}

/** CLI / Markdown 单行 */
export function formatMacroRegimeLine(regime: MacroRegime): string {
  const co = regime.tags && regime.tags.length > 1 ? ` [并存: ${regime.tags.slice(1).join(', ')}]` : '';
  return `${regime.label}（${regime.tag}）${co}— ${regime.description}`;
}
