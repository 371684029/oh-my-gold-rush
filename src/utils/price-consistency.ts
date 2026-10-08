// 价格内部一致性校验 — 三合一程序化检查，不依赖 LLM
//
// 1. 伦敦-上海套利检查：两地价格应符合汇率换算
// 2. Yahoo 锚定检查：LLM 提取价 vs Yahoo 直连价
// 3. 历史连续检查：当日价 vs 前一日价，日波动 >3% 告警

import { getDb } from '../db/index.js';
import { GoldPricesRepo } from '../db/gold-prices.js';

export interface ConsistencyReport {
  /** 总奖励分 (-20 ~ +30)，加到本地置信度上 */
  bonusConfidence: number;
  /** 警告消息列表 */
  warnings: string[];
  /** 各子检查详情 */
  details: {
    crossMarket: { passed: boolean; deviationPct: number; impliedShanghai: number | null };
    yahooAnchor: { passed: boolean; deviationPct: number | null; yahooPrice: number | null };
    historical: { passed: boolean; dayChangePct: number | null };
  };
}

// 上海金 vs 伦敦金换算常量
const OZ_TO_GRAM = 31.1035;
const USDCNY_APPROX = 7.25; // 兜底近似汇率（无实时锚定时用；实际以锚定为准）

/** 伦敦金 USD/oz → 上海金 CNY/g 近似换算（usdcny 传入实时锚定时优先） */
function londonToShanghai(londonUsdPerOz: number, usdcny: number | null): number {
  const rate = usdcny != null && usdcny > 0 ? usdcny : USDCNY_APPROX;
  return (londonUsdPerOz * rate) / OZ_TO_GRAM;
}

/**
 * 三合一价格一致性校验
 * @param londonPrice 伦敦金价 (LLM 提取, USD/oz)
 * @param shanghaiPrice 上海金价 (LLM 提取, CNY/g)
 * @param yahooGoldPrice Yahoo GC=F 实时价 (null if unavailable)
 * @param usdcny 实时 USDCNY 锚定价（新浪 fx_susdcny；null 则回退近似值）
 */
export function checkPriceConsistency(
  londonPrice: number,
  shanghaiPrice: number | null,
  yahooGoldPrice: number | null,
  usdcny: number | null = null,
): ConsistencyReport {
  const warnings: string[] = [];
  let bonus = 0;

  // 伦敦价缺失/0：跳过历史跳变检查，避免 -100% 假警报
  if (londonPrice == null || !Number.isFinite(londonPrice) || londonPrice <= 0) {
    return {
      bonusConfidence: -10,
      warnings: ['🔴 伦敦金价格缺失或为 0，跳过一致性校验'],
      details: {
        crossMarket: { passed: false, deviationPct: 0, impliedShanghai: null },
        yahooAnchor: { passed: false, deviationPct: null, yahooPrice: yahooGoldPrice },
        historical: { passed: false, dayChangePct: null },
      },
    };
  }

  // ===== 1. 伦敦-上海套利检查 =====
  let crossMarketPassed = false;
  let crossDeviation = 0;
  let impliedShanghai: number | null = null;

  if (shanghaiPrice != null && shanghaiPrice > 0) {
    impliedShanghai = londonToShanghai(londonPrice, usdcny);
    crossDeviation = Math.abs((shanghaiPrice - impliedShanghai) / shanghaiPrice) * 100;

    if (crossDeviation < 2) {
      // 两地价格高度一致 → 互相印证
      crossMarketPassed = true;
      bonus += 10;
    } else if (crossDeviation < 5) {
      // 可接受偏差（汇率波动 + 溢价）
      crossMarketPassed = true;
      bonus += 5;
    } else if (crossDeviation < 10) {
      // 偏差较大，可能是上海溢价/折价
      warnings.push(`🟡 伦敦-上海价偏差 ${crossDeviation.toFixed(1)}%（可能为上海溢价，汇率 ${usdcny != null ? usdcny.toFixed(2) : `近似值 ±${USDCNY_APPROX}`}）`);
    } else {
      // 严重偏差，可能某一方数据错误
      warnings.push(`🔴 伦敦-上海价偏差 ${crossDeviation.toFixed(1)}%，可能存在数据错误`);
      bonus -= 10;
    }
  }

  // ===== 2. Yahoo 锚定检查 =====
  let yahooPassed = false;
  let yahooDeviation: number | null = null;

  if (yahooGoldPrice != null && yahooGoldPrice > 0) {
    yahooDeviation = Math.abs((londonPrice - yahooGoldPrice) / yahooGoldPrice) * 100;

    if (yahooDeviation < 1) {
      // LLM 提取价与 Yahoo 高度一致 → 确认 LLM 提取正确
      yahooPassed = true;
      bonus += 15;
    } else if (yahooDeviation < 3) {
      // 可接受偏差（伦敦现货 vs COMEX 期货价差）
      yahooPassed = true;
      bonus += 5;
    } else {
      // LLM 提取价与 Yahoo 偏差过大 → LLM 可能取错
      warnings.push(`🔴 LLM 提取伦敦金 $${londonPrice} 与 Yahoo GC=F $${yahooGoldPrice} 偏差 ${yahooDeviation.toFixed(1)}%`);
      bonus -= 15;
    }
  }

  // ===== 3. 历史连续检查 =====
  let historicalPassed = false;
  let dayChange: number | null = null;

  try {
    const db = getDb();
    const repo = new GoldPricesRepo(db);
    const recent = repo.getRecent(2);
    const prev = recent.length >= 2 ? recent[recent.length - 2] : null;

    if (prev?.londonClose != null && prev.londonClose > 0) {
      dayChange = ((londonPrice - prev.londonClose) / prev.londonClose) * 100;

      if (Math.abs(dayChange) < 2) {
        // 日波动正常
        historicalPassed = true;
        bonus += 5;
      } else if (Math.abs(dayChange) < 5) {
        // 日波动偏大但尚可
        historicalPassed = true;
      } else {
        // 日波动异常（黄金单日 >5% 极为罕见）
        warnings.push(`🔴 金价日波动 ${dayChange > 0 ? '+' : ''}${dayChange.toFixed(2)}%（前一交易日 $${prev.londonClose}），可能数据异常`);
        bonus -= 10;
      }

      // 价格停滞检测：连续 3 天价格完全相同 → 数据未更新
      if (recent.length >= 3) {
        const recent3 = recent.slice(-3);
        const allSame = recent3.every(r => r.londonClose === recent3[0].londonClose);
        if (allSame && recent3[0].londonClose != null) {
          warnings.push('🔴 金价连续3天未变动，可能数据源未更新');
          bonus -= 15;
        }
      }
    }
  } catch {
    // DB 不可用，跳过历史检查
  }

  // Clamp bonus to [-20, 30]
  bonus = Math.max(-20, Math.min(30, bonus));

  return {
    bonusConfidence: bonus,
    warnings,
    details: {
      crossMarket: { passed: crossMarketPassed, deviationPct: crossDeviation, impliedShanghai },
      yahooAnchor: { passed: yahooPassed, deviationPct: yahooDeviation, yahooPrice: yahooGoldPrice },
      historical: { passed: historicalPassed, dayChangePct: dayChange },
    },
  };
}
