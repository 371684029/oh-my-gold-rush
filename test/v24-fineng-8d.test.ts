import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  HORIZON_8D_WEIGHTS,
  DIMENSION_METRIC_OWNERSHIP,
  computeHorizonEightDimensionScore,
  makeDimensionItem,
  type DimensionKey,
  type ForecastHorizonKey,
  type EightDimensionProfile,
} from '../src/utils/eight-dimensions.js';
import {
  computePathMaxDrawdown,
  mixSampleWeights,
  scaleCumPctPathLogFhs,
  causalMeanLogReturn,
} from '../src/utils/fhs-math.js';
import { computeCapitalFlowDimension } from '../src/indicators/capital-flow.js';
import { computePolicyCycleDimension } from '../src/indicators/policy-cycle.js';
import { computeBehavioralSentimentDimension } from '../src/indicators/behavioral-sentiment.js';
import { computePositioningChipDimension } from '../src/indicators/positioning-chip.js';
import { computeRebuttalAdjustment } from '../src/utils/rebuttal-score.js';
import { wilsonInterval, wilsonIntervalHac, effectiveSampleSizeOverlap } from '../src/utils/decision-thresholds.js';
import { buildPaperEquity, DEFAULT_REALISTIC_BACKTEST_OPTIONS } from '../src/utils/paper-equity.js';
import { buildLongTermOutlook } from '../src/utils/long-term-outlook.js';
import { buildReportMeta } from '../src/utils/report-meta.js';
import { formatReportMarkdown } from '../src/utils/report-md.js';
import type {
  GoldAnalysisReport,
  TechnicalAnalysis,
  FundamentalAnalysis,
  SentimentAnalysis,
  RebuttalAnalysis,
} from '../src/types/analysis.js';

const require = createRequire(import.meta.url);

describe('GoldRush v2.4 — 八维正交体系（三基 + 五专）与 18 项金融工程修正', () => {
  it('1. 静态指标归属表实现 100% 零跨维重复计分', () => {
    const seen = new Map<string, DimensionKey>();
    for (const [dim, metrics] of Object.entries(DIMENSION_METRIC_OWNERSHIP) as Array<[DimensionKey, readonly string[]]>) {
      expect(metrics.length).toBeGreaterThanOrEqual(3);
      for (const m of metrics) {
        expect(seen.has(m), `指标 ${m} 同时出现在 ${seen.get(m)} 与 ${dim}`).toBe(false);
        seen.set(m, dim);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(30);
  });

  it('2. 多时间尺度八维动态权重矩阵：每行合计 1.00，且 60D/1Y/2Y/5Y 严格隔离消息面与情绪面 (0%)', () => {
    const horizons: ForecastHorizonKey[] = ['5d', '20d', '60d', '1y', '2y', '5y'];
    for (const h of horizons) {
      const w = HORIZON_8D_WEIGHTS[h];
      const sum = Object.values(w).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 6);
    }

    for (const longH of ['60d', '1y', '2y', '5y'] as const) {
      expect(HORIZON_8D_WEIGHTS[longH].news).toBe(0);
      expect(HORIZON_8D_WEIGHTS[longH].sentiment).toBe(0);
    }
    expect(HORIZON_8D_WEIGHTS['5d'].news).toBeGreaterThan(0);
    expect(HORIZON_8D_WEIGHTS['5d'].sentiment).toBeGreaterThan(0);
    expect(HORIZON_8D_WEIGHTS['5y'].fundamental + HORIZON_8D_WEIGHTS['5y'].policy).toBeGreaterThanOrEqual(0.55);
  });

  it('3. 八维合成支持缺数自动剔除重归一，且覆盖度 < 70% 时触发降级警告', () => {
    const fullProfile: EightDimensionProfile = {
      fundamental: makeDimensionItem('fundamental', { score: 70, coverage: 1 }),
      news: makeDimensionItem('news', { score: 20, coverage: 1 }), // 5y 中必须被 0% 忽略
      technical: makeDimensionItem('technical', { score: 60, coverage: 1 }),
      capitalFlow: makeDimensionItem('capitalFlow', { score: 65, coverage: 1 }),
      policy: makeDimensionItem('policy', { score: 75, coverage: 1 }),
      sentiment: makeDimensionItem('sentiment', { score: 15, coverage: 1 }), // 5y 中必须被 0% 忽略
      positioning: makeDimensionItem('positioning', { score: 55, coverage: 1 }),
      quantitative: makeDimensionItem('quantitative', { score: 62, coverage: 1 }),
    };

    const res5y = computeHorizonEightDimensionScore(fullProfile, '5y');
    expect(res5y.coverage).toBeCloseTo(1, 4);
    expect(res5y.degradedWarning).toBeNull();
    // 5y 即使 news=20/sentiment=15 也不受任何影响
    const res5yExtreme = computeHorizonEightDimensionScore(
      { ...fullProfile, news: makeDimensionItem('news', { score: 99, coverage: 1 }), sentiment: makeDimensionItem('sentiment', { score: 99, coverage: 1 }) },
      '5y',
    );
    expect(res5yExtreme.score).toBe(res5y.score);

    // 剔除基本面(35%)与政策面(25%) → 5y 覆盖仅 40% < 70%，触发降级警告
    const partialProfile: Partial<EightDimensionProfile> = {
      technical: fullProfile.technical,
      capitalFlow: fullProfile.capitalFlow,
      positioning: fullProfile.positioning,
      quantitative: fullProfile.quantitative,
    };
    const degraded = computeHorizonEightDimensionScore(partialProfile, '5y');
    expect(degraded.coverage).toBeLessThan(0.7);
    expect(degraded.degradedWarning).toBeTruthy();
    expect(degraded.missingDimensions).toContain('fundamental');
    expect(degraded.missingDimensions).toContain('policy');
  });

  it('4. 五专核心纯函数引擎（S1 资金 / S2 政策 / S3 情绪 / S4 筹码）独立可测且无跨维污染', () => {
    const s1 = computeCapitalFlowDimension({
      gldChange5dTons: 12.5,
      gldChange20dTons: 28,
      cftcDelta4wNetOi: 0.04,
      sgePremiumCny: 8.5,
      comexVolumeRatio: 1.4,
      gold5dReturnPct: 2.1,
      cnEtf5dFlow: 2.0,
    });
    expect(s1.coverage).toBeCloseTo(1, 2);
    expect(s1.score).toBeGreaterThan(60);

    const s2 = computePolicyCycleDimension({
      fedFunds: 4.5,
      us2y: 3.7, // 2Y 显著低于 FFR -> 定价降息
      us10y: 4.1,
      fedFundsChange6mBp: -50,
      pbocConsecutiveMonths: 10,
      pbocMonthlyChangeTons: 12,
    });
    expect(s2.score).toBeGreaterThan(60);
    expect(s2.cycleLabel).toContain('降息');

    const s3 = computeBehavioralSentimentDimension({
      gvz: 29,
      vix: 38, // 流动性恐慌警戒
      rsi14: 82, // FOMO 过热
      consecutiveDirectionDays: 6,
      ma20DevZscore: 2.4,
    });
    expect(s3.score).toBeLessThan(42);
    expect(s3.behaviorWarning).toBeTruthy();

    const s4 = computePositioningChipDimension({
      cftcNetOiPercentile3y: 92, // 存量高度拥挤 -> 反向偏谨慎
      spotUsd: 3600,
      costAnchorUsd: 2800,
      globalAiscUsd: 1450,
    });
    expect(s4.score).toBeLessThan(45);
    expect(s4.crowdingWarning).toContain('拥挤');
  });

  it('5. F01/F02/F04 数学核：Peak-to-Trough 最大回撤、去均值对数缩放防归零、混合分布权重', () => {
    // F01: 路径先涨到 +20% 再跌回 +2%，从峰到谷实际回撤为 (102 - 120) / 120 = -15%，而相对起点仍为 +2%
    const dd = computePathMaxDrawdown([5, 12, 20, 10, 2]);
    expect(dd.maxDrawdownPct).toBeCloseTo(-15.0, 1);
    expect(dd.maxUnderwaterPct).toBe(0);

    // F02: 极端负收益放大后在对数空间仍严格 > -100%（物理不可跌穿 0 元）
    const extremePath = scaleCumPctPathLogFhs([-45, -75], 3.0, 0.005);
    expect(extremePath[1]!).toBeGreaterThan(-100);
    expect(Number.isFinite(extremePath[1]!)).toBe(true);

    // F04: 混合权重和严格为 1，且当相似度集中时保留无条件底座防退化
    const w = mixSampleWeights([0.99, 0.01, 0.01, 0.01, 0.01], 0.5);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(w[1]!).toBeGreaterThan(0.05);

    const mu = causalMeanLogReturn([3000, 3030, 3010, 3050, 3090], 4);
    expect(mu).toBeGreaterThan(0);
  });

  it('6. F16/F17/F18 统计与风控修正：HAC 重叠 Wilson CI、现实回测摩擦与单向反驳钳制', () => {
    // F16: 5日重叠滚动窗口的有效样本数远小于名义 N，HAC 区间必须比朴素 Wilson 更宽
    const nEff = effectiveSampleSizeOverlap(100, 5);
    expect(nEff).toBeLessThan(40);
    const [naiveLo, naiveHi] = wilsonInterval(65, 100);
    const [hacLo, hacHi] = wilsonIntervalHac(65, 100, 5);
    expect(hacHi - hacLo).toBeGreaterThan(naiveHi - naiveLo);

    // F17: 现实回测参数包含无风险现金收益、交易成本、调仓缓冲带，并输出 Sharpe/Sortino/Calmar/换手率
    const bars = Array.from({ length: 20 }, (_, i) => ({
      date: `2026-10-${String(i + 1).padStart(2, '0')}`,
      close: 3000 + i * 15 + (i % 2 === 0 ? -10 : 12),
    }));
    const decisions = [
      { date: '2026-10-01', targetPct: 80, source: 'stored' as const },
      { date: '2026-10-05', targetPct: 72, source: 'stored' as const }, // 变动 8% < 15% 缓冲带 -> 不调仓
      { date: '2026-10-10', targetPct: 30, source: 'stored' as const }, // 变动 50% >= 15% -> 调仓并扣摩擦
    ];
    const eq = buildPaperEquity(bars, decisions, DEFAULT_REALISTIC_BACKTEST_OPTIONS);
    expect(eq.strategy.sharpe).not.toBeNull();
    expect(eq.strategy.annualTurnoverPct).toBeGreaterThan(0);
    expect(eq.strategy.totalCostPct).toBeGreaterThan(0);

    // F18: 默认 bear_rebuttal 对偏空原始分 (35分) 绝不可反向拉高
    const reb = computeRebuttalAdjustment(35, 30, 'strong');
    expect(reb.adjustedScore).toBeLessThanOrEqual(35);
    expect(reb.rawAdjustment).toBeLessThanOrEqual(0);
  });

  it('7. F14 长期展望几何复利、剥离日度情绪，且 report-meta 与 Markdown 正确输出八维表', () => {
    const technical: TechnicalAnalysis = {
      score: 80,
      direction: 'bullish',
      summary: '均线多头排列',
      keyPoints: ['MA20向上'],
      counterPoints: ['短线乖离'],
      sources: ['Yahoo Finance'],
      shortTerm: {
        timeframe: 'daily',
        support: 3500,
        resistance: 3650,
        trend: '震荡偏强',
        indicators: { ma5: '3550', ma20: '3510', macd: '金叉', rsi: '60' },
        keySignal: '多头延续',
      },
      midTerm: {
        timeframe: 'weekly',
        support: 3400,
        resistance: 3700,
        trend: '上升通道',
        indicators: { ma20w: '3450', ma60w: '3100', macd: '红柱', rsi: '62' },
        keySignal: '周线稳健',
      },
    };
    const fundamental: FundamentalAnalysis = {
      score: 65,
      direction: 'bullish',
      summary: '实际利率温和下行',
      keyPoints: ['TIPS回落'],
      counterPoints: ['美元韧性'],
      sources: ['FRED'],
      dollarIndexEffect: '中性偏弱',
      interestRateEffect: '实际利率下行支撑',
      inflationEffect: '温和通胀',
      fedStance: '鸽派观察',
    };
    const sentiment: SentimentAnalysis = {
      score: 10,
      direction: 'bearish',
      summary: '情绪偏谨慎',
      keyPoints: ['短线获利回吐'],
      counterPoints: ['央行买盘托底'],
      sources: ['CBOE'],
      centralBanks: '持续增持',
      cftcPosition: '净多温和',
      vix: '18',
      geopoliticalRisk: '中等',
      etfFlows: '小幅净流入',
    };
    const rebuttal: RebuttalAnalysis = {
      bullScore: 65,
      bearScore: 45,
      adjustedScore: 62,
      rebuttalStrength: 'weak',
      netEffect: 'downgraded',
      bearPoints: [],
      bullVulnerabilities: [],
      tailRisks: [],
    };

    const baseInput = {
      technical,
      fundamental,
      sentiment,
      rebuttal,
      overallScore: 65,
      overallDirection: 'bullish' as const,
      macroRegime: { tag: 'dovish_pivot_watch' as const, label: '降息预期', description: 'test', signals: [] },
    };

    const outLowSent = buildLongTermOutlook(baseInput);
    const outHighSent = buildLongTermOutlook({
      ...baseInput,
      sentiment: { ...sentiment, score: 95, direction: 'bullish' },
    });
    // F14: 日度情绪面在 1/3/5 年权重均为 0%，极端翻情绪绝不影响长期展望
    expect(outLowSent.horizons[2]!.biasScore).toBe(outHighSent.horizons[2]!.biasScore);
    expect(outLowSent.horizons[0]!.biasScore).toBe(outHighSent.horizons[0]!.biasScore);

    const dims: EightDimensionProfile = {
      fundamental: makeDimensionItem('fundamental', { score: 68, coverage: 1, summary: '实际利率温和下行' }),
      news: makeDimensionItem('news', { score: 52, coverage: 1, summary: '消息面均衡' }),
      technical: makeDimensionItem('technical', { score: 61, coverage: 1, summary: '均线多头排列' }),
      capitalFlow: makeDimensionItem('capitalFlow', { score: 64, coverage: 1, summary: 'GLD净流入' }),
      policy: makeDimensionItem('policy', { score: 71, coverage: 1, summary: '联储降息预期+央行增持' }),
      sentiment: makeDimensionItem('sentiment', { score: 49, coverage: 1, summary: '情绪平稳' }),
      positioning: makeDimensionItem('positioning', { score: 46, coverage: 1, summary: '筹码略偏拥挤' }),
      quantitative: makeDimensionItem('quantitative', { score: 60, coverage: 1, summary: '量化偏多' }),
    };

    const fakeReport = {
      timestamp: '2026-11-26T12:00:00Z',
      marketData: {
        timestamp: '2026-11-26T12:00:00Z',
        london: { price: { value: 3560, source: 'test', sourceGrade: 'A' }, change: 10, changePct: 0.28 },
        shanghai: { price: { value: 765, source: 'test', sourceGrade: 'A' }, change: 2, changePct: 0.26 },
        etf: { price: { value: 7.6, source: 'test', sourceGrade: 'A' }, change: 0.02, changePct: 0.26 },
      },
      dataQuality: { overallConfidence: 85, warnings: [] },
      technical,
      fundamental,
      sentiment,
      fund: {
        recommendedFunds: [],
        strategy: '定投',
        summary: '分批布局',
      },
      rebuttal,
      tailRisks: [],
      overall: {
        score: 64,
        direction: 'bullish',
        scenarios: {
          base: { probability: 50, description: '震荡', goldPrice: '3550', action: '持有', confidence: 'moderate' },
          upside: { probability: 30, description: '上行', goldPrice: '3700', action: '增持', confidence: 'moderate', trigger: 'TIPS下行' },
          downside: { probability: 20, description: '回调', goldPrice: '3400', action: '观望', confidence: 'moderate', trigger: '美元走强' },
        },
        calibration: {
          scoreRange: '60-70',
          historicalAccuracy: null,
          historicalAccuracy20d: null,
          systematicBias: '样本不足',
          sampleSize: 0,
        },
        shortTerm: {
          horizon: 'short-term',
          action: '分批',
          entryZone: '3520',
          target: '3650',
          stopLoss: '3450',
          recommendedProduct: '518880',
          riskWarning: '控仓',
        },
        midTerm: {
          horizon: 'medium-term',
          investAdvice: { dipInvest: 'continue', positionAdjust: 'hold', recommendedFund: '博时黄金' },
          keyLevels: { supportZone: '3450', resistanceZone: '3700' },
          riskWarning: '严禁杠杆',
        },
      },
      dimensions: dims,
    } as unknown as GoldAnalysisReport;

    const meta = buildReportMeta({ report: fakeReport });
    expect(meta.dimensions?.fundamental?.code).toBe('B1');
    expect(meta.dimensions?.quantitative?.code).toBe('S5');
    expect(meta.dimensions?.policy?.score).toBe(71);

    const md = formatReportMarkdown(fakeReport);
    expect(md).toContain('## 🧭 八维全景评分（三基 + 五专）');
    expect(md).toContain('B1');
    expect(md).toContain('S5');
  });

  it('8. 版本号与 Web 引擎八维/55年实证锚契约一致 (v2.4.0)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe('2.4.0');

    const docsDir = path.resolve(process.cwd(), 'docs');
    const forecastData = require('../web/forecast-data.cjs') as {
      loadDailyForecastDataset: (d: string) => unknown[];
      loadMonthlyForecastDataset: (d: string) => unknown[];
    };
    const forecastEngine = require('../web/forecast-engine.cjs') as {
      buildDailyGoldForecast: (d: unknown[], asOf?: string, m?: unknown[]) => {
        spot: { cnyBasisNote?: string };
        eightDimensionsByHorizon?: Record<string, {
          compositeScore: number;
          coverage: number;
          dimensions: Array<{ key: string; code: string; weightPct: number }>;
          dominant: Array<{ key: string; weightPct: number }>;
          auxiliary: Array<{ key: string; weightPct: number }>;
        }>;
        horizons: Record<string, {
          summary: { realReturnAnchor?: { note?: string; span?: string; realCagrPct?: number } };
          sampleStats: { independentCycles?: number };
        }>;
      };
    };

    const daily = forecastData.loadDailyForecastDataset(docsDir);
    const monthly = forecastData.loadMonthlyForecastDataset(docsDir);
    const fc = forecastEngine.buildDailyGoldForecast(daily, undefined, monthly);

    expect(fc.spot.cnyBasisNote).toBeTruthy();
    expect(fc.eightDimensionsByHorizon?.['5']?.dimensions.length).toBe(8);
    expect(fc.eightDimensionsByHorizon?.['5']?.dominant.length).toBe(4);
    expect(fc.eightDimensionsByHorizon?.['5y']?.dimensions.length).toBe(8);
    expect(fc.eightDimensionsByHorizon?.['5y']?.dominant.length).toBe(4);
    const news5y = fc.eightDimensionsByHorizon!['5y']!.dimensions.find(d => d.key === 'news');
    const sent5y = fc.eightDimensionsByHorizon!['5y']!.dimensions.find(d => d.key === 'sentiment');
    expect(news5y?.weightPct).toBe(0);
    expect(sent5y?.weightPct).toBe(0);

    // F13: 1y/2y/5y 附带 1971-2026 55 年跨周期实际回报锚与等效独立周期数
    expect(fc.horizons['5y']!.summary.realReturnAnchor).toBeTruthy();
    expect(fc.horizons['5y']!.sampleStats.independentCycles).toBeGreaterThan(0);
  });
});
