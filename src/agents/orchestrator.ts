// 综合编排 Agent — 汇总四维度 + 反驳 + 校准 + 双轨策略

import { BaseAgent, AgentTimeoutError } from './base.js';
import { getConfig } from '../utils/config.js';
import { getDb } from '../db/index.js';
import { CalibrationRepo } from '../db/calibration.js';
import { ScenarioFeaturesRepo } from '../db/scenario-features.js';
import { ReportsRepo } from '../db/reports.js';
import { GoldPricesRepo } from '../db/gold-prices.js';
import { InstitutionalFlowsRepo } from '../db/institutional-flows.js';
import { computeInstitutionalSignal } from '../indicators/flow-signal.js';
import { computeQuantScore } from '../indicators/quant-score.js';
import { resolveOverallScore, enforceOverallScore } from '../utils/overall-score.js';
import { applyCalibrationScore, directionFromScore } from '../utils/calibration-adjust.js';
import { adjustScoreWithRebuttal } from '../utils/rebuttal-score.js';
import { scoreBucketRange } from '../utils/score-buckets.js';
import { countConsecutiveDirectionDays } from '../utils/consecutive-direction.js';
import { forwardFillCloses, latestDeviationFromMA, pickMacroSeries } from '../utils/price-series.js';
import { applyScenarioProbabilities, formatScenarioProbLine, type ScenarioProbabilities } from '../utils/scenario-probability.js';
import type { MacroRegime } from '../utils/macro-regime.js';
import type { CausalChainMatch } from '../utils/gold-causal-rules.js';
import type { TechnicalAnalysis, FundamentalAnalysis, SentimentAnalysis, Direction, ShortTermStrategy, MidTermStrategy, Scenarios, RebuttalAnalysis, GoldAnalysisReport } from '../types/analysis.js';
import type { MarketData } from '../types/market.js';
import type { FundAnalysis } from '../types/fund.js';

const ORCHESTRATOR_PROMPT = `你是黄金投资研究综合编排师。你将汇总技术面、基本面、情绪面、基金面四维度分析，结合反驳分析和校准数据，输出双视角策略报告。

## 双视角分析规则

### 短期视角（日线级别，持仓数天~2周）
- 操作品种：黄金ETF场内(518880)、纸黄金
- 入场信号：日线MACD金叉、RSI超卖回升等
- 出场策略：目标位止盈 + 固定止损(3-5%)
- 快进快出，不恋战

### 中长期视角（周线级别，持仓1~6个月）
- 第一层：定投基础仓（60-70%）— 积存金或000216/002610定投
- 第二层：波段加减仓（30-40%）— 金价处于周线支撑区加仓，阻力区减仓
- 风控：估值止盈（偏离年线>15%考虑减仓）

## 情景分析要求

你必须输出三个情景（基准/上行/下行），而非单一预测：
1. 基准情景：最可能发生的路径（概率45-60%）
2. 上行情景：超预期情景（概率15-30%）
3. 下行情景：不及预期情景（概率15-30%，不得低于15%）

规则：
- 三个概率之和 = 100%
- 每个情景必须有明确的触发条件
- 下行情景的概率不得低于15%（这是风险暴露的要求）

## 投资风格规则
1. 严禁推荐杠杆/期货产品
2. 具体说明持有期适合A类还是C类基金
3. 短期和中长期信号矛盾时，必须同时呈现两方逻辑

  ## 反驳结果处理
  1. 如果反驳强度≥中等，在风险提示中突出看空论据
  2. 不得忽略反驳结果
  3. 评分应考虑反驳修正

## 输出格式（严格遵守，直接输出JSON，不要用markdown代码块）
{
  "overall": {
    "score": 数字(0-100),
    "direction": "bullish/bearish/neutral",
    "scenarios": {
      "base": { "probability": 数字, "description": "字符串", "goldPrice": "字符串", "action": "字符串", "confidence": "low/moderate/high" },
      "upside": { "probability": 数字, "description": "字符串", "goldPrice": "字符串", "trigger": "字符串", "action": "字符串", "confidence": "low/moderate/high" },
      "downside": { "probability": 数字, "description": "字符串", "goldPrice": "字符串", "trigger": "字符串", "action": "字符串", "confidence": "low/moderate/high" }
    },
    "shortTerm": {
      "horizon": "short-term",
      "action": "字符串",
      "entryZone": "字符串",
      "target": "字符串",
      "stopLoss": "字符串",
      "recommendedProduct": "字符串",
      "riskWarning": "字符串"
    },
    "midTerm": {
      "horizon": "medium-term",
      "investAdvice": { "dipInvest": "continue/increase/pause", "positionAdjust": "add/reduce/hold", "recommendedFund": "字符串" },
      "keyLevels": { "supportZone": "字符串", "resistanceZone": "字符串" },
      "riskWarning": "字符串"
    }
  }
}`;

export interface OrchestrateOptions {
  macroRegime: MacroRegime;
  recentReportsContext: string;
  scenarioProbs?: ScenarioProbabilities;
  causalChains?: CausalChainMatch[];
}

export class OrchestratorAgent extends BaseAgent {
  constructor() {
    const config = getConfig();
    super({ name: 'orchestrator', model: config.model, systemPrompt: ORCHESTRATOR_PROMPT });
  }

  /** 综合编排，输出完整报告 */
  async orchestrate(
    marketData: MarketData,
    technical: TechnicalAnalysis,
    fundamental: FundamentalAnalysis,
    sentiment: SentimentAnalysis,
    fund: FundAnalysis,
    rebuttal: RebuttalAnalysis,
    horizon: 'short' | 'mid' | 'all' = 'all',
    opts: OrchestrateOptions,
  ): Promise<GoldAnalysisReport> {
    // 获取校准上下文
    const db = getDb();
    const calibrationRepo = new CalibrationRepo(db);
    const dimScores = {
      technical: technical.score,
      fundamental: fundamental.score,
      sentiment: sentiment.score,
    };
    let workingRebuttal = rebuttal;
    let initialScore = resolveOverallScore(workingRebuttal, dimScores);
    let calibrationContext = calibrationRepo.getCalibrationContext(initialScore, opts.macroRegime.tag);

    // 评分乘数在线校准：用历史偏差微调反驳强度乘数后重算 adjustedScore
    if (calibrationContext && (calibrationContext.sampleSize ?? 0) >= 5) {
      const dimAvg = Math.round((dimScores.technical + dimScores.fundamental + dimScores.sentiment) / 3);
      const bucket = scoreBucketRange(dimAvg);
      const midScore = bucket ? (bucket.min + bucket.max) / 2 : dimAvg;
      const acc = calibrationContext.historicalAccuracy;
      const calibrationError = acc != null ? Math.abs(midScore - acc * 100) : null;
      const { adjustedScore, netEffect } = adjustScoreWithRebuttal(
        dimAvg,
        workingRebuttal.bearScore,
        workingRebuttal.rebuttalStrength,
        {
          systematicBias: calibrationContext.systematicBias,
          calibrationError,
          sampleSize: calibrationContext.sampleSize,
        },
      );
      workingRebuttal = { ...workingRebuttal, adjustedScore, netEffect };
      initialScore = resolveOverallScore(workingRebuttal, dimScores);
      calibrationContext = calibrationRepo.getCalibrationContext(initialScore, opts.macroRegime.tag)
        ?? calibrationContext;
    }

    // 自动回填
    try {
      calibrationRepo.backfillPending();
    } catch { /* ignore */ }

    // 注入校准数据
    let calibrationText = '校准数据不足（样本<5），暂无统计参考';
    if (calibrationContext && calibrationContext.historicalAccuracy !== null) {
      const pct5 = Math.round(calibrationContext.historicalAccuracy * 100);
      const pct20 = calibrationContext.historicalAccuracy20d != null
        ? Math.round(calibrationContext.historicalAccuracy20d * 100)
        : null;
      const t20Part = pct20 != null ? `，20日涨概率${pct20}%` : '';
      calibrationText = `评分${calibrationContext.scoreRange}区间：历史${calibrationContext.sampleSize}次分析，5日涨概率${pct5}%${t20Part}，系统偏差：${calibrationContext.systematicBias}`;
      if (
        calibrationContext.regimeTag
        && calibrationContext.regimeSampleSize != null
        && calibrationContext.regimeSampleSize >= 3
        && calibrationContext.regimeHistoricalAccuracy != null
      ) {
        const rp = Math.round(calibrationContext.regimeHistoricalAccuracy * 100);
        calibrationText += `；同宏观阶段「${opts.macroRegime.label}」${calibrationContext.regimeSampleSize}次，5日涨概率${rp}%（${calibrationContext.regimeSystematicBias}）`;
      }
    }

    const calAdjust = applyCalibrationScore(initialScore, calibrationContext);
    const displayScore = calAdjust.calibratedScore;
    const displayDirection = directionFromScore(displayScore);

    // 纯量化评分（与 LLM 评分并行，独立可复现；因子明细写入报告）
    let quantScore: number | undefined;
    let quantFactors: GoldAnalysisReport['overall']['quantFactors'];
    let quantCoverage: number | undefined;
    let quantMissingFactors: string[] | undefined;
    let quantStaleFactors: string[] | undefined;
    try {
      const pricesRepo = new GoldPricesRepo(db);
      const recentRecords = pricesRepo.getRecent(120);
      const closes = forwardFillCloses(recentRecords);
      const sorted = closes.filter((v): v is number => v != null);
      const dxySeries = pickMacroSeries(recentRecords, r => r.dollarIndex);
      const us10ySeries = pickMacroSeries(recentRecords, r => r.us10yYield);
      const tipsSeries = pickMacroSeries(recentRecords, r => r.tipsYield);
      const flowSignal = computeInstitutionalSignal(
        marketData?.london?.price?.value ?? null,
      );
      const quantResult = computeQuantScore({
        closes: sorted,
        dxy: dxySeries.values.length >= 20 ? dxySeries.values : undefined,
        us10y: us10ySeries.values.length >= 20 ? us10ySeries.values : undefined,
        tips: tipsSeries.values.length >= 20 ? tipsSeries.values : undefined,
        flowSignal,
        regimeTag: opts.macroRegime.tag,
        macroAgeDays: {
          dxy: dxySeries.ageDays,
          us10y: us10ySeries.ageDays,
          tips: tipsSeries.ageDays,
        },
      });
      quantScore = quantResult.score;
      quantFactors = quantResult.factors;
      quantCoverage = quantResult.coverage;
      quantMissingFactors = quantResult.missingFactors;
      quantStaleFactors = quantResult.staleFactors;
    } catch {
      quantScore = undefined;
      quantFactors = undefined;
    }

    const schema = {
      type: 'object',
      properties: {
        overall: {
          type: 'object',
          properties: {
            score: { type: 'number' },
            direction: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
            scenarios: {
              type: 'object',
              properties: {
                base: { type: 'object', properties: { probability: { type: 'number' }, description: { type: 'string' }, goldPrice: { type: 'string' }, action: { type: 'string' }, confidence: { type: 'string' } } },
                upside: { type: 'object', properties: { probability: { type: 'number' }, description: { type: 'string' }, goldPrice: { type: 'string' }, trigger: { type: 'string' }, action: { type: 'string' }, confidence: { type: 'string' } } },
                downside: { type: 'object', properties: { probability: { type: 'number' }, description: { type: 'string' }, goldPrice: { type: 'string' }, trigger: { type: 'string' }, action: { type: 'string' }, confidence: { type: 'string' } } },
              },
            },
            shortTerm: {
              type: 'object',
              properties: {
                horizon: { type: 'string' },
                action: { type: 'string' },
                entryZone: { type: 'string' },
                target: { type: 'string' },
                stopLoss: { type: 'string' },
                recommendedProduct: { type: 'string' },
                riskWarning: { type: 'string' },
              },
            },
            midTerm: {
              type: 'object',
              properties: {
                horizon: { type: 'string' },
                investAdvice: { type: 'object', properties: { dipInvest: { type: 'string' }, positionAdjust: { type: 'string' }, recommendedFund: { type: 'string' } } },
                keyLevels: { type: 'object', properties: { supportZone: { type: 'string' }, resistanceZone: { type: 'string' } } },
                riskWarning: { type: 'string' },
              },
            },
          },
        },
      },
      required: ['overall'],
    };

    const fmtPct = (v: number | null | undefined): string => (v == null ? 'N/A' : `${v > 0 ? '+' : ''}${v}%`);
    const safe = (v: unknown, fallback = 'N/A'): string => v == null ? fallback : String(v);
    const londonVal = marketData.london?.price?.value;
    const londonChg = marketData.london?.price?.change;
    const shanghaiVal = marketData.shanghai?.price?.value;
    const etfNavVal = marketData.etf?.nav?.value;
    const dxyVal = marketData.dollarIndex?.value?.value;

    const scenarioHint = opts.scenarioProbs
      ? formatScenarioProbLine(opts.scenarioProbs)
      : '';

    const causalHint = opts.causalChains?.length
      ? opts.causalChains.map(c => `${c.cause}→${c.effect}`).join('；')
      : '';

    const prompt = `## 市场数据
伦敦金: $${safe(londonVal)} (${londonChg != null ? (londonChg > 0 ? '+' : '') + londonChg + '%' : 'N/A'})
上海金: ¥${safe(shanghaiVal)}/g
ETF(518880): ${safe(etfNavVal)}
美元指数: ${safe(dxyVal)}
10Y美债: ${marketData.usTreasury?.yield10y?.value ?? 'N/A'}%

## 技术面 (${technical.score}/100 ${technical.direction})
短期: ${technical.shortTerm.trend}, ${technical.shortTerm.keySignal}
中长期: ${technical.midTerm.trend}, ${technical.midTerm.keySignal}

## 基本面 (${fundamental.score}/100 ${fundamental.direction})
${fundamental.keyPoints.join('; ')}

## 情绪面 (${sentiment.score}/100 ${sentiment.direction})
${sentiment.keyPoints.join('; ')}

## 基金面
估值: ${fund.valuation?.level ?? 'N/A'}, 溢价折价: ${fund.premiumDiscount?.current ?? 'N/A'}%

## 反驳分析
看空力度: ${workingRebuttal.bearScore}/100 (强度: ${workingRebuttal.rebuttalStrength})
看空论据: ${(workingRebuttal.bearPoints ?? []).map(p => p.point).join('; ')}
看多漏洞: ${(workingRebuttal.bullVulnerabilities ?? []).map(v => v.vulnerability).join('; ')}
评分修正: ${workingRebuttal.adjustedScore ?? '未修正'} (${workingRebuttal.netEffect})

## 历史校准
${calibrationText}

## 宏观阶段
${opts.macroRegime.label}（${opts.macroRegime.tag}）：${opts.macroRegime.description}

${opts.recentReportsContext}

${scenarioHint ? `## 情景概率参考（统计）\n${scenarioHint}\n情景描述由你撰写，概率请尽量贴近上述统计参考。\n` : ''}
${causalHint ? `## 因果链参考（本地规则）\n${causalHint}\n` : ''}

## 输出视角
${horizon === 'short' ? '仅短期视角' : horizon === 'mid' ? '仅中长期视角' : '双视角（短期+中长期）'}

## 评分规则（重要）
你的综合评分(overall.score)必须以修正后的评分为准。本报告反驳修正分为 ${initialScore}，校准后参考分为 ${displayScore}（${calAdjust.reason}）。
你的任务不是重新打分，而是基于 ${displayScore} 分撰写配套的综合研判、情景分析和双轨策略。
评分只能在小范围内微调（±3分），且必须在报告中说明调整理由。`;

    let orchestratorResult: {
      overall: {
        score: number;
        direction: Direction;
        scenarios: Scenarios;
        shortTerm: ShortTermStrategy;
        midTerm: MidTermStrategy;
      };
    };
    try {
      orchestratorResult = await this.structuredPrompt<{
        overall: {
          score: number;
          direction: Direction;
          scenarios: Scenarios;
          shortTerm: ShortTermStrategy;
          midTerm: MidTermStrategy;
        };
      }>(prompt, schema);
    } catch (err) {
      console.warn(`  ⚠️ 编排 Agent 异常 (${this.name}):`, err instanceof AgentTimeoutError ? '超时' : (err instanceof Error ? err.message : err));
      // 用四维度均分 + 中性策略构建回落报告
      const fallbackScore = Math.round((technical.score + fundamental.score + sentiment.score) / 3);
      return {
        timestamp: new Date().toISOString(),
        marketData,
        macroRegime: opts.macroRegime,
        causalChains: opts.causalChains,
        scenarioProbSource: 'llm',
        dataQuality: { overallConfidence: 60, warnings: ['编排 Agent 超时，使用回落报告'] },
        technical,
        fundamental,
        sentiment,
        fund,
        rebuttal: workingRebuttal,
        tailRisks: workingRebuttal.tailRisks ?? [],
        overall: {
          score: fallbackScore,
          direction: 'neutral' as Direction,
          quantScore: undefined,
          scenarios: {
            base: { probability: 50, description: '编排超时，无情景分析', goldPrice: 'N/A', action: '维持现有仓位', confidence: 'low' },
            upside: { probability: 25, description: '无数据（分析异常）', goldPrice: 'N/A', trigger: 'N/A', action: '观望', confidence: 'low' },
            downside: { probability: 25, description: '无数据（分析异常）', goldPrice: 'N/A', trigger: 'N/A', action: '观望', confidence: 'low' },
          } as Scenarios,
          shortTerm: { horizon: 'short-term', action: '数据不足暂停操作', entryZone: 'N/A', target: 'N/A', stopLoss: 'N/A', recommendedProduct: 'N/A', riskWarning: '编排 Agent 超时，策略不可用' } as ShortTermStrategy,
          midTerm: { horizon: 'medium-term', investAdvice: { dipInvest: 'continue', positionAdjust: 'hold', recommendedFund: 'N/A' }, keyLevels: { supportZone: 'N/A', resistanceZone: 'N/A' }, riskWarning: '编排 Agent 超时，策略不可用' } as MidTermStrategy,
          calibration: { scoreRange: 'N/A', historicalAccuracy: null, historicalAccuracy20d: null, systematicBias: '分析异常', sampleSize: 0, rawScore: fallbackScore, calibrationOffset: 0, calibrationApplied: false, calibrationReason: '编排超时回落' },
        },
      };
    }

    let scenarios = orchestratorResult.overall.scenarios;
    let scenarioProbSource: GoldAnalysisReport['scenarioProbSource'] = 'llm';
    if (opts.scenarioProbs) {
      scenarios = applyScenarioProbabilities(scenarios, opts.scenarioProbs);
      scenarioProbSource = opts.scenarioProbs.source;
    }

    // 构建完整报告
    const report: GoldAnalysisReport = {
      timestamp: new Date().toISOString(),
      marketData,
      macroRegime: opts.macroRegime,
      causalChains: opts.causalChains,
      scenarioProbSource,
      dataQuality: {
        overallConfidence: 80,
        warnings: [],
      },
      technical,
      fundamental,
      sentiment,
      fund,
      rebuttal: workingRebuttal,
      tailRisks: workingRebuttal.tailRisks ?? [],
      overall: {
        ...orchestratorResult.overall,
        scenarios,
        score: enforceOverallScore(orchestratorResult.overall.score, displayScore),
        direction: displayDirection,
        quantScore,
        quantFactors,
        quantCoverage,
        quantMissingFactors,
        quantStaleFactors,
        calibration: {
          ...(calibrationContext ?? {
            scoreRange: 'N/A',
            historicalAccuracy: null,
            historicalAccuracy20d: null,
            systematicBias: '样本不足',
            sampleSize: 0,
          }),
          rawScore: calAdjust.rawScore,
          calibrationOffset: calAdjust.offset,
          calibrationApplied: calAdjust.applied,
          calibrationReason: calAdjust.reason,
        },
      },
    };

    // 自动保存报告到 SQLite；返回行 id 供分析流程末尾覆盖为富化后的版本
    report.reportRowId = this.saveReport(report, horizon);

    return report;
  }

  /** 保存报告，返回行 id（失败时 undefined） */
  private saveReport(report: GoldAnalysisReport, horizon: string): number | undefined {
    try {
      const db = getDb();
      const reportsRepo = new ReportsRepo(db);
      const reportId = reportsRepo.insert({
        date: report.timestamp.slice(0, 10),
        horizon,
        reportJson: JSON.stringify(report),
        overallScore: report.overall.score,
        quantScore: report.overall.quantScore ?? null,
        direction: report.overall.direction,
      });

      // 存储市场特征向量（从实际分析结果提取）
      const featuresRepo = new ScenarioFeaturesRepo(db);
      const d = report.marketData?.dollarIndex?.value?.change ?? 0;
      const m = report.marketData;
      const t = report.technical;
      const f = report.fundamental;
      const s = report.sentiment;

      // TIPS 变动方向
      const tipsChange = m?.usTreasury?.tips?.value;
      const tipsDir = tipsChange != null ? (tipsChange > 0 ? 'up' : tipsChange < 0 ? 'down' : 'flat') : 'flat';

      // VIX 等级估算
      const vixText = s?.vix ?? '';
      let vixLevel = 15;
      if (vixText) {
        const vixMatch = vixText.match(/(\d+\.?\d*)/);
        if (vixMatch) vixLevel = parseFloat(vixMatch[1]);
      }

      // 金价偏离 MA20（本地计算）
      let goldDeviation = 0;
      try {
        const pricesRepo = new GoldPricesRepo(db);
        const closes = forwardFillCloses(pricesRepo.getRecent(60));
        const dev = latestDeviationFromMA(closes, 20);
        if (dev != null) goldDeviation = dev;
      } catch { /* ignore */ }

      // fedStance 从基本面提取
      const fedRaw = f?.fedStance ?? '';

      const reportDate = report.timestamp.slice(0, 10);
      const recentReports = reportsRepo.getRecent(30);
      const consecutiveDays = countConsecutiveDirectionDays(
        recentReports.map(r => ({ date: r.date, direction: r.direction })),
        report.overall.direction,
        reportDate,
      );

      // 主力动向特征
      let cftcPercentile: number | null = null;
      let etfFlow5d: number | null = null;
      let flowScore: number | null = null;
      try {
        const flowsRepo = new InstitutionalFlowsRepo(db);
        const flowSignal = computeInstitutionalSignal(
          report.marketData?.london?.price?.value ?? null,
        );
        cftcPercentile = flowSignal.cftc.percentile;
        etfFlow5d = flowSignal.etfFlow.change5d;
        flowScore = flowSignal.overallScore;
      } catch { /* ignore — 主力数据可能尚未初始化 */ }

      featuresRepo.insert({
        date: reportDate,
        reportId,
        dollarDirection: d > 0.5 ? 'up' : d < -0.5 ? 'down' : 'flat',
        dollarMagnitude: Math.abs(d),
        tipsDirection: tipsDir,
        tipsMagnitude: tipsChange != null ? Math.abs(tipsChange) : 0,
        goldDeviation,
        vixLevel,
        fedStance: fedRaw.includes('鸽') ? 'dovish' : fedRaw.includes('鹰') ? 'hawkish' : 'neutral',
        geopoliticalRisk: s?.geopoliticalRisk?.includes('高') ? 'high' : s?.geopoliticalRisk?.includes('低') ? 'low' : 'medium',
        momentumDirection: report.overall.direction === 'bullish' ? 'up' : report.overall.direction === 'bearish' ? 'down' : 'flat',
        consecutiveDays,
        cftcPercentile,
        etfFlow5d,
        flowScore,
      });
      return reportId;
    } catch (err) {
      console.error('保存报告失败:', err);
      return undefined;
    }
  }
}
