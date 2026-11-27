// 分析结果类型定义

import type { QuantFactorDetail } from '../indicators/quant-score.js';
import type { MidTermOutlook } from '../utils/mid-term-outlook.js';
import type { EightDimensionProfile } from '../utils/eight-dimensions.js';

/** 分析方向 */
export type Direction = 'bullish' | 'bearish' | 'neutral';

/** 单维度分析结果 */
export interface DimensionAnalysis {
  score: number;          // 0-100
  direction: Direction;
  keyPoints: string[];    // 3-5条关键论点
  counterPoints: string[]; // 至少1条反面论据
  summary: string;        // 一句话总结
  sources: string[];      // 信息来源列表
}

/** 短期技术指标（日线级别） */
export interface ShortTermIndicators {
  timeframe: 'daily';
  support: number;
  resistance: number;
  trend: string;
  indicators: {
    ma5: string;
    ma20: string;
    macd: string;
    rsi: string;
  };
  keySignal: string;
}

/** 中长期技术指标（周线级别） */
export interface MidTermIndicators {
  timeframe: 'weekly';
  support: number;
  resistance: number;
  trend: string;
  indicators: {
    ma20w: string;
    ma60w: string;
    macd: string;
    rsi: string;
  };
  keySignal: string;
}

/** 技术面分析 */
export interface TechnicalAnalysis extends DimensionAnalysis {
  shortTerm: ShortTermIndicators;
  midTerm: MidTermIndicators;
}

/** 基本面分析 */
export interface FundamentalAnalysis extends DimensionAnalysis {
  dollarIndexEffect: string;
  interestRateEffect: string;
  inflationEffect: string;
  fedStance: string;
}

/** 情绪面分析 */
export interface SentimentAnalysis extends DimensionAnalysis {
  centralBanks: string;
  cftcPosition: string;
  vix: string;
  geopoliticalRisk: string;
  etfFlows: string;
}

/** 反驳分析 */
export type RebuttalStrength = 'weak' | 'moderate' | 'strong';

export interface BearPoint {
  point: string;
  evidence: string;
  probability: number; // %
  impact: string;
}

export interface BullVulnerability {
  originalPoint: string;
  vulnerability: string;
  counterCondition: string;
}

export interface RebuttalAnalysis {
  bullScore: number;
  bearScore: number;
  rebuttalStrength: RebuttalStrength;
  bearPoints: BearPoint[];
  bullVulnerabilities: BullVulnerability[];
  netEffect: 'unchanged' | 'downgraded' | 'significant_downgrade' | 'upgraded';
  adjustedScore?: number;
  tailRisks: TailRisk[];
}

/** 尾部风险 */
export interface TailRisk {
  risk: string;
  probability: number; // %
  impact: string;
  trigger: string;
  mitigation: string;
}

/** 情景分析 */
export interface Scenario {
  probability: number; // %
  description: string;
  goldPrice: string;
  action: string;
  confidence: 'low' | 'moderate' | 'high';
}

export interface ScenarioWithTrigger extends Scenario {
  trigger: string;
}

export interface Scenarios {
  base: Scenario;
  upside: ScenarioWithTrigger;
  downside: ScenarioWithTrigger;
}

/** 校准上下文 */
export interface CalibrationContext {
  scoreRange: string;
  /** 5日涨概率（全局分桶） */
  historicalAccuracy: number | null;
  /** T=20 交易日后续上涨概率（定投视角） */
  historicalAccuracy20d: number | null;
  /** 当前宏观阶段标签 */
  regimeTag?: string;
  /** 同 regime 下 5 日涨概率 */
  regimeHistoricalAccuracy?: number | null;
  regimeSampleSize?: number;
  regimeSystematicBias?: string;
  systematicBias: string;
  sampleSize: number;
  /** 反驳修正后、校准偏移前的分数 */
  rawScore?: number;
  /** 校准偏移量（负=下调） */
  calibrationOffset?: number;
  /** 是否已应用数值校准 */
  calibrationApplied?: boolean;
  calibrationReason?: string;
}

/** 短期策略 */
export interface ShortTermStrategy {
  horizon: 'short-term';
  action: string;
  entryZone: string;
  target: string;
  stopLoss: string;
  recommendedProduct: string;
  riskWarning: string;
}

/** 中长期策略 */
export interface MidTermStrategy {
  horizon: 'medium-term';
  investAdvice: {
    dipInvest: 'continue' | 'increase' | 'pause';
    positionAdjust: 'add' | 'reduce' | 'hold';
    recommendedFund: string;
  };
  keyLevels: {
    supportZone: string;
    resistanceZone: string;
  };
  riskWarning: string;
}

/** 完整分析报告 */
export interface GoldAnalysisReport {
  timestamp: string;
  marketData: import('./market.ts').MarketData;
  dataQuality: {
    overallConfidence: number;
    warnings: string[];
  };
  technical: TechnicalAnalysis;
  fundamental: FundamentalAnalysis;
  sentiment: SentimentAnalysis;
  fund: import('./fund.ts').FundAnalysis;
  rebuttal: RebuttalAnalysis;
  tailRisks: TailRisk[];
  overall: {
    score: number;
    direction: Direction;
    scenarios: Scenarios;
    calibration: CalibrationContext;
    shortTerm: ShortTermStrategy;
    midTerm: MidTermStrategy;
    /** 纯量化评分（零 LLM，100% 可复现） */
    quantScore?: number;
    /** 量化因子明细（可选，供日报/Web 展示） */
    quantFactors?: Record<string, QuantFactorDetail>;
    /** 参与量化打分的名义权重合计（0–1）；<1 表示部分因子缺数据，分数已重归一 */
    quantCoverage?: number;
    /** 因数据缺失被剔除的量化因子 */
    quantMissingFactors?: string[];
    /** 因数据过期被剔除的量化因子 */
    quantStaleFactors?: string[];
    /** 当日建议目标仓 %（相对计划仓，供次日日平滑） */
    positionTargetPct?: number;
  };
  /** 1/3/5 年等多期限方向预期（本地规则推导，非价格预测） */
  longTermOutlook?: LongTermOutlook;
  /** 1～3 个月中期方向预期（本地慢变量规则） */
  midTermOutlook?: MidTermOutlook;
  /** SQLite analysis_reports 行 id，供分析流程末尾回写富化后的报告 */
  reportRowId?: number;
  /** 当日宏观阶段（写入 JSON 供 regime 校准） */
  macroRegime?: import('../utils/macro-regime.js').MacroRegime;
  /** 本地因果规则匹配结果 */
  causalChains?: import('../utils/gold-causal-rules.js').CausalChainMatch[];
  /** 情景概率来源 */
  scenarioProbSource?: 'llm' | 'historical' | 'insufficient';
  /** v2.4 八维全景分析（「三基 + 五专」正交体系） */
  dimensions?: EightDimensionProfile;
}

/** 长期展望 — 单期限 */
export type LongTermHorizonYears = 1 | 3 | 5;

export interface LongTermHorizonOutlook {
  years: LongTermHorizonYears;
  label: string;
  direction: Direction;
  /** 偏多强度 0–100（50=中性） */
  biasScore: number;
  confidence: 'low' | 'moderate' | 'high';
  /** 方向描述，如「结构偏多」 */
  trendLabel: string;
  /** 参考区间：历史分位优先；low 置信可不展示点位 */
  returnBand: string;
  /** 配置档位（比点位预测更可操作） */
  allocationStance?: 'overweight' | 'neutral' | 'underweight';
  drivers: string[];
  risks: string[];
  /** 支付宝定投者操作建议 */
  dcaAdvice: string;
}

/** 长期展望汇总 */
export interface LongTermOutlook {
  summary: string;
  horizons: LongTermHorizonOutlook[];
  disclaimer: string;
}

/** 分析报告存储记录 */
export interface AnalysisReportRecord {
  id: number;
  date: string;
  horizon: string;
  reportJson: string;
  overallScore: number;
  quantScore?: number;
  direction: Direction;
  createdAt: string;
}
