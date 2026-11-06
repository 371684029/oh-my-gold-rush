// 四维度分析 Agent

import { BaseAgent } from './base.js';
import { getConfig } from '../utils/config.js';
import { getDb } from '../db/index.js';
import { GoldPricesRepo } from '../db/gold-prices.js';
import { latestMA, latestRSI, rsiSignal, latestMACD, macdCross, latestBollinger, deviationFromMA } from '../indicators/index.js';
import type { TechnicalAnalysis, FundamentalAnalysis, SentimentAnalysis } from '../types/analysis.js';
import type { MarketData } from '../types/market.js';
import type { FundAnalysis } from '../types/fund.js';
import { forwardFillCloses } from '../utils/price-series.js';
import { aggregateWeeklyCloses } from '../utils/weekly-series.js';
import {
  blendTechnicalScore,
  buildTechnicalRuleInput,
  computeTechnicalRuleScore,
} from '../utils/technical-rule-score.js';
import {
  parseFundamentalAnalysis,
  parseSentimentAnalysis,
  parseTechnicalAnalysis,
} from '../schemas/dimension.js';

// === 超时 / 失败时的中性回落值 ===

/** 维度分析回落：评分 50（中性），无实质论据 */
function dimensionFallback(summary: string): {
  score: number; direction: 'neutral'; keyPoints: string[]; counterPoints: string[]; summary: string; sources: string[];
} {
  return {
    score: 50,
    direction: 'neutral',
    keyPoints: ['分析未完成（超时或异常），使用中性估值'],
    counterPoints: [],
    summary,
    sources: [],
  };
}

/** 技术面回落 */
export const TECHNICAL_FALLBACK: TechnicalAnalysis = {
  ...dimensionFallback('技术面分析超时，无法给出明确方向'),
  shortTerm: {
    timeframe: 'daily',
    support: 0,
    resistance: 0,
    trend: '无法判断（分析超时）',
    indicators: { ma5: '未知', ma20: '未知', macd: '未知', rsi: '未知' },
    keySignal: '无信号（分析异常）',
  },
  midTerm: {
    timeframe: 'weekly',
    support: 0,
    resistance: 0,
    trend: '无法判断（分析超时）',
    indicators: { ma20w: '未知', ma60w: '未知', macd: '未知', rsi: '未知' },
    keySignal: '无信号（分析异常）',
  },
};

/** 基本面回落 */
export const FUNDAMENTAL_FALLBACK: FundamentalAnalysis = {
  ...dimensionFallback('基本面分析超时，无法给出明确方向'),
  dollarIndexEffect: '未知（分析异常）',
  interestRateEffect: '未知（分析异常）',
  inflationEffect: '未知（分析异常）',
  fedStance: '未知（分析异常）',
};

/** 情绪面回落 */
export const SENTIMENT_FALLBACK: SentimentAnalysis = {
  ...dimensionFallback('情绪面分析超时，无法给出明确方向'),
  centralBanks: '未知（分析异常）',
  cftcPosition: '未知（分析异常）',
  vix: '未知（分析异常）',
  geopoliticalRisk: '未知（分析异常）',
  etfFlows: '未知（分析异常）',
};

/** 基金面回落 */
export const FUND_FALLBACK: FundAnalysis = {
  funds: [],
  valuation: { level: 'fair', indicator: '无法判断（分析异常）', action: '观望' },
  premiumDiscount: { current: 0, trend: '未知', advice: '数据不足，建议观望' },
  recommendation: { longTerm: '数据不足无法推荐', mediumTerm: '数据不足无法推荐', dipBuy: '数据不足无法推荐' },
};

/** 安全读取 MarketData 嵌套字段 */
function safeVal<T>(fn: () => T, fallback: T): T {
  try { const v = fn(); return v ?? fallback; } catch { return fallback; }
}

function safeStr(fn: () => number | null | undefined, suffix = '', prefix = ''): string {
  try { const v = fn(); return v != null ? `${prefix}${v}${suffix}` : 'N/A'; } catch { return 'N/A'; }
}

// === 技术面 Agent ===
const TECHNICAL_PROMPT = `你是黄金技术面分析专家，同时提供短期（日线）和中长期（周线）两个视角的分析。

## 双视角分析规则

### 短期视角（日线级别，持仓数天~2周）
- 分析周期：日K线、小时线
- 技术指标：5日/20日均线、日线MACD、日线RSI
- 操作建议：精确入场区间、止盈目标、止损位
- 推荐品种：黄金ETF场内(518880)、纸黄金
- 风控方式：固定止损（3-5%）

### 中长期视角（周线级别，持仓1~6个月）
- 分析周期：周K线、月K线
- 技术指标：20周/60周均线、周线MACD、周线RSI
- 操作建议：定投节奏调整、波段加减仓
- 推荐品种：黄金ETF联接A(000216)长期、C(000217)波段、积存金定投
- 风控方式：估值水位判断、仓位管理

## 信息可靠性规则
1. 严禁捏造数据
2. 优先使用注入的本地计算指标（这些是客观计算结果，非LLM推断）
3. 搜索解读仅作为辅助参考
4. 每个结论必须有依据
5. 必须包含至少1条反面论据

## 输出格式
{
  "score": 0-100,
  "direction": "bullish/bearish/neutral",
  "keyPoints": ["论点1", "论点2", "论点3"],
  "counterPoints": ["反方论据"],
  "summary": "一句话总结",
  "sources": ["来源1", "来源2"],
  "shortTerm": {
    "timeframe": "daily",
    "support": 数字,
    "resistance": 数字,
    "trend": "趋势描述",
    "indicators": { "ma5": "状态", "ma20": "状态", "macd": "状态", "rsi": "状态" },
    "keySignal": "关键信号"
  },
  "midTerm": {
    "timeframe": "weekly",
    "support": 数字,
    "resistance": 数字,
    "trend": "趋势描述",
    "indicators": { "ma20w": "状态", "ma60w": "状态", "macd": "状态", "rsi": "状态" },
    "keySignal": "关键信号"
  }
}`;

export class TechnicalAgent extends BaseAgent {
  constructor() {
    const config = getConfig();
    super({ name: 'technical', model: config.model, systemPrompt: TECHNICAL_PROMPT });
  }

  async analyze(data: MarketData): Promise<TechnicalAnalysis> {
    const londonPrice = safeVal(() => data.london.price.value, 0);
    const dollarIdx = safeVal(() => data.dollarIndex.value.value, 0);
    const dollarChange = safeVal(() => data.dollarIndex.value.change, 0);

    // 从 SQLite 加载历史数据，计算本地技术指标
    const db = getDb();
    const repo = new GoldPricesRepo(db);
    const history = repo.getRecent(60);

    let indicatorContext = '';
    if (history.length >= 20) {
      const closes = forwardFillCloses(history);

      if (closes.length >= 20) {
        const ma5 = latestMA(closes, 5);
        const ma20 = latestMA(closes, 20);
        const ma60 = closes.length >= 60 ? latestMA(closes, 60) : null;
        const rsiVal = latestRSI(closes, 14);
        const macdVal = latestMACD(closes);
        const macdCrossVal = macdCross(closes);
        const bb = latestBollinger(closes);
        const dev = deviationFromMA(closes, 20);
        const latestDev = dev.filter((v): v is number => v !== null).pop() ?? null;

        // —— 周线级别指标（从日线聚合计算） ——
        let weeklyContext = '';
        const weeklyCandles = aggregateWeeklyCloses(history);
        const weeklyCloses = weeklyCandles.map(c => c.close);
        if (weeklyCloses.length >= 4) {
          const wMa20 = latestMA(weeklyCloses, Math.min(20, weeklyCloses.length));
          const wMa60 = latestMA(weeklyCloses, Math.min(60, weeklyCloses.length));
          const wRsi = latestRSI(weeklyCloses, 14);
          const wMacd = latestMACD(weeklyCloses);
          const wMacdCross = macdCross(weeklyCloses);
          weeklyContext = `
### 周线级别指标（从 ${weeklyCloses.length} 根周线聚合计算）
- 周线数: ${weeklyCloses.length} 根
- MA20W: ${wMa20?.toFixed(2) ?? '数据不足'}
- MA60W: ${wMa60?.toFixed(2) ?? '数据不足'}
- 周RSI(14): ${wRsi?.toFixed(1) ?? '数据不足'} ${wRsi ? rsiSignal(wRsi) : ''}
- 周MACD: ${wMacd ? `MACD=${wMacd.macd?.toFixed(2)}, Signal=${wMacd.signal?.toFixed(2)}, Histogram=${wMacd.histogram?.toFixed(2)}` : '数据不足'}
- 周MACD交叉: ${wMacdCross === 'golden' ? '金叉✅' : wMacdCross === 'dead' ? '死叉❌' : '无交叉'}
`;
        } else {
          weeklyContext = `\n### 周线级别指标：周线数据不足（需至少4根周线，当前${weeklyCloses.length}根）`;
        }

        indicatorContext = `
## 本地计算的技术指标（客观结果，可直接采信）

### 日线级别指标
- 当前价: $${londonPrice.toFixed(2)}
- MA5: ${ma5?.toFixed(2) ?? '数据不足'}
- MA20: ${ma20?.toFixed(2) ?? '数据不足'}
- MA60: ${ma60?.toFixed(2) ?? '数据不足'}
- RSI(14): ${rsiVal?.toFixed(1) ?? '数据不足'} ${rsiVal ? rsiSignal(rsiVal) : ''}
- MACD: ${macdVal ? `MACD=${macdVal.macd?.toFixed(2)}, Signal=${macdVal.signal?.toFixed(2)}, Histogram=${macdVal.histogram?.toFixed(2)}` : '数据不足'}
- MACD交叉: ${macdCrossVal === 'golden' ? '金叉✅' : macdCrossVal === 'dead' ? '死叉❌' : '无交叉'}
- 布林带: ${bb ? `上轨=${bb.upper?.toFixed(2)}, 中轨=${bb.middle?.toFixed(2)}, 下轨=${bb.lower?.toFixed(2)}, %B=${bb.percentB?.toFixed(2)}` : '数据不足'}
- 偏离MA20: ${latestDev?.toFixed(2) ?? '数据不足'}%
- 历史数据天数: ${history.length}天
${weeklyContext}`;
      }
    } else {
      indicatorContext = '## 本地技术指标：历史数据不足（需20天以上），无法计算';
    }

    const schema = {
      type: 'object',
      properties: {
        score: { type: 'number' },
        direction: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
        keyPoints: { type: 'array', items: { type: 'string' } },
        counterPoints: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
        sources: { type: 'array', items: { type: 'string' } },
        shortTerm: {
          type: 'object',
          properties: {
            timeframe: { type: 'string' },
            support: { type: 'number' },
            resistance: { type: 'number' },
            trend: { type: 'string' },
            indicators: { type: 'object', properties: { ma5: { type: 'string' }, ma20: { type: 'string' }, macd: { type: 'string' }, rsi: { type: 'string' } } },
            keySignal: { type: 'string' },
          },
        },
        midTerm: {
          type: 'object',
          properties: {
            timeframe: { type: 'string' },
            support: { type: 'number' },
            resistance: { type: 'number' },
            trend: { type: 'string' },
            indicators: { type: 'object', properties: { ma20w: { type: 'string' }, ma60w: { type: 'string' }, macd: { type: 'string' }, rsi: { type: 'string' } } },
            keySignal: { type: 'string' },
          },
        },
      },
      required: ['score', 'direction', 'keyPoints', 'counterPoints', 'summary', 'sources', 'shortTerm', 'midTerm'],
    };

    const techPromptData = `## 市场数据\n美元指数: ${dollarIdx} (${dollarChange > 0 ? '+' : ''}${dollarChange}%)\n10Y美债: ${safeStr(() => data.usTreasury.yield10y.value, '%')}\nTIPS: ${safeStr(() => data.usTreasury.tips?.value, '%')}\n\n请进行技术面双视角分析。`;

    const llmRaw = await this.structuredPrompt<TechnicalAnalysis>(
      `${indicatorContext}\n\n${techPromptData}`,
      schema,
    );
    const llmResult = parseTechnicalAnalysis(llmRaw);

    const ruleInput = buildTechnicalRuleInput(history);
    if (ruleInput) {
      const ruleScore = computeTechnicalRuleScore(ruleInput);
      return { ...llmResult, score: blendTechnicalScore(ruleScore, llmResult.score) };
    }

    return llmResult;
  }
}

// === 基本面 Agent ===
const FUNDAMENTAL_PROMPT = `你是黄金基本面分析专家，从宏观经济角度分析黄金走势。

## 分析维度
- 美元指数影响
- 利率环境影响
- 通胀影响
- 美联储政策倾向

## 信息可靠性规则
1. 严禁捏造数据
2. 因果推理必须标注条件和反例
3. 必须包含至少1条反面论据

## 输出格式
{
  "score": 0-100,
  "direction": "bullish/bearish/neutral",
  "keyPoints": ["论点1", "论点2", "论点3"],
  "counterPoints": ["反方论据"],
  "summary": "一句话总结",
  "sources": ["来源1"],
  "dollarIndexEffect": "美元指数影响描述",
  "interestRateEffect": "利率影响描述",
  "inflationEffect": "通胀影响描述",
  "fedStance": "美联储政策倾向"
}`;

export class FundamentalAgent extends BaseAgent {
  constructor() {
    const config = getConfig();
    super({ name: 'fundamental', model: config.model, systemPrompt: FUNDAMENTAL_PROMPT });
  }

  async analyze(data: MarketData): Promise<FundamentalAnalysis> {
    const londonPrice = safeVal(() => data.london.price.value, 0);
    const londonChange = safeVal(() => data.london.price.change, 0);
    const dollarIdx = safeVal(() => data.dollarIndex.value.value, 0);
    const dollarChange = safeVal(() => data.dollarIndex.value.change, 0);

    const schema = {
      type: 'object',
      properties: {
        score: { type: 'number' },
        direction: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
        keyPoints: { type: 'array', items: { type: 'string' } },
        counterPoints: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
        sources: { type: 'array', items: { type: 'string' } },
        dollarIndexEffect: { type: 'string' },
        interestRateEffect: { type: 'string' },
        inflationEffect: { type: 'string' },
        fedStance: { type: 'string' },
      },
      required: ['score', 'direction', 'keyPoints', 'counterPoints', 'summary', 'sources', 'dollarIndexEffect', 'interestRateEffect', 'inflationEffect', 'fedStance'],
    };

    const raw = await this.structuredPrompt<FundamentalAnalysis>(
      `## 市场数据\n伦敦金: $${londonPrice} (${londonChange > 0 ? '+' : ''}${londonChange}%)\n美元指数: ${dollarIdx} (${dollarChange > 0 ? '+' : ''}${dollarChange}%)\n10Y美债: ${safeStr(() => data.usTreasury.yield10y.value, '%')}\nTIPS: ${safeStr(() => data.usTreasury.tips?.value, '%')}\n\n请进行基本面分析。`,
      schema,
    );
    return parseFundamentalAnalysis(raw);
  }
}

// === 情绪面 Agent ===
const SENTIMENT_PROMPT = `你是黄金情绪面分析专家，从市场情绪和资金流向角度分析。

## 分析维度
- 央行购金动态
- CFTC持仓
- VIX恐慌指数
- 地缘风险
- 黄金ETF资金流入/流出

## 信息可靠性规则
1. 严禁捏造数据
2. 注入的「主力动向」数据来自本地数据库（CFTC官方报告、SPDR ETF持仓），为客观数据，可直接采信
3. 情绪指标需标注方向和强度
4. 必须包含至少1条反面论据

## 输出格式
{
  "score": 0-100,
  "direction": "bullish/bearish/neutral",
  "keyPoints": ["论点1", "论点2", "论点3"],
  "counterPoints": ["反方论据"],
  "summary": "一句话总结",
  "sources": ["来源1"],
  "centralBanks": "央行购金描述",
  "cftcPosition": "CFTC持仓描述",
  "vix": "VIX描述",
  "geopoliticalRisk": "地缘风险描述",
  "etfFlows": "ETF资金流向描述"
}`;

/** 将本地计算的主力信号格式化为可注入 LLM prompt 的结构化文本 */
function formatFlowSignalContext(signal: import('../types/institutional.js').InstitutionalSignal): string {
  const { cftc, etfFlow, overallScore, overallDirection } = signal;
  const dirLabel = overallDirection === 'bullish' ? '偏多' : overallDirection === 'bearish' ? '偏空' : '中性';
  let ctx = `## 主力动向（本地计算，可直接采信）\n`;
  ctx += `综合: ${overallScore}/100 (${dirLabel})\n`;
  ctx += `CFTC: ${cftc.score}/100 ${cftc.direction}, ${cftc.summary}\n`;
  if (cftc.extreme) ctx += `⚠️ ${cftc.extremeLabel}\n`;
  ctx += `ETF: ${etfFlow.score}/100 ${etfFlow.direction}, ${etfFlow.summary}\n`;
  if (etfFlow.divergence) ctx += `⚠️ ${etfFlow.divergenceLabel}\n`;
  return ctx;
}

export class SentimentAgent extends BaseAgent {
  constructor() {
    const config = getConfig();
    super({ name: 'sentiment', model: config.model, systemPrompt: SENTIMENT_PROMPT, timeoutMs: 120_000 });
  }

  async analyze(data: MarketData, flowSignal?: import('../types/institutional.js').InstitutionalSignal): Promise<SentimentAnalysis> {
    const londonPrice = safeVal(() => data.london.price.value, 0);
    const etfNav = safeVal(() => data.etf.nav.value, 0);
    const etfChange = safeVal(() => data.etf.nav.change, 0);
    const dollarIdx = safeVal(() => data.dollarIndex.value.value, 0);

    const schema = {
      type: 'object',
      properties: {
        score: { type: 'number' },
        direction: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
        keyPoints: { type: 'array', items: { type: 'string' } },
        counterPoints: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
        sources: { type: 'array', items: { type: 'string' } },
        centralBanks: { type: 'string' },
        cftcPosition: { type: 'string' },
        vix: { type: 'string' },
        geopoliticalRisk: { type: 'string' },
        etfFlows: { type: 'string' },
      },
      required: ['score', 'direction', 'keyPoints', 'counterPoints', 'summary', 'sources', 'centralBanks', 'cftcPosition', 'vix', 'geopoliticalRisk', 'etfFlows'],
    };

    const raw = await this.structuredPrompt<SentimentAnalysis>(
      `## 市场数据\n伦敦金: $${londonPrice}\nETF(518880): ${etfNav} (${etfChange > 0 ? '+' : ''}${etfChange}%)\n美元指数: ${dollarIdx}\n\n`
      + (flowSignal ? formatFlowSignalContext(flowSignal) : '')
      + '请基于以上数据（主力数据为本地计算、可直接采信），结合对 VIX、地缘风险的搜索，进行情绪面分析。',
      schema,
    );
    return parseSentimentAnalysis(raw);
  }
}

// === 基金面 Agent ===
const FUND_PROMPT = `你是黄金基金分析专家，从基金费率和估值角度分析。

## 分析要点
- A类(000216)适合长期持有(>1年)，有申购费无销售服务费
- C类(000217/002611)适合短期波段(<1年)，无申购费有销售服务费
- 518880是场内ETF，关注溢价/折价
- 严禁推荐杠杆/期货产品

## 输出格式（严格遵守，直接输出JSON）
{
  "funds": [
    {
      "code": "000216",
      "name": "华安黄金ETF联接A",
      "type": "A",
      "nav": 数字,
      "change1w": 数字,
      "change1m": 数字,
      "change3m": 数字,
      "feeRate": 数字,
      "totalCost1y": 数字,
      "totalCost3y": 数字,
      "scale": 数字,
      "recommendation": "适用场景"
    }
  ],
  "valuation": { "level": "low/fair/high", "indicator": "判断依据", "action": "定投/观望/减仓" },
  "premiumDiscount": { "current": 数字, "trend": "趋势", "advice": "建议" },
  "recommendation": { "longTerm": "推荐品种及原因", "mediumTerm": "推荐品种及原因", "dipBuy": "推荐品种及原因" }
}`;

export class FundAgent extends BaseAgent {
  constructor() {
    const config = getConfig();
    super({ name: 'fund', model: config.model, systemPrompt: FUND_PROMPT, timeoutMs: 120_000 });
  }

  async analyze(data: MarketData, fundNavContext = ''): Promise<FundAnalysis> {
    const etfNav = safeVal(() => data.etf.nav.value, 0);
    const etfChange = safeVal(() => data.etf.nav.change, 0);
    const londonPrice = safeVal(() => data.london.price.value, 0);

    const fundItemSchema = {
      type: 'object',
      properties: {
        code: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string' },
        nav: { type: 'number' },
        change1w: { type: 'number' },
        change1m: { type: 'number' },
        change3m: { type: 'number' },
        feeRate: { type: 'number' },
        totalCost1y: { type: 'number' },
        totalCost3y: { type: 'number' },
        scale: { type: 'number' },
        recommendation: { type: 'string' },
      },
      required: ['code', 'name', 'type', 'nav', 'change1m', 'feeRate', 'scale', 'recommendation'],
    };

    const schema = {
      type: 'object',
      properties: {
        funds: { type: 'array', items: fundItemSchema },
        valuation: { type: 'object', properties: { level: { type: 'string' }, indicator: { type: 'string' }, action: { type: 'string' } } },
        premiumDiscount: { type: 'object', properties: { current: { type: 'number' }, trend: { type: 'string' }, advice: { type: 'string' } } },
        recommendation: { type: 'object', properties: { longTerm: { type: 'string' }, mediumTerm: { type: 'string' }, dipBuy: { type: 'string' } } },
      },
      required: ['funds', 'valuation', 'premiumDiscount', 'recommendation'],
    };

    return this.structuredPrompt<FundAnalysis>(
      `## 市场数据\nETF(518880): ${etfNav} (${etfChange > 0 ? '+' : ''}${etfChange}%)\n伦敦金: $${londonPrice}\n\n`
      + (fundNavContext ? `## 本地基金净值（SQLite）\n${fundNavContext}\n\n` : '')
      + `请输出 TRACKED 基金对比表（000216/000217/002610/002611/518880）及估值建议。`,
      schema,
    );
  }
}
