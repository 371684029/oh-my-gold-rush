// goldrush analysis — 综合分析报告

import { DataCollectorAgent } from '../agents/data-collector.js';
import { ValidatorAgent } from '../agents/validator.js';
import { TechnicalAgent, FundamentalAgent, SentimentAgent, FundAgent, TECHNICAL_FALLBACK, FUNDAMENTAL_FALLBACK, SENTIMENT_FALLBACK, FUND_FALLBACK } from '../agents/analysis-agents.js';
import { RebuttalAgent, REBUTTAL_FALLBACK } from '../agents/rebuttal.js';
import { OrchestratorAgent } from '../agents/orchestrator.js';
import { AgentTimeoutError } from '../agents/base.js';
import chalk from 'chalk';
import { header, separator, directionMark, scoreBar, changeColor, riskLevel, valuationMark, sessionMark } from '../utils/format.js';
import { formatReportMarkdown } from '../utils/report-md.js';
import { buildReportMeta, saveReportMeta } from '../utils/report-meta.js';
import { attachProbPath } from '../utils/prob-path-attach.js';
import { computeTailRiskIndex } from '../utils/tail-risk.js';
import { getConfig } from '../utils/config.js';
import { buildScoreBreakdown, extendBreakdownWithCalibration, formatScoreBreakdownConsole, formatScoreBreakdownOneLine } from '../utils/score-breakdown.js';
import { detectMacroRegime, formatMacroRegimeLine } from '../utils/macro-regime.js';
import { buildJudgeVerdict, formatJudgeVerdictConsole } from '../utils/judge-verdict.js';
import { buildLongTermOutlook, formatLongTermOutlookConsole } from '../utils/long-term-outlook.js';
import {
  buildMidTermOutlook,
  formatMidTermOutlookConsole,
  type MidTermOutlook,
} from '../utils/mid-term-outlook.js';
import { findSimilarPatterns } from '../utils/scenario-similarity.js';
import { buildRunManifest, saveRunManifest, wrapAnalysisOutputV1 } from '../utils/run-manifest.js';
import { getDb } from '../db/index.js';
import { ScenarioFeaturesRepo } from '../db/scenario-features.js';
import { ReportsRepo } from '../db/reports.js';
import { forwardFillCloses, latestDeviationFromMA, pickMacroSeries } from '../utils/price-series.js';
import { GoldPricesRepo } from '../db/gold-prices.js';
import { ensureGoldPriceHistory, MIN_TRADING_ROWS_FOR_ANALYSIS } from '../utils/ensure-gold-history.js';
import { priceSeriesProxyNote, spotProxyDeviationWarning } from '../utils/price-semantics.js';
import { evaluateAnalysisGate } from '../utils/analysis-gate.js';
import { buildSmartReport, parseReportJson } from '../utils/smart-analysis.js';
import { buildRecentReportsContext } from '../utils/report-history-context.js';
import { loadPreviousReflect } from './reflect.js';
import { formatReflectPromptContext } from '../utils/weekly-reflect.js';
import { resolveOverallScore } from '../utils/overall-score.js';
import { directionFromScore } from '../utils/calibration-adjust.js';
import { countConsecutiveDirectionDays } from '../utils/consecutive-direction.js';
import { buildScenarioFeatureDraft, draftToScenarioFeature } from '../utils/scenario-feature-builder.js';
import { computeScenarioProbabilities } from '../utils/scenario-probability.js';
import { matchCausalChains, formatCausalChainsConsole } from '../utils/gold-causal-rules.js';
import {
  checkConsistency,
  consistencyEmoji,
  resolveOperationalAdvice,
} from '../utils/plain-advice.js';
import {
  buildReliabilityCard,
  formatReliabilityConsole,
  type ReliabilityCard,
} from '../utils/reliability-card.js';
import {
  buildDayDelta,
  formatDayDeltaConsole,
  type DayDelta,
} from '../utils/day-delta.js';
import {
  buildEventGoldTransmission,
  formatTransmissionConsole,
  type EventGoldTransmission,
} from '../utils/event-transmission.js';
import {
  buildReadingChecklist,
  formatReadingChecklistConsole,
  type ReadingChecklist,
} from '../utils/reading-checklist.js';
import type { OrchestrateOptions } from '../agents/orchestrator.js';
import { todayDate, formatNow } from '../utils/time.js';
import type { Horizon } from '../types/config.js';
import type { GoldAnalysisReport } from '../types/analysis.js';
import type { InstitutionalSignal } from '../types/institutional.js';
import { InstitutionalFlowsRepo } from '../db/institutional-flows.js';
import { ensureInstitutionalFlows } from '../utils/ensure-flows.js';
import { computeInstitutionalSignal } from '../indicators/flow-signal.js';
import { formatQuantScoreConsole } from '../indicators/quant-score.js';
import type { PatternMatch } from '../types/calibration.js';
import {
  evaluateDataQualityGate,
  formatDataQualityGateConsole,
  nonActionableAdvice,
  type DataQualityGate,
} from '../utils/data-quality-gate.js';
import {
  evaluateDualScore,
  formatDualScoreConsole,
  alignDualOverrideWithPosition,
  type DualScoreVerdict,
} from '../utils/dual-score.js';
import {
  recommendPosition,
  formatPositionConsole,
  extractPreviousTargetPct,
  type PositionRecommendation,
} from '../utils/position-recommend.js';
import {
  buildPredictionTrackStats,
  savePredictionTrackJson,
  formatPredictionTrackConsole,
  type PredictionTrackStats,
} from '../utils/prediction-track.js';
import { formatQuantScoreMarkdown } from '../indicators/quant-score.js';

export async function analysisCommand(options: {
  horizon: Horizon;
  json: boolean;
  jsonLegacy: boolean;
  save: boolean;
  md: boolean;
  smart: boolean;
}): Promise<number> {
  const startedAt = new Date().toISOString();
  console.log('\n🔬 GoldRush 综合分析启动...\n');

  // Step 0: 自动补齐历史金价（Yahoo GC=F，无需 Tavily）
  console.log('  📜 Step 0: 补齐历史金价 (60 天)...');
  const priceRepo = new GoldPricesRepo(getDb());
  try {
    const hist = await ensureGoldPriceHistory(priceRepo, 60);
    if (hist.filled > 0) {
      console.log(`  ✅ Yahoo 已补 ${hist.filled} 个交易日（共 ${hist.tradingRows} 行，可算 MA/RSI/MACD）`);
    } else if (hist.readyForAnalysis) {
      console.log(`  ✅ 历史金价就绪（${hist.tradingRows} 个交易日）`);
    } else {
      console.log(`  ⚠️ 历史仅 ${hist.tradingRows} 行（需 ≥${MIN_TRADING_ROWS_FOR_ANALYSIS}），指标可能不完整`);
      console.log('  💡 可先运行: goldrush init-history --days 60');
    }
  } catch (err) {
    console.warn('  ⚠️ 历史自动补齐失败:', err instanceof Error ? err.message : err);
    console.warn('  💡 请运行 goldrush init-history --days 60 或检查 Yahoo Finance 网络');
  }

  if (options.smart) {
    const gate = evaluateAnalysisGate(priceRepo.getRecent(5));
    if (gate.mode === 'calm') {
      console.log(`  🧠 Smart 门控：${gate.reason}`);
      const smartExit = await runSmartAnalysis(options, gate, priceRepo, startedAt);
      if (smartExit != null) return smartExit;
      console.log('  ⚡ Smart：无可用上一日报告，转完整分析');
    } else {
      console.log(`  ⚡ Smart：${gate.reason}，运行完整分析`);
    }
  }

  // Step 1: 数据采集 + 验证
  console.log('  📡 Step 1: 采集市场数据...');
  const collector = new DataCollectorAgent();
  let marketData;
  try {
    marketData = await collector.collectMarketData();
  } catch (err) {
    console.error('数据采集失败:', err instanceof Error ? err.message : err);
    await collector.cleanup();
    return 1;
  }

  const validator = new ValidatorAgent();
  const validation = await validator.validate(marketData);
  console.log(`  ✅ 数据采集完成 (置信度: ${validation.overallConfidence}%)`);

  const priceWarnings: string[] = [...validation.warnings];
  priceWarnings.push(priceSeriesProxyNote());
  const latestProxy = priceRepo.getRecent(1)[0]?.londonClose ?? null;
  const spotWarn = spotProxyDeviationWarning(marketData.london?.price?.value, latestProxy);
  if (spotWarn) priceWarnings.push(spotWarn);

  const dataQualityGate = evaluateDataQualityGate({
    marketData,
    overallConfidence: validation.overallConfidence,
    validations: validation.validations,
    warnings: priceWarnings,
    anchorGoldPrice: validation.anchorGoldPrice,
  });
  console.log(formatDataQualityGateConsole(dataQualityGate));
  for (const b of dataQualityGate.banners) {
    if (!priceWarnings.some(w => w.includes(b.trim().slice(0, 12)))) {
      priceWarnings.push(b.trim());
    }
  }

  // Step 1.5: 加载历史数据 + 本地指标已在 TechnicalAgent 中处理

  // Step 1.8: 补齐主力数据 + 计算本地主力信号（注入 SentimentAgent）
  console.log('  📡 Step 1.8: 补齐主力动向数据...');
  const flowsRepo = new InstitutionalFlowsRepo(getDb());
  let flowSignal: InstitutionalSignal | undefined;
  try {
    await ensureInstitutionalFlows(flowsRepo);
    flowSignal = computeInstitutionalSignal(marketData.london?.price?.value ?? null);
    console.log(`  ✅ 主力信号: ${flowSignal.overallScore}/100 ${flowSignal.overallDirection}`);
  } catch (err) {
    console.warn('  ⚠️ 主力数据补齐失败（不影响分析继续）:', err instanceof Error ? err.message : err);
  }

  /** 包裹 agent 调用，超时 or 异常时使用回落值 */
  async function analyzeWithFallback<T>(
    label: string,
    fn: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const reason = err instanceof AgentTimeoutError ? '超时' : (err instanceof Error ? err.message : String(err));
      console.warn(`  ⚠️ ${label} 分析异常 (${reason})，降级为中性估值`);
      return fallback;
    }
  }

  // Step 2: 四维度分析（两批：技术+基本面 并行，情绪+基金 并行）
  console.log('  🧠 Step 2: 四维度分析...');
  console.log('  📊 分析中: 技术面 & 基本面...');
  const [technical, fundamental] = await Promise.all([
    analyzeWithFallback('技术面', () => new TechnicalAgent().analyze(marketData), TECHNICAL_FALLBACK),
    analyzeWithFallback('基本面', () => new FundamentalAgent().analyze(marketData), FUNDAMENTAL_FALLBACK),
  ]);
  console.log(`  ✅ 技术面 ${technical.score}/100 | 基本面 ${fundamental.score}/100`);

  console.log('  📊 分析中: 情绪面 & 基金面...');
  const [sentiment, fund] = await Promise.all([
    analyzeWithFallback('情绪面', () => new SentimentAgent().analyze(marketData, flowSignal), SENTIMENT_FALLBACK),
    analyzeWithFallback('基金面', () => new FundAgent().analyze(marketData), FUND_FALLBACK),
  ]);
  console.log(`  ✅ 情绪面 ${sentiment.score}/100 | 基金面 ${fund.valuation.level}`);

  // Step 2.5: 强制反驳（rebuttal.ts 内部已有 try/catch + fallback，此处再加一层保险）
  console.log('  ⚔️ Step 2.5: 强制反驳...');
  const rebuttalAgent = new RebuttalAgent();
  const rebuttal = await analyzeWithFallback(
    '反驳',
    () => rebuttalAgent.rebut(technical, fundamental, sentiment, fund, marketData),
    REBUTTAL_FALLBACK,
  );
  let scoreBreakdown = buildScoreBreakdown(technical, fundamental, sentiment, rebuttal);
  console.log(`  ✅ 反驳完成 (看空力度: ${rebuttal.bearScore}/100, 强度: ${rebuttal.rebuttalStrength})`);
  console.log(`  📈 ${formatScoreBreakdownOneLine(scoreBreakdown)}`);
  console.log(formatScoreBreakdownConsole(scoreBreakdown));

  let goldDeviation: number | null = null;
  try {
    const closes = forwardFillCloses(priceRepo.getRecent(60));
    goldDeviation = latestDeviationFromMA(closes, 20);
  } catch { /* ignore */ }

  const macroRegime = detectMacroRegime(marketData, goldDeviation);
  const causalChains = matchCausalChains(marketData, macroRegime, goldDeviation);
  console.log(formatCausalChainsConsole(causalChains));

  const db = getDb();
  const reportsRepo = new ReportsRepo(db);
  const today = todayDate();
  let reflectBlock: string | null = null;
  try {
    const prevReflect = loadPreviousReflect();
    if (prevReflect) reflectBlock = formatReflectPromptContext(prevReflect);
  } catch { /* ignore */ }
  const recentReportsContext = buildRecentReportsContext(
    reportsRepo.getRecent(30),
    today,
    3,
    reflectBlock,
  );

  const prelimScore = resolveOverallScore(rebuttal, {
    technical: technical.score,
    fundamental: fundamental.score,
    sentiment: sentiment.score,
  });
  const prelimDirection = directionFromScore(prelimScore);

  let scenarioProbs = computeScenarioProbabilities([]);
  let preSimilar: PatternMatch[] = [];
  try {
    const featRepo = new ScenarioFeaturesRepo(db);
    const consecutiveDays = countConsecutiveDirectionDays(
      reportsRepo.getRecent(30).map(r => ({ date: r.date, direction: r.direction })),
      prelimDirection,
      today,
    );
    const draft = buildScenarioFeatureDraft(
      {
        timestamp: new Date().toISOString(),
        marketData,
        technical,
        fundamental,
        sentiment,
        overall: { direction: prelimDirection },
      },
      goldDeviation ?? 0,
      consecutiveDays,
      flowSignal ? {
        cftcPercentile: flowSignal.cftc.percentile,
        etfFlow5d: flowSignal.etfFlow.change5d,
        flowScore: flowSignal.overallScore,
      } : undefined,
    );
    const history = featRepo.listForSimilarity(200);
    const scoreMap = new Map(reportsRepo.getRecent(365).map(r => [r.id, { score: r.overallScore, direction: r.direction }]));
    preSimilar = findSimilarPatterns(draftToScenarioFeature(draft), history, scoreMap, {
      excludeDate: today,
      topK: 8,
      filledOnly: true,
    });
    scenarioProbs = computeScenarioProbabilities(preSimilar);
    if (scenarioProbs.source === 'historical') {
      console.log(`  📊 ${scenarioProbs.note}`);
    }
  } catch { /* ignore */ }

  const orchestrateOpts: OrchestrateOptions = {
    macroRegime,
    recentReportsContext,
    scenarioProbs,
    causalChains,
  };

  // Step 3: 综合编排（orchestrator.ts 内部已有 try/catch + fallback，此处再加一层）
  console.log('  🎯 Step 3: 综合编排...');
  const orchestrator = new OrchestratorAgent();
  let report: GoldAnalysisReport;
  try {
    report = await orchestrator.orchestrate(
      marketData,
      technical,
      fundamental,
      sentiment,
      fund,
      rebuttal,
      options.horizon,
      orchestrateOpts,
    );
  } catch (err) {
    const reason = err instanceof AgentTimeoutError ? '超时' : (err instanceof Error ? err.message : String(err));
    console.warn(`  ⚠️ 编排 Agent 异常 (${reason})，使用回落报告`);
    // 构建最小可用报告
    const fallbackScore = Math.round((technical.score + fundamental.score + sentiment.score) / 3);
    report = {
      timestamp: new Date().toISOString(),
      marketData,
      technical,
      fundamental,
      sentiment,
      fund,
      rebuttal,
      tailRisks: rebuttal.tailRisks ?? [],
      overall: {
        score: fallbackScore,
        direction: 'neutral',
        scenarios: {} as any,
      } as any,
    } as GoldAnalysisReport;
  }
  scoreBreakdown = extendBreakdownWithCalibration(
    scoreBreakdown,
    report.overall.calibration,
    report.overall.score,
  );
  report.dataQuality = {
    overallConfidence: validation.overallConfidence,
    warnings: priceWarnings,
  };

  // 四维度一致性 + 双打分冲突规则
  const dimConsistency = checkConsistency([
    { name: '技术面', score: technical.score },
    { name: '基本面', score: fundamental.score },
    { name: '情绪面', score: sentiment.score },
    { name: '基金面', score: fund.valuation?.level === 'low' ? 70 : fund.valuation?.level === 'high' ? 25 : 50 },
  ]);
  const dualVerdict = evaluateDualScore(
    report.overall.score,
    report.overall.quantScore,
    {
      consistencyWeak: dimConsistency.level === 'weak',
      dataActionable: dataQualityGate.actionable,
    },
  );

  // 红档：覆盖操作结论。双分冲突等仓位算完后再对齐文案并覆盖，避免两套说法
  if (!dataQualityGate.actionable) {
    applyNonActionableOverlay(report, dataQualityGate);
  }
  console.log('  ✅ 编排完成');
  console.log(formatDualScoreConsole(dualVerdict));

  const judgeVerdict = buildJudgeVerdict(technical, fundamental, sentiment, rebuttal, scoreBreakdown);
  console.log(formatJudgeVerdictConsole(judgeVerdict));

  console.log(`  🌐 宏观阶段: ${formatMacroRegimeLine(macroRegime)}`);

  const priceHistory = priceRepo.getRecent(800);
  // 读取最近报告的长期档，用于平滑防日度乱翻
  let previousOutlook: import('../types/analysis.js').LongTermOutlook | null = null;
  try {
    for (const row of reportsRepo.getRecent(21)) {
      if (row.date >= today) continue;
      const prev = parseReportJson(row.reportJson);
      if (prev?.longTermOutlook?.horizons?.length === 3) {
        previousOutlook = prev.longTermOutlook;
        break;
      }
    }
  } catch { /* ignore */ }

  const longTermOutlook = buildLongTermOutlook({
    technical: report.technical,
    fundamental: report.fundamental,
    sentiment: report.sentiment,
    rebuttal: report.rebuttal,
    overallScore: report.overall.score,
    overallDirection: report.overall.direction,
    macroRegime,
    priceHistory,
    previousOutlook,
  });
  report.longTermOutlook = longTermOutlook;
  report.macroRegime = macroRegime;
  report.causalChains = causalChains;

  // 中期方向（1～3 个月）：补上短期 5 日与长期 1/3/5 年之间的断档
  let previousMidTerm: MidTermOutlook | null = null;
  try {
    for (const row of reportsRepo.getRecent(21)) {
      if (row.date >= today) continue;
      const prev = parseReportJson(row.reportJson);
      if (prev?.midTermOutlook?.horizons?.length) {
        previousMidTerm = prev.midTermOutlook;
        break;
      }
    }
  } catch { /* ignore */ }

  const midTermOutlook = buildMidTermOutlook({
    closes: forwardFillCloses(priceHistory),
    dxy: pickMacroSeries(priceHistory, r => r.dollarIndex).values,
    tips: pickMacroSeries(priceHistory, r => r.tipsYield).values,
    cftcNetPercentile: flowSignal?.cftc?.percentile ?? null,
    flowSignal: flowSignal ?? undefined,
    macroRegime,
    previous: previousMidTerm,
  });
  report.midTermOutlook = midTermOutlook;

  // 当前仓位推荐（相对计划黄金仓 · 风险约束 v2：波动/回撤/日平滑）
  const primaryHorizon = longTermOutlook?.horizons?.find(h => h.years === 3)
    ?? longTermOutlook?.horizons?.[0];
  const closesForRisk = forwardFillCloses(priceHistory);
  let previousTargetPct: number | null = null;
  try {
    for (const row of reportsRepo.getRecent(21)) {
      if (row.date >= today) continue;
      const prev = parseReportJson(row.reportJson);
      if (!prev) continue;
      previousTargetPct = extractPreviousTargetPct(prev)
        ?? (typeof prev.overall?.positionTargetPct === 'number' ? prev.overall.positionTargetPct : null);
      if (previousTargetPct != null) break;
    }
  } catch { /* ignore */ }
  const positionRec = recommendPosition({
    llmScore: report.overall.score,
    quantScore: report.overall.quantScore ?? null,
    dataActionable: dataQualityGate.actionable,
    dualPolicy: dualVerdict.actionPolicy,
    flowScore: flowSignal?.overallScore ?? null,
    longTermStance: primaryHorizon?.allocationStance ?? null,
    consistencyLevel: dimConsistency.level,
    direction: report.overall.direction,
    closes: closesForRisk,
    previousTargetPct,
  });
  report.overall.positionTargetPct = positionRec.targetPct;
  // 双分冲突：仓位结论与 actionOverride / 策略风险提示共用同一套文案
  if (dataQualityGate.actionable && dualVerdict.actionOverride) {
    alignDualOverrideWithPosition(dualVerdict, positionRec);
    applyDualHoldOverlay(report, dualVerdict);
  }
  console.log(formatPositionConsole(positionRec));

  // 历史预测对错统计 → docs/goldrush-stats-latest.json（Web 首页/文章页）
  let predictionTrack: PredictionTrackStats | null = null;
  try {
    predictionTrack = buildPredictionTrackStats(db, 90, 5);
    const statsPath = savePredictionTrackJson(predictionTrack);
    console.log(formatPredictionTrackConsole(predictionTrack));
    console.log(`  💾 预测对错统计已写入: ${statsPath}`);
  } catch (err) {
    console.warn('  ⚠️ 预测对错统计失败:', err instanceof Error ? err.message : err);
  }

  // 较昨日差分 + 驱动归因
  let previousReport: GoldAnalysisReport | null = null;
  let prevDate = '';
  try {
    for (const row of reportsRepo.getRecent(21)) {
      if (row.date >= today) continue;
      previousReport = parseReportJson(row.reportJson);
      if (previousReport) {
        prevDate = row.date;
        break;
      }
    }
  } catch { /* ignore */ }
  const currPriceRow = priceRepo.getByDate(today) ?? priceHistory[0] ?? null;
  const prevPriceRow = prevDate ? (priceRepo.getByDate(prevDate) ?? null) : null;
  const prevFlow = previousReport?.overall?.quantFactors?.flow?.normalizedScore ?? null;
  const currFlow = flowSignal?.overallScore
    ?? report.overall.quantFactors?.flow?.normalizedScore
    ?? null;
  const dayDelta = buildDayDelta({
    prevDate,
    currDate: today,
    previous: previousReport,
    current: report,
    currPositionPct: positionRec.targetPct,
    dual: dualVerdict,
    prevPrice: prevPriceRow,
    currPrice: currPriceRow,
    prevFlowScore: prevFlow,
    currFlowScore: currFlow,
    llmHitRate: predictionTrack?.llm.hitRate ?? null,
    quantHitRate: predictionTrack?.quant.hitRate ?? null,
  });
  console.log(formatDayDeltaConsole(dayDelta));

  // 可信度一览：门禁+双分+一致+校准+滚动命中 → 评分区间 + TL;DR
  const calCtx = report.overall.calibration;
  const reliabilityCard = buildReliabilityCard({
    llmScore: report.overall.score,
    direction: report.overall.direction,
    quantScore: report.overall.quantScore ?? null,
    dataGate: dataQualityGate,
    dual: dualVerdict,
    consistency: dimConsistency,
    calibrationSampleSize: calCtx?.sampleSize ?? null,
    calibrationBias: calCtx?.systematicBias ?? null,
    position: positionRec,
    trackHitRate: predictionTrack?.llm.hitRate ?? null,
    trackSampleSize: predictionTrack?.llm.total ?? null,
    dayDelta,
  });
  console.log(formatReliabilityConsole(reliabilityCard));

  const tipsDelta =
    prevPriceRow?.tipsYield != null && currPriceRow?.tipsYield != null
      ? currPriceRow.tipsYield - prevPriceRow.tipsYield
      : null;
  const transmission = buildEventGoldTransmission({
    marketData: report.marketData,
    sentiment: report.sentiment,
    macroRegime,
    tailRisks: report.tailRisks ?? report.rebuttal?.tailRisks,
    causalChains,
    tipsDelta,
  });
  console.log(formatTransmissionConsole(transmission));

  let reflectOneLiner: string | null = null;
  try {
    const prevReflect = loadPreviousReflect();
    if (prevReflect?.headline) reflectOneLiner = prevReflect.headline;
  } catch { /* ignore */ }
  const readingChecklist = buildReadingChecklist({
    reliability: reliabilityCard,
    position: positionRec,
    dayDelta,
    dual: dualVerdict,
    dataGate: dataQualityGate,
    transmission,
    reflectOneLiner,
  });
  console.log(formatReadingChecklistConsole(readingChecklist));

  let similarPatterns: PatternMatch[] = preSimilar;
  if (similarPatterns.length > 0) {
    console.log('  📜 历史相似日（已回填 5 日收益）:');
    for (const p of similarPatterns.slice(0, 3)) {
      const ret = p.actual5dReturn != null ? `${p.actual5dReturn > 0 ? '+' : ''}${p.actual5dReturn.toFixed(2)}%` : 'N/A';
      console.log(`     ${p.date} 相似度 ${(p.similarity * 100).toFixed(0)}% → 5日后 ${ret}（当时 ${p.score} 分）`);
    }
  } else {
    console.log('  📜 历史相似日: 样本不足（需更多已回填的 scenario_features）');
  }

  const manifest = buildRunManifest({
    horizon: options.horizon,
    startedAt,
    report,
    scoreBreakdown,
    macroRegime,
    judgeVerdict,
    similarPatterns,
    longTermOutlook: report.longTermOutlook,
  });
  const manifestPath = saveRunManifest(manifest);
  console.log(`  📦 审计包已保存: ${manifestPath}`);

  // 回写富化后的报告：orchestrator 在 LLM 合成后就落库，此时长期/中期展望、
  // 仓位、门禁覆盖尚未产出，不回写会让 history / diff / calibrate 读到半成品
  if (report.reportRowId != null) {
    try {
      reportsRepo.updateFinal(report.reportRowId, {
        reportJson: JSON.stringify(report),
        midTermScore: midTermOutlook?.score ?? null,
      });
    } catch { /* 落库失败不应中断报告输出 */ }
  }

  const reportExtras = {
    macroRegime,
    judgeVerdict,
    similarPatterns,
    scoreBreakdown,
    longTermOutlook,
    midTermOutlook,
    dataQualityGate,
    dualVerdict,
    positionRec,
    predictionTrack: predictionTrack ?? undefined,
    reliabilityCard,
    consistency: dimConsistency,
    dayDelta,
    transmission,
    readingChecklist,
  };

  // 输出报告
  if (options.json) {
    if (options.jsonLegacy) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(JSON.stringify(wrapAnalysisOutputV1(manifest, report), null, 2));
    }
  } else {
    printReport(report, options.horizon, scoreBreakdown, reportExtras);
  }

  // 保存到文件 (JSON schema v1)
  if (options.save) {
    const filename = `goldrush-analysis-${new Date().toISOString().slice(0, 10)}.json`;
    const fs = await import('node:fs');
    fs.writeFileSync(filename, JSON.stringify(wrapAnalysisOutputV1(manifest, report), null, 2), 'utf-8');
    console.log(`\n💾 报告已保存到 ${filename}（schema v1）`);
  }

  // 保存为 Markdown 格式
  if (options.md) {
    const fs = await import('node:fs');
    const docsDir = 'docs';
    if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
    const filename = `${docsDir}/goldrush-analysis-${new Date().toISOString().slice(0, 10)}.md`;
    const asOf = report.timestamp.slice(0, 10);
    const attached = attachProbPath({
      db: getDb(),
      asOf,
      score: report.overall.score,
      docsDir,
      dataQualityGate,
    });
    const mdContent = formatReportMarkdown(report, options.horizon, {
      ...reportExtras,
      dataQualityGate,
      dualVerdict,
      probPath: attached?.meta ?? null,
      probPathSvgs: attached ? { svg5: attached.svg5, svg20: attached.svg20 } : undefined,
    });
    fs.writeFileSync(filename, mdContent, 'utf-8');
    const meta = buildReportMeta({
      report,
      dualVerdict,
      dataQualityGate,
      positionRec,
      reliabilityCard,
      probPath: attached?.meta ?? null,
    });
    const metaPath = saveReportMeta(filename, meta);
    console.log(`\n📝 报告已保存为 Markdown: ${filename}`);
    console.log(`   结构化 sidecar: ${metaPath}`);
    if (attached?.meta) {
      console.log(`   概率路径: n=${attached.meta.sampleSize} (${attached.meta.degraded})`);
    }
  }

  // 清理
  await collector.cleanup();
  await validator.cleanup();
  await rebuttalAgent.cleanup();
  await orchestrator.cleanup();
  return 0;
}

/** Smart 平稳日：复用上一报告，返回 null 表示需转完整分析 */
async function runSmartAnalysis(
  options: {
    horizon: Horizon;
    json: boolean;
    jsonLegacy: boolean;
    save: boolean;
    md: boolean;
  },
  gate: import('../utils/analysis-gate.js').AnalysisGateResult,
  priceRepo: GoldPricesRepo,
  startedAt: string,
): Promise<number | null> {
  const db = getDb();
  const reportsRepo = new ReportsRepo(db);
  const today = todayDate();
  const prevRow = reportsRepo.getRecent(14).find(r => r.date < today);
  if (!prevRow) return null;

  const previous = parseReportJson(prevRow.reportJson);
  if (!previous) return null;

  let goldDeviation: number | null = null;
  try {
    goldDeviation = latestDeviationFromMA(forwardFillCloses(priceRepo.getRecent(60)), 20);
  } catch { /* ignore */ }

  const macroRegime = detectMacroRegime(previous.marketData, goldDeviation);
  const report = buildSmartReport(previous, macroRegime, gate, prevRow.date);
  report.macroRegime = macroRegime;

  const scoreBreakdown = buildScoreBreakdown(
    report.technical,
    report.fundamental,
    report.sentiment,
    report.rebuttal,
  );
  const judgeVerdict = buildJudgeVerdict(
    report.technical,
    report.fundamental,
    report.sentiment,
    report.rebuttal,
    scoreBreakdown,
  );

  // Smart 也补齐：门禁 / 双分 / 一致性 / 仓位 / 可信度 / 预测对错（零 LLM，本地规则）
  const conf = report.dataQuality?.overallConfidence ?? 70;
  const dataQualityGate = evaluateDataQualityGate({
    marketData: report.marketData,
    overallConfidence: conf,
    warnings: report.dataQuality?.warnings ?? [],
  });
  const dimConsistency = checkConsistency([
    { name: '技术面', score: report.technical.score },
    { name: '基本面', score: report.fundamental.score },
    { name: '情绪面', score: report.sentiment.score },
    {
      name: '基金面',
      score: report.fund?.valuation?.level === 'low' ? 70
        : report.fund?.valuation?.level === 'high' ? 25 : 50,
    },
  ]);
  const dualVerdict = evaluateDualScore(
    report.overall.score,
    report.overall.quantScore,
    {
      consistencyWeak: dimConsistency.level === 'weak',
      dataActionable: dataQualityGate.actionable,
    },
  );
  if (!dataQualityGate.actionable) {
    applyNonActionableOverlay(report, dataQualityGate);
  }

  // 中期档纯本地慢变量，Smart 路径同样可以算，不必等完整 LLM 分析
  const smartHistory = priceRepo.getRecent(800);
  report.midTermOutlook = buildMidTermOutlook({
    closes: forwardFillCloses(smartHistory),
    dxy: pickMacroSeries(smartHistory, r => r.dollarIndex).values,
    tips: pickMacroSeries(smartHistory, r => r.tipsYield).values,
    previous: previous.midTermOutlook ?? null,
  });

  const primaryHorizon = report.longTermOutlook?.horizons?.find(h => h.years === 3)
    ?? report.longTermOutlook?.horizons?.[0];
  const closesForRisk = forwardFillCloses(priceRepo.getRecent(120));
  const previousTargetPct = extractPreviousTargetPct(previous)
    ?? (typeof previous.overall?.positionTargetPct === 'number' ? previous.overall.positionTargetPct : null);
  const positionRec = recommendPosition({
    llmScore: report.overall.score,
    quantScore: report.overall.quantScore ?? null,
    dataActionable: dataQualityGate.actionable,
    dualPolicy: dualVerdict.actionPolicy,
    flowScore: null,
    longTermStance: primaryHorizon?.allocationStance ?? null,
    consistencyLevel: dimConsistency.level,
    direction: report.overall.direction,
    closes: closesForRisk,
    previousTargetPct,
  });
  report.overall.positionTargetPct = positionRec.targetPct;
  if (dataQualityGate.actionable && dualVerdict.actionOverride) {
    alignDualOverrideWithPosition(dualVerdict, positionRec);
    applyDualHoldOverlay(report, dualVerdict);
  }

  let predictionTrack: PredictionTrackStats | null = null;
  try {
    predictionTrack = buildPredictionTrackStats(db, 90, 5);
    savePredictionTrackJson(predictionTrack);
  } catch (err) {
    console.warn('  ⚠️ Smart 预测对错统计失败:', err instanceof Error ? err.message : err);
  }

  const currPriceRow = priceRepo.getByDate(today) ?? null;
  const prevPriceRow = priceRepo.getByDate(prevRow.date) ?? null;
  const dayDelta = buildDayDelta({
    prevDate: prevRow.date,
    currDate: today,
    previous,
    current: report,
    currPositionPct: positionRec.targetPct,
    dual: dualVerdict,
    prevPrice: prevPriceRow,
    currPrice: currPriceRow,
    prevFlowScore: previous.overall?.quantFactors?.flow?.normalizedScore ?? null,
    currFlowScore: report.overall.quantFactors?.flow?.normalizedScore ?? null,
    llmHitRate: predictionTrack?.llm.hitRate ?? null,
    quantHitRate: predictionTrack?.quant.hitRate ?? null,
  });
  console.log(formatDayDeltaConsole(dayDelta));

  const calCtx = report.overall.calibration;
  const reliabilityCard = buildReliabilityCard({
    llmScore: report.overall.score,
    direction: report.overall.direction,
    quantScore: report.overall.quantScore ?? null,
    dataGate: dataQualityGate,
    dual: dualVerdict,
    consistency: dimConsistency,
    calibrationSampleSize: calCtx?.sampleSize ?? null,
    calibrationBias: calCtx?.systematicBias ?? null,
    position: positionRec,
    trackHitRate: predictionTrack?.llm.hitRate ?? null,
    trackSampleSize: predictionTrack?.llm.total ?? null,
    dayDelta,
  });

  const tipsDeltaSmart =
    prevPriceRow?.tipsYield != null && currPriceRow?.tipsYield != null
      ? currPriceRow.tipsYield - prevPriceRow.tipsYield
      : null;
  const transmission = buildEventGoldTransmission({
    marketData: report.marketData,
    sentiment: report.sentiment,
    macroRegime,
    tailRisks: report.tailRisks ?? report.rebuttal?.tailRisks,
    causalChains: report.causalChains,
    tipsDelta: tipsDeltaSmart,
  });
  console.log(formatTransmissionConsole(transmission));

  let reflectOneLiner: string | null = null;
  try {
    const prevReflect = loadPreviousReflect();
    if (prevReflect?.headline) reflectOneLiner = prevReflect.headline;
  } catch { /* ignore */ }
  const readingChecklist = buildReadingChecklist({
    reliability: reliabilityCard,
    position: positionRec,
    dayDelta,
    dual: dualVerdict,
    dataGate: dataQualityGate,
    transmission,
    reflectOneLiner,
  });
  console.log(formatReadingChecklistConsole(readingChecklist));

  const reportExtras = {
    macroRegime,
    judgeVerdict,
    scoreBreakdown,
    longTermOutlook: report.longTermOutlook,
    midTermOutlook: report.midTermOutlook,
    dataQualityGate,
    dualVerdict,
    positionRec,
    predictionTrack: predictionTrack ?? undefined,
    reliabilityCard,
    consistency: dimConsistency,
    dayDelta,
    transmission,
    readingChecklist,
  };

  reportsRepo.insert({
    date: today,
    horizon: options.horizon,
    reportJson: JSON.stringify(report),
    overallScore: report.overall.score,
    quantScore: report.overall.quantScore ?? null,
    midTermScore: report.midTermOutlook?.score ?? null,
    direction: report.overall.direction,
  });

  const manifest = buildRunManifest({
    horizon: options.horizon,
    startedAt,
    report,
    scoreBreakdown,
    macroRegime,
    judgeVerdict,
    similarPatterns: [],
    longTermOutlook: report.longTermOutlook,
  });

  console.log('  ✅ Smart 简版报告已生成（零 LLM，已补仓位/可信度/对错统计）');
  console.log(formatReliabilityConsole(reliabilityCard));
  console.log(formatPositionConsole(positionRec));

  if (options.json) {
    console.log(JSON.stringify(wrapAnalysisOutputV1(manifest, report), null, 2));
  } else {
    printReport(report, options.horizon, scoreBreakdown, reportExtras);
  }

  if (options.save) {
    const fs = await import('node:fs');
    const filename = `goldrush-analysis-${today}.json`;
    fs.writeFileSync(filename, JSON.stringify(wrapAnalysisOutputV1(manifest, report), null, 2), 'utf-8');
    console.log(`\n💾 报告已保存到 ${filename}`);
  }

  if (options.md) {
    const fs = await import('node:fs');
    const docsDir = 'docs';
    if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
    const filename = `${docsDir}/goldrush-analysis-${today}.md`;
    const attached = attachProbPath({
      db,
      asOf: today,
      score: report.overall.score,
      docsDir,
      dataQualityGate,
    });
    fs.writeFileSync(
      filename,
      formatReportMarkdown(report, options.horizon, {
        ...reportExtras,
        probPath: attached?.meta ?? null,
        probPathSvgs: attached ? { svg5: attached.svg5, svg20: attached.svg20 } : undefined,
      }),
      'utf-8',
    );
    const meta = buildReportMeta({
      report,
      dualVerdict,
      dataQualityGate,
      positionRec,
      reliabilityCard,
      probPath: attached?.meta ?? null,
    });
    const metaPath = saveReportMeta(filename, meta);
    console.log(`\n📝 报告已保存为 Markdown: ${filename}`);
    console.log(`   结构化 sidecar: ${metaPath}`);
    if (attached?.meta) {
      console.log(`   概率路径: n=${attached.meta.sampleSize} (${attached.meta.degraded})`);
    }
  }

  return 0;
}

/** 红档：覆盖短中期操作文案 */
function applyNonActionableOverlay(report: GoldAnalysisReport, gate: DataQualityGate): void {
  const na = nonActionableAdvice();
  if (report.overall?.shortTerm) {
    report.overall.shortTerm.action = na.action;
    report.overall.shortTerm.riskWarning = `${na.headline}；原因：${gate.reasons.join('；')}`;
  }
  if (report.overall?.midTerm) {
    report.overall.midTerm.investAdvice = {
      ...report.overall.midTerm.investAdvice,
      dipInvest: 'pause',
      positionAdjust: 'hold',
      recommendedFund: report.overall.midTerm.investAdvice?.recommendedFund ?? 'N/A',
    };
    report.overall.midTerm.riskWarning = `${na.headline}；原因：${gate.reasons.join('；')}`;
  }
}

/** 双打分冲突：与仓位结论对齐后的覆盖（维持定投，不站队） */
function applyDualHoldOverlay(report: GoldAnalysisReport, dual: DualScoreVerdict): void {
  const ov = dual.actionOverride;
  if (!ov) return;
  if (report.overall?.shortTerm) {
    report.overall.shortTerm.action = ov.action;
    report.overall.shortTerm.riskWarning = ov.headline;
  }
  if (report.overall?.midTerm) {
    report.overall.midTerm.investAdvice = {
      ...report.overall.midTerm.investAdvice,
      dipInvest: 'continue',
      positionAdjust: 'hold',
      recommendedFund: report.overall.midTerm.investAdvice?.recommendedFund ?? 'N/A',
    };
    report.overall.midTerm.riskWarning = ov.headline;
  }
}

function printReport(
  report: GoldAnalysisReport,
  horizon: Horizon,
  scoreBreakdown?: ReturnType<typeof buildScoreBreakdown>,
  extras?: {
    macroRegime?: import('../utils/macro-regime.js').MacroRegime;
    judgeVerdict?: import('../utils/judge-verdict.js').JudgeVerdict;
    similarPatterns?: PatternMatch[];
    longTermOutlook?: import('../types/analysis.js').LongTermOutlook;
    midTermOutlook?: MidTermOutlook;
    dataQualityGate?: DataQualityGate;
    dualVerdict?: DualScoreVerdict;
    positionRec?: PositionRecommendation;
    predictionTrack?: PredictionTrackStats;
    reliabilityCard?: ReliabilityCard;
    dayDelta?: DayDelta;
  },
): void {
  const { overall, technical, fundamental, sentiment, fund: fundAnalysis, rebuttal, tailRisks } = report;

  console.log(header('🎯 GoldRush 综合分析报告', formatNow()));

  if (extras?.dayDelta) {
    console.log('\n' + formatDayDeltaConsole(extras.dayDelta));
  }
  if (extras?.reliabilityCard) {
    console.log('\n' + formatReliabilityConsole(extras.reliabilityCard));
  }
  if (extras?.dataQualityGate) {
    console.log('\n' + formatDataQualityGateConsole(extras.dataQualityGate));
  }
  if (extras?.dualVerdict) {
    console.log('\n' + formatDualScoreConsole(extras.dualVerdict));
  }
  if (extras?.positionRec) {
    console.log('\n' + formatPositionConsole(extras.positionRec));
  }
  if (extras?.predictionTrack) {
    console.log('\n' + formatPredictionTrackConsole(extras.predictionTrack));
  }

  const bd = scoreBreakdown ?? buildScoreBreakdown(technical, fundamental, sentiment, rebuttal);
  console.log('\n' + formatScoreBreakdownConsole(bd, '  '));

  if (extras?.macroRegime) {
    console.log(`\n  🌐 宏观阶段: ${formatMacroRegimeLine(extras.macroRegime)}`);
  }
  if (report.causalChains?.length) {
    console.log('\n' + formatCausalChainsConsole(report.causalChains, '  '));
  }
  if (extras?.judgeVerdict) {
    console.log('\n' + formatJudgeVerdictConsole(extras.judgeVerdict, '  '));
  }
  if (extras?.similarPatterns && extras.similarPatterns.length > 0) {
    console.log(`\n  📜 历史相似日（Top ${Math.min(3, extras.similarPatterns.length)}）`);
    for (const p of extras.similarPatterns.slice(0, 3)) {
      const ret = p.actual5dReturn != null ? `${p.actual5dReturn > 0 ? '+' : ''}${p.actual5dReturn.toFixed(2)}%` : '待回填';
      console.log(`  · ${p.date} 相似 ${(p.similarity * 100).toFixed(0)}% | 5日后 ${ret} | 当时评分 ${p.score}`);
    }
  }

  if (extras?.midTermOutlook) {
    console.log('\n' + formatMidTermOutlookConsole(extras.midTermOutlook));
  }

  if (extras?.longTermOutlook) {
    console.log('\n' + formatLongTermOutlookConsole(extras.longTermOutlook));
  }

  // 综合研判 + 统一操作建议（resolveOperationalAdvice 单一出口）
  const scoreDisplay = overall?.score ?? 'N/A';
  const directionDisplay = overall?.direction ?? 'neutral';
  const gate = extras?.dataQualityGate;
  const dual = extras?.dualVerdict;
  const advice = resolveOperationalAdvice({
    llmScore: overall?.score,
    direction: overall?.direction,
    dataActionable: gate?.actionable,
    dualActionOverride: dual?.actionOverride ?? null,
    dualPolicy: dual?.actionPolicy ?? null,
    position: extras?.positionRec
      ? {
          headline: extras.positionRec.headline,
          action: extras.positionRec.action,
          emoji: extras.positionRec.emoji,
          label: extras.positionRec.label,
          tilt: extras.positionRec.tilt,
          targetPct: extras.positionRec.targetPct,
        }
      : null,
  });
  console.log(`\n  综合研判(LLM): ${directionMark(directionDisplay)} ${scoreDisplay}/100`);
  if (overall?.score) {
    console.log(`  ${scoreBar(overall.score)}`);
  }
  // 双打分：始终并排
  if (overall?.quantScore != null) {
    const delta = overall.score - overall.quantScore;
    const deltaStr = delta > 0 ? `LLM偏高 +${delta}` : delta < 0 ? `LLM偏低 ${delta}` : '一致';
    const quantDir = directionFromScore(overall.quantScore);
    console.log(`  🔢 量化评分: ${scoreBar(overall.quantScore)}`);
    console.log(`     量化=${overall.quantScore} ${directionMark(quantDir)} | LLM=${overall.score} | 偏差=${deltaStr} | 策略=${dual?.actionPolicy ?? 'n/a'}`);
    if (overall.quantFactors) {
      console.log(formatQuantScoreConsole({
        score: overall.quantScore,
        direction: quantDir,
        factors: overall.quantFactors,
        coverage: overall.quantCoverage ?? 1,
        missingFactors: overall.quantMissingFactors ?? [],
        staleFactors: overall.quantStaleFactors ?? [],
      }, '  '));
    }
  }
  if (advice) {
    console.log(`  💡 ${advice.emoji} ${advice.action}`);
    console.log(`     [${advice.source}] ${advice.headline}`);
    if (advice.source === 'data_gate') {
      console.log(chalk.red(`  ⛔ ${advice.headline}`));
    } else if (advice.source === 'dual_conflict') {
      console.log(chalk.yellow(`  ⚖️ ${advice.headline}`));
    }
  }

  // 四维度一致性检查
  const consistency = checkConsistency([
    { name: '技术面', score: technical.score },
    { name: '基本面', score: fundamental.score },
    { name: '情绪面', score: sentiment.score },
    { name: '基金面', score: fundAnalysis.valuation?.level === 'low' ? 70 : fundAnalysis.valuation?.level === 'high' ? 25 : 50 },
  ]);
  console.log(`  📊  ${consistencyEmoji(consistency.level)} 维度一致性: ${consistency.summary}`);

  // 校准上下文（评分区间 + 可信度）
  if (overall?.calibration?.historicalAccuracy != null) {
    const cal = overall.calibration;
    const pct5 = Math.round(cal.historicalAccuracy! * 100);
    const pct20 = cal.historicalAccuracy20d != null ? Math.round(cal.historicalAccuracy20d * 100) : null;
    const t20 = pct20 != null ? `，20日${pct20}%` : '';
    const sampleNote = (cal.sampleSize ?? 0) < 5
      ? chalk.yellow(` ⚠️ 样本仅${cal.sampleSize}次，仅供参考`)
      : (cal.sampleSize ?? 0) < 20
        ? chalk.yellow(` (样本${cal.sampleSize}次，波动较大)`)
        : '';
    console.log(`  📊 校准: ${cal.scoreRange}区间 5日涨概率${pct5}%${t20} (${cal.systematicBias})${sampleNote}`);
    if (cal.calibrationApplied && cal.calibrationOffset != null && cal.calibrationOffset !== 0) {
      console.log(`  📐 数值校准: 反驳后${cal.rawScore}分 → 偏移${cal.calibrationOffset > 0 ? '+' : ''}${cal.calibrationOffset} → 展示${overall.score}分`);
    }
  } else if (overall?.score) {
    console.log(`  📊 校准: 样本积累中（需≥5次），评分仅供参考`);
  }

  // 情景分析
  console.log(`\n  ⚡ 情景分析`);
  const scenarios = overall?.scenarios;
  if (scenarios) {
    const { base, upside, downside } = scenarios;
    console.log(`  基准 (${base.probability}%): ${base.description} → ${base.action}`);
    console.log(`  上行 (${upside.probability}%): ${upside.description} (触发: ${upside.trigger})`);
    console.log(`  下行 (${downside.probability}%): ${downside.description} (触发: ${downside.trigger})`);
  } else {
    console.log(`  (情景数据暂不可用)`);
  };

  // 四维度摘要
  console.log(`\n  📈 四维度摘要`);
  console.log(`  技术面: ${technical.score}/100 ${directionMark(technical.direction)} — ${technical.summary}`);
  console.log(`  基本面: ${fundamental.score}/100 ${directionMark(fundamental.direction)} — ${fundamental.summary}`);
  console.log(`  情绪面: ${sentiment.score}/100 ${directionMark(sentiment.direction)} — ${sentiment.summary}`);
  console.log(`  基金面: 估值${valuationMark(fundAnalysis.valuation.level)}`);

  // 反驳摘要
  console.log(`\n  🔴 强制反驳摘要`);
  console.log(`  反驳强度: ${rebuttal.rebuttalStrength} | 看空力度: ${rebuttal.bearScore}/100`);
  for (const point of (rebuttal.bearPoints ?? []).slice(0, 3)) {
    console.log(`  · ${point.point} (${point.probability}%概率)`);
  }
  for (const vul of (rebuttal.bullVulnerabilities ?? []).slice(0, 2)) {
    console.log(`  · 看多漏洞: ${vul.vulnerability}`);
  }
  if (rebuttal.adjustedScore) {
    console.log(`  → 详见上方「评分构成」明细`);
  }

  // 双轨策略
  if (horizon !== 'mid' && overall?.shortTerm) {
    console.log(`\n  ⏱️ 短期策略 (日线级别)`);
    console.log(`  操作: ${overall.shortTerm.action ?? 'N/A'}`);
    console.log(`  入场: ${overall.shortTerm.entryZone ?? 'N/A'}`);
    console.log(`  目标: ${overall.shortTerm.target ?? 'N/A'}`);
    console.log(`  止损: ${overall.shortTerm.stopLoss ?? 'N/A'}`);
    console.log(`  品种: ${overall.shortTerm.recommendedProduct ?? 'N/A'}`);
    console.log(`  ⚠️ ${overall.shortTerm.riskWarning ?? 'N/A'}`);
  }

  if (horizon !== 'short' && overall?.midTerm) {
    console.log(`\n  📅 中长期策略 (周线级别)`);
    const mid = overall.midTerm;
    console.log(`  定投: ${mid.investAdvice?.dipInvest === 'increase' ? '加码' : mid.investAdvice?.dipInvest === 'pause' ? '暂停' : '继续'}`);
    console.log(`  仓位: ${mid.investAdvice?.positionAdjust === 'add' ? '加仓' : mid.investAdvice?.positionAdjust === 'reduce' ? '减仓' : '维持'}`);
    console.log(`  推荐基金: ${mid.investAdvice?.recommendedFund ?? 'N/A'}`);
    console.log(`  支撑区: ${mid.keyLevels?.supportZone ?? 'N/A'}`);
    console.log(`  阻力区: ${mid.keyLevels?.resistanceZone ?? 'N/A'}`);
    console.log(`  ⚠️ ${mid.riskWarning ?? 'N/A'}`);
  }

  // 尾部风险
  const tailRiskList = tailRisks ?? [];
  if (tailRiskList.length > 0) {
    console.log(`\n  ⚠️ 尾部风险`);
    for (const risk of tailRiskList) {
      console.log(`  ${risk.probability}% → ${risk.risk}: ${risk.impact} (触发: ${risk.trigger})`);
      console.log(`    对冲: ${risk.mitigation}`);
    }

    // 尾部风险指数（互斥修正，避免虚高）
    const maxCap = getConfig().investment.maxTailRiskIndex * 2.5;
    const { index, rawUnion } = computeTailRiskIndex(tailRiskList, maxCap);
    console.log(`  综合尾部风险指数: ${index.toFixed(1)}%`);
    if (rawUnion - index > 5) {
      console.log(`  （朴素并概率 ${rawUnion.toFixed(1)}%，已做互斥修正）`);
    }
  }

  console.log(separator('═', 55));
}

/** 渲染报告为 Markdown 格式 */
// 委托 report-md.ts 中的规范渲染函数，消除重复实现
const renderReportMarkdown = formatReportMarkdown;
