// 强制反驳 Agent — 独立 session，系统性寻找看空论据

import { BaseAgent, AgentTimeoutError } from './base.js';
import { getConfig } from '../utils/config.js';
import { adjustScoreWithRebuttal } from '../utils/rebuttal-score.js';
import { parseRebuttalRaw } from '../schemas/dimension.js';
import type { RebuttalAnalysis, TechnicalAnalysis, FundamentalAnalysis, SentimentAnalysis, Direction, RebuttalStrength, BearPoint, BullVulnerability } from '../types/analysis.js';
import type { FundAnalysis } from '../types/fund.js';
import type { MarketData } from '../types/market.js';

/** 反驳分析回落：中性，不做评分修正 */
export const REBUTTAL_FALLBACK: RebuttalAnalysis = {
  bullScore: 50,
  bearScore: 50,
  rebuttalStrength: 'weak',
  bearPoints: [{ point: '反驳分析超时，无法生成看空论据', evidence: 'N/A', probability: 0, impact: '无影响' }],
  bullVulnerabilities: [],
  netEffect: 'unchanged',
  adjustedScore: undefined,
  tailRisks: [],
};

/** 格式化涨跌幅，缺失值显示 N/A */
function fmtPct(v: number | null | undefined): string {
  return v == null ? 'N/A' : `${v > 0 ? '+' : ''}${v}%`;
}

const REBUTTAL_PROMPT = `你是黄金投资分析的独立反驳者。你的唯一任务是找出所有支持金价下跌或风险的证据。

# 规则
1. 你必须找到至少3条实质性看空论据
2. 对每条看多论据，你必须尝试找到它的漏洞或适用条件
3. 如果找不到看空论据，说明你不够努力——几乎任何时刻都有看空理由
4. 你的评分（0-100）代表纯粹的看空力度，100=极度看空
5. 不需要"平衡"观点，你只负责反驳

# 输出格式
{
  "bearScore": 0-100,
  "bearPoints": [
    { "point": "论据描述", "evidence": "证据来源", "probability": 概率百分比, "impact": "如果发生的影响" }
  ],
  "bullVulnerabilities": [
    { "originalPoint": "原看多论据", "vulnerability": "漏洞或适用条件", "counterCondition": "在什么条件下此论据失效" }
  ],
  "rebuttalStrength": "weak/moderate/strong",
  "tailRisks": [
    { "risk": "风险描述", "probability": 概率百分比, "impact": "影响描述", "trigger": "触发条件", "mitigation": "对冲建议" }
  ]
}`;

export class RebuttalAgent extends BaseAgent {
  constructor() {
    const config = getConfig();
    super({ name: 'rebuttal', model: config.model, systemPrompt: REBUTTAL_PROMPT });
  }

  /** 生成反驳分析 */
  async rebut(
    technical: TechnicalAnalysis,
    fundamental: FundamentalAnalysis,
    sentiment: SentimentAnalysis,
    fund: FundAnalysis,
    marketData: MarketData,
  ): Promise<RebuttalAnalysis> {
    try {
      return await this.doRebuttal(technical, fundamental, sentiment, fund, marketData);
    } catch (err) {
      console.warn(`  ⚠️ 反驳 Agent 异常:`, err instanceof AgentTimeoutError ? '超时' : (err instanceof Error ? err.message : err));
      return REBUTTAL_FALLBACK;
    }
  }

  /** 实际反驳逻辑 */
  private async doRebuttal(
    technical: TechnicalAnalysis,
    fundamental: FundamentalAnalysis,
    sentiment: SentimentAnalysis,
    fund: FundAnalysis,
    marketData: MarketData,
  ): Promise<RebuttalAnalysis> {
    const schema = {
      type: 'object',
      properties: {
        bearScore: { type: 'number' },
        bearPoints: { type: 'array', items: { type: 'object', properties: { point: { type: 'string' }, evidence: { type: 'string' }, probability: { type: 'number' }, impact: { type: 'string' } } } },
        bullVulnerabilities: { type: 'array', items: { type: 'object', properties: { originalPoint: { type: 'string' }, vulnerability: { type: 'string' }, counterCondition: { type: 'string' } } } },
        rebuttalStrength: { type: 'string', enum: ['weak', 'moderate', 'strong'] },
        tailRisks: { type: 'array', items: { type: 'object', properties: { risk: { type: 'string' }, probability: { type: 'number' }, impact: { type: 'string' }, trigger: { type: 'string' }, mitigation: { type: 'string' } } } },
      },
      required: ['bearScore', 'bearPoints', 'bullVulnerabilities', 'rebuttalStrength', 'tailRisks'],
    };

    // 注意：不传入综合评分，避免锚定效应
    const analysisContext = `
## 技术面分析
- 评分: ${technical.score}/100 (${technical.direction})
- 短期: ${technical.shortTerm.trend}, 信号: ${technical.shortTerm.keySignal}
- 中长期: ${technical.midTerm.trend}, 信号: ${technical.midTerm.keySignal}
- 看多论据: ${technical.keyPoints.join('; ')}

## 基本面分析
- 评分: ${fundamental.score}/100 (${fundamental.direction})
- 美元影响: ${fundamental.dollarIndexEffect}
- 利率影响: ${fundamental.interestRateEffect}
- 美联储倾向: ${fundamental.fedStance}
- 看多论据: ${fundamental.keyPoints.join('; ')}

## 情绪面分析
- 评分: ${sentiment.score}/100 (${sentiment.direction})
- 央行购金: ${sentiment.centralBanks}
- CFTC: ${sentiment.cftcPosition}
- 地缘风险: ${sentiment.geopoliticalRisk}
- 看多论据: ${sentiment.keyPoints.join('; ')}

## 基金面分析
- 估值水位: ${fund.valuation?.level ?? 'N/A'}
- 溢价折价: ${fund.premiumDiscount?.current ?? 'N/A'}%

## 市场数据
- 伦敦金: $${marketData.london.price?.value} (${marketData.london.price?.change > 0 ? '+' : ''}${marketData.london.price?.change}%)
- 美元指数: ${marketData.dollarIndex.value?.value} (${marketData.dollarIndex.value?.change > 0 ? '+' : ''}${marketData.dollarIndex.value?.change}%)
- 10Y美债: ${marketData.usTreasury.yield10y?.value}%
- TIPS: ${marketData.usTreasury.tips?.value ?? 'N/A'}%

请系统性地反驳上述分析，找出所有被忽略的风险。`;

    const llmRaw = await this.structuredPrompt<{
      bearScore: number;
      bearPoints: BearPoint[];
      bullVulnerabilities: BullVulnerability[];
      rebuttalStrength: RebuttalStrength;
      tailRisks: import('../types/analysis.js').TailRisk[];
    }>(analysisContext, schema);
    const rawResult = parseRebuttalRaw(llmRaw);

    // 用客观指标判定反驳强度（不依赖 LLM 自述）
    const rebuttalStrength = determineRebuttalStrength(rawResult);

    // 计算评分修正（乘数可按历史校准偏差微调）
    const initialScore = Math.round((technical.score + fundamental.score + sentiment.score) / 3);
    const { adjustedScore, netEffect } = adjustScoreWithRebuttal(
      initialScore,
      rawResult.bearScore,
      rebuttalStrength,
    );

    return {
      bullScore: 100 - rawResult.bearScore,
      bearScore: rawResult.bearScore,
      rebuttalStrength,
      bearPoints: rawResult.bearPoints,
      bullVulnerabilities: rawResult.bullVulnerabilities,
      netEffect,
      adjustedScore,
      tailRisks: rawResult.tailRisks,
    };
  }
}

/** 用客观指标判定反驳强度 */
function determineRebuttalStrength(rebuttal: { bearScore: number; bearPoints: BearPoint[]; bullVulnerabilities: BullVulnerability[] }): RebuttalStrength {
  let strength = 0;

  // 维度1: bearScore 本身
  if (rebuttal.bearScore >= 70) strength += 40;
  else if (rebuttal.bearScore >= 55) strength += 25;
  else if (rebuttal.bearScore >= 40) strength += 15;
  else strength += 5;

  // 维度2: 高概率看空论据数量
  const highProbPoints = rebuttal.bearPoints.filter(p => p.probability >= 30);
  strength += Math.min(highProbPoints.length * 10, 30);

  // 维度3: 看多漏洞数量
  strength += Math.min(rebuttal.bullVulnerabilities.length * 10, 30);

  if (strength >= 60) return 'strong';
  if (strength >= 35) return 'moderate';
  return 'weak';
}

