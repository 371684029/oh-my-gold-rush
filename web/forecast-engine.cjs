'use strict';

// 黄金走势预测核心引擎 v2.4（纯函数、严格因果零前视泄漏）
// 依据：八维全景框架（三基：基本面/消息面/技术面 + 五专：资金面/政策面/情绪面/筹码面/量化面）
// 方法：去均值对数 FHS（F02）+ 严格几何峰谷回撤（F01）+ 样本权重层经验贝叶斯混合（F04）+ 人民币联合汇率路径（F12）

const { TROY_OUNCE_TO_GRAM, DEFAULT_USD_CNY } = require('./forecast-data.cjs');
const { buildLongTermForecastBundle } = require('./forecast-longterm.cjs');
const {
  computePathMaxDrawdown,
  causalMeanLogReturn,
  buildDemeanedLogFhsPath,
  mixSampleWeights,
  weightedQuantilesBatch,
  weightedEventProbPct,
} = require('./fhs-math.cjs');
const {
  assembleHorizonEightDimensions,
  DIMENSION_META,
} = require('./eight-dimensions.cjs');
const { auditDailyTransmissionVeracity } = require('./news-veracity.cjs');

const HORIZONS = [5, 20, 60];
const SHRINKAGE_K = 12;
const CNY_BASIS_NOTE = '人民币路径已纳入历史 USD/CNY 汇率联动（不含 SGE 极端溢价突变风险）';

/** 各视野的三面权重配置（严格符合金融学时间尺度规律） */
const HORIZON_PILLAR_WEIGHTS = {
  5: { technical: 0.45, fundamental: 0.30, information: 0.25, label: '短期（1周 · 5交易日）', trackName: '技术动量 + 波动状态 + 短期信息' },
  20: { technical: 0.25, fundamental: 0.50, information: 0.25, label: '中期（1个月 · 20交易日）', trackName: '实际利率/美元慢变量 + 资金结构 + 中期均线' },
  60: { technical: 0.20, fundamental: 0.55, information: 0.25, label: '季度参考（约3个月 · 60交易日）', trackName: '宏观基本面周期 + 官方/ETF结构 + 长期估值' },
};

function round(v, digits = 2) {
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1);
  return Math.sqrt(Math.max(0, v));
}

/** 加权分位数（委托给共享 fhs-math.cjs） */
function weightedQuantile(values, weights, q) {
  return weightedQuantilesBatch(values, weights, [q])[0];
}

/** 计算简单移动平均 */
function smaAt(closes, idx, period) {
  if (idx + 1 < period) return null;
  let s = 0;
  for (let i = idx - period + 1; i <= idx; i++) s += closes[i];
  return s / period;
}

/** 计算布林带 (20, 2) */
function bollingerAt(closes, idx, period = 20, mult = 2) {
  if (idx + 1 < period) return null;
  const slice = closes.slice(idx - period + 1, idx + 1);
  const mid = mean(slice);
  const sd = std(slice);
  return {
    upper: mid + mult * sd,
    middle: mid,
    lower: mid - mult * sd,
    bandwidthPct: mid > 0 ? (2 * mult * sd / mid) * 100 : 0,
  };
}

/** 计算 RSI(14) */
function rsiAt(closes, idx, period = 14) {
  if (idx < period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgG = gains / period;
  const avgL = losses / period;
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

/** 计算近 window 日实现日波动率（%，对数收益标准差） */
function realizedDailyVolPctAt(closes, idx, window = 20) {
  const start = Math.max(1, idx - window + 1);
  const rets = [];
  for (let i = start; i <= idx; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) {
      rets.push(Math.log(closes[i] / closes[i - 1]) * 100);
    }
  }
  if (rets.length < 5) return 1.1; // 黄金长期日波动率合理兜底 ~1.1%
  return clamp(std(rets), 0.35, 4.0);
}

/** 从基本面/信息面/技术面构造可比较的特征向量（仅用 <= idx 数据） */
function extractCausalFeatures(records, closes, idx) {
  const r = records[idx];
  const spot = closes[idx];
  const ma20 = smaAt(closes, idx, Math.min(20, idx + 1)) || spot;
  const ma50 = smaAt(closes, idx, Math.min(50, idx + 1)) || ma20;
  const ma20Dev = ma20 > 0 ? ((spot - ma20) / ma20) * 100 : 0;
  const ma50Dev = ma50 > 0 ? ((spot - ma50) / ma50) * 100 : 0;
  const rsi = rsiAt(closes, idx, 14) ?? 50;
  const volPct = realizedDailyVolPctAt(closes, idx, 20);

  // 缺失宏观数据时向前继承最近有效观测（绝不偷看未来）
  let tips = r.tipsYield;
  let dxy = r.dxy;
  let us10y = r.us10y;
  let flow = r.flowScore ?? r.officialFlowScore;
  for (let k = idx - 1; k >= Math.max(0, idx - 15); k--) {
    if (tips == null && records[k].tipsYield != null) tips = records[k].tipsYield;
    if (dxy == null && records[k].dxy != null) dxy = records[k].dxy;
    if (us10y == null && records[k].us10y != null) us10y = records[k].us10y;
    if (flow == null && (records[k].flowScore != null || records[k].officialFlowScore != null)) {
      flow = records[k].flowScore ?? records[k].officialFlowScore;
    }
  }

  return {
    tips: tips ?? 2.0,
    dxy: dxy ?? 104,
    us10y: us10y ?? 4.3,
    ma20Dev,
    ma50Dev,
    rsi,
    volPct,
    flow: flow ?? 50,
    techScore: r.technicalScore ?? r.quantScore ?? r.overallScore ?? 50,
    fundScore: r.fundamentalScore ?? r.midTermScore ?? 50,
    infoScore: r.sentimentScore ?? flow ?? 50,
    quantScore: r.quantScore ?? r.technicalScore ?? r.overallScore ?? 50,
    midTermScore: r.midTermScore ?? r.fundamentalScore ?? 50,
    macroTag: r.macroTag || 'unknown',
  };
}

/** 计算三个维度的明确分数、方向与依据摘要 */
function buildThreePillars(rec, feat, bb, ma20, ma50, ma60, horizonWeights) {
  // 1) 基本面（TIPS、DXY、US10Y、宏观阶段、中期慢变量）
  let fundScore = rec.fundamentalScore;
  if (fundScore == null) {
    const tipsPart = clamp(50 - (feat.tips - 1.8) * 18, 15, 85);
    const dxyPart = rec.dxyDevMa60 != null ? clamp(50 - rec.dxyDevMa60 * 6, 15, 85) : 50;
    fundScore = Math.round(tipsPart * 0.6 + dxyPart * 0.4);
  }
  const fundMetrics = [];
  if (rec.tipsYield != null || feat.tips != null) {
    const tv = rec.tipsYield ?? feat.tips;
    const obsTag = rec.macroObsDate ? ` (${rec.macroObsDate.slice(5)})` : '';
    fundMetrics.push({ k: '实际利率(TIPS)', v: `${round(tv, 2)}%${obsTag}`, tone: tv >= 2.0 ? 'bear' : tv <= 1.2 ? 'bull' : 'neutral' });
  }
  if (rec.dxy != null) {
    fundMetrics.push({ k: '美元指数(DXY)', v: `${round(rec.dxy, 2)}`, tone: rec.dxy >= 106 ? 'bear' : rec.dxy <= 100 ? 'bull' : 'neutral' });
  } else if (rec.dxyDevMa60 != null) {
    fundMetrics.push({ k: '美元偏离MA60', v: `${rec.dxyDevMa60 >= 0 ? '+' : ''}${round(rec.dxyDevMa60, 2)}%`, tone: rec.dxyDevMa60 > 1.5 ? 'bear' : rec.dxyDevMa60 < -1.5 ? 'bull' : 'neutral' });
  }
  if (rec.us10y != null) {
    fundMetrics.push({ k: '美债10Y', v: `${round(rec.us10y, 2)}%`, tone: rec.us10y >= 4.5 ? 'bear' : 'neutral' });
  }
  if (rec.macroLabel) {
    fundMetrics.push({ k: '宏观阶段', v: rec.macroLabel, tone: rec.macroTag === 'real_rate_headwind' ? 'bear' : rec.macroTag === 'real_rate_tailwind' ? 'bull' : 'neutral' });
  }

  // 2) 信息面（情绪面 + 事件→黄金传导通道 + CFTC/GLD 资金流）
  const tr = rec.transmission;
  let infoScore = rec.sentimentScore;
  if (infoScore == null) infoScore = feat.flow ?? 50;
  if (rec.hasAiReport && feat.flow != null && rec.sentimentScore != null) {
    infoScore = Math.round(rec.sentimentScore * 0.6 + feat.flow * 0.4);
  }
  const infoMetrics = [];
  if (tr?.verdict) {
    infoMetrics.push({ k: '事件传导', v: tr.verdict.slice(0, 22), tone: tr.verdict.includes('利空') ? 'bear' : tr.verdict.includes('利多') ? 'bull' : 'neutral' });
  } else if (!rec.hasAiReport) {
    infoMetrics.push({ k: 'AI 日报解读', v: '当日无日报（仅实盘资金）', tone: 'neutral' });
  }
  if (rec.flowScore != null || rec.officialFlowScore != null) {
    const fl = rec.flowScore ?? rec.officialFlowScore;
    infoMetrics.push({ k: '主力资金综合分', v: `${fl}/100`, tone: fl >= 58 ? 'bull' : fl <= 42 ? 'bear' : 'neutral' });
  }
  if (rec.cftcPercentile != null) {
    const cDate = rec.cftcObsDate ? ` (${rec.cftcObsDate.slice(5)})` : '';
    infoMetrics.push({ k: 'CFTC净多头分位', v: `${Math.round(rec.cftcPercentile)}%${cDate}`, tone: rec.cftcPercentile >= 80 ? 'bear' : rec.cftcPercentile <= 25 ? 'bull' : 'neutral' });
  }
  if (rec.gldClose != null) {
    const retStr = rec.gld20dRet != null ? ` (20日${rec.gld20dRet >= 0 ? '+' : ''}${rec.gld20dRet}%)` : '';
    infoMetrics.push({ k: 'GLD ETF 动量', v: `$${round(rec.gldClose, 1)}${retStr}`, tone: (rec.gld20dRet ?? 0) >= 2 ? 'bull' : (rec.gld20dRet ?? 0) <= -2 ? 'bear' : 'neutral' });
  }
  if (tr?.channels?.length) {
    const topCh = tr.channels.slice().sort((a, b) => b.strength - a.strength)[0];
    if (topCh) infoMetrics.push({ k: `主导通道(${topCh.channel})`, v: `${topCh.bias} · 强度${topCh.strength}`, tone: topCh.bias === '利多金' ? 'bull' : topCh.bias === '利空金' ? 'bear' : 'neutral' });
  }

  // 3) 技术面（均线位置、RSI、布林带、量化分、20日波动率）
  let techScore = rec.technicalScore;
  if (techScore == null) techScore = rec.quantScore ?? Math.round(clamp(50 + feat.ma20Dev * 3, 20, 80));
  const techMetrics = [
    { k: '相对MA20', v: `${feat.ma20Dev >= 0 ? '+' : ''}${round(feat.ma20Dev, 2)}%`, tone: feat.ma20Dev >= 0.8 ? 'bull' : feat.ma20Dev <= -0.8 ? 'bear' : 'neutral' },
    { k: 'RSI(14)', v: `${round(feat.rsi, 1)}`, tone: feat.rsi >= 70 ? 'bear' : feat.rsi <= 30 ? 'bull' : 'neutral' },
    { k: '20日日波动率 σ₀', v: `${round(feat.volPct, 2)}%/日 (年化${round(feat.volPct * Math.sqrt(252), 1)}%)`, tone: feat.volPct >= 1.6 ? 'bear' : 'neutral' },
  ];
  if (rec.quantScore != null) {
    techMetrics.unshift({ k: '量化综合分', v: `${rec.quantScore}/100`, tone: rec.quantScore >= 58 ? 'bull' : rec.quantScore <= 42 ? 'bear' : 'neutral' });
  }

  const toDir = (s) => (s >= 58 ? { code: 'bullish', label: '偏多' } : s <= 42 ? { code: 'bearish', label: '偏空' } : { code: 'neutral', label: '中性' });

  return {
    fundamental: {
      key: 'fundamental',
      title: '基本面依据',
      subtitle: '实际利率 · 美元 · 宏观周期',
      score: fundScore,
      ...toDir(fundScore),
      weightPct: Math.round(horizonWeights.fundamental * 100),
      metrics: fundMetrics,
      summary: rec.fundamentalSummary || rec.midTermDrivers?.[0] || '由实际利率（TIPS）、美元走势与宏观周期共同约束黄金中枢。',
    },
    information: {
      key: 'information',
      title: '信息面依据',
      subtitle: rec.hasAiReport ? '事件传导 · 市场情绪 · 主力资金' : 'CFTC 持仓 · GLD 资金流（无 AI 日报）',
      score: infoScore,
      ...toDir(infoScore),
      weightPct: Math.round(horizonWeights.information * 100),
      metrics: infoMetrics,
      summary: rec.sentimentSummary || tr?.excerpt || tr?.verdict || '跟踪地缘/政策事件经利率、美元、避险通道的传导与 CFTC/ETF/央行资金流。',
    },
    technical: {
      key: 'technical',
      title: '技术面依据',
      subtitle: '均线结构 · 动量 · FHS波动率',
      score: techScore,
      ...toDir(techScore),
      weightPct: Math.round(horizonWeights.technical * 100),
      metrics: techMetrics,
      summary: rec.technicalSummary || `现价相对 MA20 ${feat.ma20Dev >= 0 ? '+' : ''}${round(feat.ma20Dev, 2)}%，20 日实现日波动率 ${round(feat.volPct, 2)}% 用于 FHS 带宽定标。`,
    },
  };
}

/** 构造 v2.4 短中期八维全景对象（三基 + 五专，严格正交、绝不重复计权） */
function buildDailyEightDimensions(rec, feat, bb, ma20, ma60, spot, horizonKey, horizonData, prevRec) {
  const sigma0 = feat.volPct;

  // B1 基本面：10Y TIPS 水平/趋势 + DXY 相对 MA60 + US10Y（不混入政策斜率或资金流）
  const b1Metrics = [];
  let b1Score = rec.fundamentalScore;
  if (b1Score == null) {
    const tipsPart = clamp(54 - (feat.tips - 1.5) * 14, 18, 84);
    const dxyPart = rec.dxyDevMa60 != null ? clamp(50 - rec.dxyDevMa60 * 6, 18, 84) : 50;
    b1Score = Math.round(tipsPart * 0.6 + dxyPart * 0.4);
  }
  if (rec.tipsYield != null || feat.tips != null) {
    const tv = rec.tipsYield ?? feat.tips;
    b1Metrics.push({ k: '10Y TIPS 实际利率', v: `${round(tv, 2)}%${rec.macroObsDate ? ` (${rec.macroObsDate.slice(5)})` : ''}`, tone: tv >= 2.0 ? 'bear' : tv <= 1.2 ? 'bull' : 'neutral' });
  }
  if (rec.dxy != null) {
    b1Metrics.push({ k: '美元指数 DXY', v: `${round(rec.dxy, 2)}`, tone: rec.dxy >= 106 ? 'bear' : rec.dxy <= 100 ? 'bull' : 'neutral' });
  }
  if (rec.us10y != null) {
    b1Metrics.push({ k: '美债 10Y 名义利率', v: `${round(rec.us10y, 2)}%`, tone: rec.us10y >= 4.5 ? 'bear' : 'neutral' });
  }
  if (rec.macroLabel) {
    b1Metrics.push({ k: '宏观阶段', v: rec.macroLabel, tone: rec.macroTag === 'real_rate_headwind' ? 'bear' : rec.macroTag === 'real_rate_tailwind' ? 'bull' : 'neutral' });
  }

  // B2 消息面（v2.5）：四道防线真伪甄别 + 跨市场三通道证伪（钓鱼/噪音剥离出事实层，反向价值转 S3 情绪面）
  const tr = rec.transmission;
  const newsAudit = auditDailyTransmissionVeracity(rec, feat, prevRec);
  const b2Score = newsAudit.b2Score;
  const b2Metrics = [];
  const b2DirTone = b2Score == null ? 'neutral' : b2Score >= 58 ? 'bull' : b2Score <= 42 ? 'bear' : 'neutral';
  b2Metrics.push({
    k: '真伪核验评级',
    v: newsAudit.badge,
    tone: newsAudit.status === 'bait_suspected' ? 'bear' : newsAudit.status === 'confirmed' ? b2DirTone : 'neutral',
  });
  b2Metrics.push({
    k: '跨市场价格证伪',
    v: newsAudit.evidenceLine,
    tone: newsAudit.marketConfirmation === 'contradicted' ? 'bear' : newsAudit.marketConfirmation === 'confirmed' ? b2DirTone : 'neutral',
  });
  if (tr?.channels?.length) {
    const topCh = tr.channels.slice().sort((a, b) => b.strength - a.strength)[0];
    if (topCh) {
      b2Metrics.push({
        k: `主导通道(${topCh.channel})`,
        v: `${topCh.bias} · 强度${topCh.strength}`,
        tone: topCh.bias === '利多金' ? 'bull' : topCh.bias === '利空金' ? 'bear' : 'neutral',
      });
    }
  }

  // B3 技术面：均线趋势（MA20/MA60）+ 布林结构位（不含 RSI 极端情绪与 ATR 波动定标）
  const bbPctB = (bb && bb.upper > bb.lower) ? (spot - bb.lower) / (bb.upper - bb.lower) : null;
  const b3Score = Math.round(clamp(
    50 + feat.ma20Dev * 3.4 + feat.ma50Dev * 1.2 + (bbPctB != null ? (0.5 - bbPctB) * 14 : 0),
    18,
    84,
  ));
  const b3Metrics = [
    { k: '相对 MA20 乖离', v: `${feat.ma20Dev >= 0 ? '+' : ''}${round(feat.ma20Dev, 2)}%`, tone: feat.ma20Dev >= 0.8 ? 'bull' : feat.ma20Dev <= -0.8 ? 'bear' : 'neutral' },
    { k: '相对 MA50 结构', v: `${feat.ma50Dev >= 0 ? '+' : ''}${round(feat.ma50Dev, 2)}%`, tone: feat.ma50Dev >= 1.0 ? 'bull' : feat.ma50Dev <= -1.0 ? 'bear' : 'neutral' },
  ];
  if (bbPctB != null) {
    b3Metrics.push({ k: '布林带位置 %B', v: `${round(bbPctB * 100, 0)}%`, tone: bbPctB <= 0.2 ? 'bull' : bbPctB >= 0.85 ? 'bear' : 'neutral' });
  }
  if (ma60) {
    b3Metrics.push({ k: 'MA60 支撑/阻力', v: `$${round(ma60, 1)}`, tone: spot >= ma60 ? 'bull' : 'bear' });
  }

  // S1 资金面：GLD 5D/20D 动量 + CFTC 4W 边际净增减 + COMEX 成交量比 + 上海溢价（正交于 3Y 拥挤度）
  const s1Parts = [];
  const s1Metrics = [];
  if (rec.gld20dRet != null) {
    const s = clamp(50 + rec.gld20dRet * 2.8, 20, 82);
    s1Parts.push({ s, w: 0.35 });
    s1Metrics.push({ k: 'GLD ETF 20日动量', v: `${rec.gld20dRet >= 0 ? '+' : ''}${rec.gld20dRet}%`, tone: rec.gld20dRet >= 2 ? 'bull' : rec.gld20dRet <= -2 ? 'bear' : 'neutral' });
  }
  if (rec.gld5dRet != null) {
    const s = clamp(50 + rec.gld5dRet * 3.2, 20, 82);
    s1Parts.push({ s, w: 0.20 });
    s1Metrics.push({ k: 'GLD ETF 5日脉冲', v: `${rec.gld5dRet >= 0 ? '+' : ''}${rec.gld5dRet}%`, tone: rec.gld5dRet >= 1.5 ? 'bull' : rec.gld5dRet <= -1.5 ? 'bear' : 'neutral' });
  }
  if (rec.cftcDelta4wNet != null) {
    const s = clamp(50 + Math.tanh(rec.cftcDelta4wNet / 40000) * 26, 22, 80);
    s1Parts.push({ s, w: 0.25 });
    s1Metrics.push({ k: 'CFTC 4周净多头Δ', v: `${rec.cftcDelta4wNet >= 0 ? '+' : ''}${(rec.cftcDelta4wNet / 1000).toFixed(1)}k 手`, tone: rec.cftcDelta4wNet >= 10000 ? 'bull' : rec.cftcDelta4wNet <= -10000 ? 'bear' : 'neutral' });
  }
  if (rec.sgePremiumCny != null) {
    const s = clamp(50 + Math.tanh(rec.sgePremiumCny / 8) * 22, 24, 78);
    s1Parts.push({ s, w: 0.20 });
    s1Metrics.push({ k: '上海金 Au99.99 溢价', v: `${rec.sgePremiumCny >= 0 ? '+' : ''}${round(rec.sgePremiumCny, 2)} 元/克`, tone: rec.sgePremiumCny >= 3 ? 'bull' : rec.sgePremiumCny <= -3 ? 'bear' : 'neutral' });
  }
  if (rec.comexVolRatio != null) {
    s1Metrics.push({ k: 'COMEX 相对量比', v: `${rec.comexVolRatio}× (20日均量)`, tone: rec.comexVolRatio >= 1.5 ? 'bull' : 'neutral' });
  }
  const s1W = s1Parts.reduce((a, b) => a + b.w, 0);
  const s1Score = s1W > 0 ? Math.round(s1Parts.reduce((a, b) => a + b.s * b.w, 0) / s1W) : null;

  // S2 政策面：联储利率周期 + 2s10s 收益率曲线 + TIPS 60D 政策斜率（正交于 TIPS 绝对水平）
  const s2Parts = [];
  const s2Metrics = [];
  if (rec.tipsChange60dBp != null) {
    const s = clamp(50 - rec.tipsChange60dBp * 0.45, 20, 82);
    s2Parts.push({ s, w: 0.45 });
    s2Metrics.push({ k: 'TIPS 60日政策斜率', v: `${rec.tipsChange60dBp >= 0 ? '+' : ''}${rec.tipsChange60dBp} bp`, tone: rec.tipsChange60dBp <= -15 ? 'bull' : rec.tipsChange60dBp >= 15 ? 'bear' : 'neutral' });
  }
  if (rec.yieldCurve2s10sBp != null) {
    // 曲线陡峭化/解除倒挂通常对应降息宽松周期利多黄金
    const s = clamp(52 + Math.tanh(rec.yieldCurve2s10sBp / 80) * 18, 28, 76);
    s2Parts.push({ s, w: 0.30 });
    s2Metrics.push({ k: '美债 10Y-2Y 利差', v: `${rec.yieldCurve2s10sBp >= 0 ? '+' : ''}${rec.yieldCurve2s10sBp} bp`, tone: rec.yieldCurve2s10sBp >= 20 ? 'bull' : rec.yieldCurve2s10sBp <= -30 ? 'bear' : 'neutral' });
  }
  if (rec.fedFunds != null) {
    const s = clamp(56 - (rec.fedFunds - 3.0) * 4.5, 28, 78);
    s2Parts.push({ s, w: 0.25 });
    s2Metrics.push({ k: '联邦基金利率', v: `${round(rec.fedFunds, 2)}%`, tone: rec.fedFunds >= 4.75 ? 'bear' : rec.fedFunds <= 2.5 ? 'bull' : 'neutral' });
  }
  const s2W = s2Parts.reduce((a, b) => a + b.w, 0);
  const s2Score = s2W > 0 ? Math.round(s2Parts.reduce((a, b) => a + b.s * b.w, 0) / s2W) : null;

  // S3 情绪面（行为金融学）：GVZ/VIX + RSI 极端反转段 + 连续单边羊群效应警示
  const s3Parts = [];
  const s3Metrics = [];
  let s3Warning = null;
  // RSI 极端段（>72 过热反向，<28 恐慌修复；30–70 视为中性）
  const rsiExtScore = feat.rsi >= 72
    ? clamp(48 - (feat.rsi - 72) * 1.6, 22, 48)
    : feat.rsi <= 28
      ? clamp(54 + (28 - feat.rsi) * 1.6, 54, 78)
      : 50;
  s3Parts.push({ s: rsiExtScore, w: 0.45 });
  s3Metrics.push({ k: 'RSI(14) 情绪区间', v: `${round(feat.rsi, 1)}${feat.rsi >= 72 ? ' (过热)' : feat.rsi <= 28 ? ' (恐慌)' : ' (温和)'}`, tone: feat.rsi >= 72 ? 'bear' : feat.rsi <= 28 ? 'bull' : 'neutral' });
  if (rec.gvz != null) {
    const s = rec.gvz >= 26 ? clamp(44 - (rec.gvz - 26) * 1.2, 24, 46) : rec.gvz <= 13 ? 54 : 50;
    s3Parts.push({ s, w: 0.30 });
    s3Metrics.push({ k: '黄金隐波 GVZ', v: `${round(rec.gvz, 1)}`, tone: rec.gvz >= 25 ? 'bear' : 'neutral' });
  }
  if (rec.vix != null) {
    const s = rec.vix >= 25 ? 62 : rec.vix <= 13 ? 48 : 50;
    s3Parts.push({ s, w: 0.25 });
    s3Metrics.push({ k: '美股恐慌 VIX', v: `${round(rec.vix, 1)}`, tone: rec.vix >= 25 ? 'bull' : 'neutral' });
  }
  if (Math.abs(rec.consecDirDays || 0) >= 4) {
    const dir = rec.consecDirDays > 0 ? '连涨' : '连跌';
    s3Warning = `羊群动量警示：已连续${dir} ${Math.abs(rec.consecDirDays)} 个交易日，警惕均值回归`;
    s3Metrics.push({ k: '连涨/连跌天数', v: `${dir} ${Math.abs(rec.consecDirDays)} 日`, tone: rec.consecDirDays > 0 ? 'bear' : 'bull' });
  }
  const s3W = s3Parts.reduce((a, b) => a + b.w, 0);
  const s3BaseScore = s3W > 0 ? Math.round(s3Parts.reduce((a, b) => a + b.s * b.w, 0) / s3W) : 50;
  // v2.5 防钓鱼反向价值注入 S3 情绪面（利多钓鱼防追高扣分，利空诱空防错杀加分）
  if (newsAudit.baitAlert) {
    if (newsAudit.contrarianSentimentBias !== 0) {
      s3Metrics.push({
        k: '防钓鱼反向修正',
        v: `${newsAudit.contrarianSentimentBias > 0 ? '+' : ''}${newsAudit.contrarianSentimentBias}分 (${newsAudit.contrarianSentimentBias < 0 ? '防高位派发' : '防恐慌错杀'})`,
        tone: newsAudit.contrarianSentimentBias < 0 ? 'bear' : 'bull',
      });
    }
    s3Warning = s3Warning ? `${newsAudit.baitAlert}；${s3Warning}` : newsAudit.baitAlert;
  }
  const s3Score = Math.round(clamp(s3BaseScore + newsAudit.contrarianSentimentBias, 15, 85));

  // S4 筹码面（供需与持仓结构）：CFTC 3Y 拥挤度分位（极端反向）+ 60日成本锚 VWAP 偏离
  const s4Parts = [];
  const s4Metrics = [];
  if (rec.cftcPercentile != null) {
    const p = rec.cftcPercentile;
    const s = p >= 85
      ? clamp(44 - (p - 85) * 1.5, 20, 44)
      : p <= 25
        ? clamp(58 + (25 - p) * 0.9, 58, 80)
        : clamp(48 + (50 - Math.abs(p - 55)) * 0.14, 46, 56);
    s4Parts.push({ s, w: 0.60 });
    const oiStr = rec.cftcNetToOiPct != null ? ` · 净多/OI ${rec.cftcNetToOiPct}%` : '';
    s4Metrics.push({ k: 'CFTC 3年拥挤分位', v: `第 ${Math.round(p)}% 分位${oiStr}`, tone: p >= 85 ? 'bear' : p <= 25 ? 'bull' : 'neutral' });
  }
  if (rec.vwap60Usd != null && rec.vwap60Usd > 0) {
    const dev = round(((spot - rec.vwap60Usd) / rec.vwap60Usd) * 100, 2);
    // 相对 60 日筹码成本偏离过高 → 获利盘涌出风险；跌破成本区过多 → 筹码承接
    const s = dev >= 8 ? clamp(45 - (dev - 8) * 1.5, 24, 45) : dev <= -6 ? clamp(58 + (-6 - dev) * 1.4, 58, 76) : 52;
    s4Parts.push({ s, w: 0.40 });
    const srcTag = rec.vwap60Source === 'comex_vol' ? 'COMEX量权' : rec.vwap60Source === 'gld_vol' ? 'GLD量权' : '60日均价';
    s4Metrics.push({ k: `60日筹码成本(${srcTag})`, v: `$${round(rec.vwap60Usd, 1)} (${dev >= 0 ? '+' : ''}${dev}%)`, tone: dev >= 8 ? 'bear' : dev <= -6 ? 'bull' : 'neutral' });
  }
  const s4W = s4Parts.reduce((a, b) => a + b.w, 0);
  const s4Score = s4W > 0 ? Math.round(s4Parts.reduce((a, b) => a + b.s * b.w, 0) / s4W) : null;

  // S5 量化面（统计框架、FHS 有效样本、波动定标，σ₀ 不给方向偏置）
  const endP50 = horizonData?.summary?.endP50Pct ?? 0;
  const upProb = horizonData?.summary?.upEndProb ?? 50;
  const nEff = horizonData?.sampleStats?.effectiveSampleSize ?? 0;
  const lam = horizonData?.sampleStats?.shrinkageWeight ?? 0.5;
  const quantModelScore = rec.quantScore ?? Math.round(clamp(50 + (upProb - 50) * 0.9, 20, 82));
  const s5Metrics = [
    { k: '量化综合分', v: `${quantModelScore}/100`, tone: quantModelScore >= 58 ? 'bull' : quantModelScore <= 42 ? 'bear' : 'neutral' },
    { k: '20日波动定标 σ₀', v: `${round(sigma0, 2)}%/日 (仅带宽风控·不押方向)`, tone: 'neutral' },
    { k: '对数FHS 有效样本', v: `N_eff = ${nEff} · 收缩 ${Math.round(lam * 100)}%`, tone: nEff >= 25 ? 'bull' : 'neutral' },
    { k: '条件期末胜率', v: `${upProb}% (中位 ${endP50 >= 0 ? '+' : ''}${endP50}%)`, tone: upProb >= 58 ? 'bull' : upProb <= 42 ? 'bear' : 'neutral' },
  ];

  return assembleHorizonEightDimensions({
    fundamental: {
      score: b1Score,
      coverage: b1Metrics.length > 0 ? 1 : 0,
      metrics: b1Metrics,
      summary: rec.fundamentalSummary || '由 10Y TIPS 实际利率、美元指数与宏观阶段共同决定黄金长期定价中枢。',
      dataFreshness: rec.macroObsDate ? `FRED ${rec.macroObsDate}` : rec.date,
    },
    news: {
      score: b2Score,
      coverage: newsAudit.b2Coverage,
      veracityBadge: newsAudit.badge,
      veracityStatus: newsAudit.status,
      warning: newsAudit.status === 'bait_suspected' ? newsAudit.baitAlert : null,
      metrics: b2Metrics,
      summary: newsAudit.status === 'bait_suspected'
        ? '疑似钓鱼/背离消息已严格剥离出 B2 事实层（权重自动重归一），反向预警已转交 S3 情绪面。'
        : ((tr?.excerpt && !/分析异常|分析超时|^未知/.test(tr.excerpt) ? tr.excerpt : null)
          || tr?.verdict
          || '当日无 AI 事件传导摘录，消息面自动置空并按剩余维度重归一权重。'),
      dataFreshness: rec.hasAiReport ? `日报 ${rec.date}` : '无当日日报',
    },
    technical: {
      score: b3Score,
      coverage: 1,
      metrics: b3Metrics,
      summary: `均线结构 MA20 ${feat.ma20Dev >= 0 ? '+' : ''}${round(feat.ma20Dev, 2)}%、MA50 ${feat.ma50Dev >= 0 ? '+' : ''}${round(feat.ma50Dev, 2)}%（已将 RSI 极端与波动率分离至情绪/量化维）。`,
      dataFreshness: rec.date,
    },
    capitalFlow: {
      score: s1Score,
      coverage: s1W > 0 ? round(Math.min(1, s1W), 2) : 0,
      metrics: s1Metrics,
      summary: s1Metrics.length > 0
        ? '跟踪 GLD ETF 资金动量、CFTC 4周边际净增减、COMEX 量比与上海金内外盘溢价。'
        : '资金流字段暂缺，已自动剔除重归一。',
      dataFreshness: rec.cftcObsDate || rec.date,
    },
    policy: {
      score: s2Score,
      coverage: s2W > 0 ? round(Math.min(1, s2W), 2) : 0,
      metrics: s2Metrics,
      summary: s2Metrics.length > 0
        ? '刻画联储货币政策周期（TIPS 60日斜率、2s10s 收益率曲线、联邦基金利率）。'
        : '政策利率斜率数据暂缺，已自动剔除重归一。',
      dataFreshness: rec.macroObsDate || rec.date,
    },
    sentiment: {
      score: s3Score,
      coverage: 1,
      metrics: s3Metrics,
      summary: s3Warning || '行为金融学反向监控：在 RSI 极端过热/恐慌区、GVZ/VIX 脉冲与连涨连跌时提供逆向预警。',
      warning: s3Warning,
      dataFreshness: rec.date,
    },
    positioning: {
      score: s4Score,
      coverage: s4W > 0 ? round(Math.min(1, s4W), 2) : 0,
      metrics: s4Metrics,
      summary: s4Metrics.length > 0
        ? '监控 CFTC 3 年持仓拥挤分位（极端反向）与 60 日筹码成本偏离。'
        : '筹码持仓数据暂缺，已自动剔除重归一。',
      dataFreshness: rec.cftcObsDate || rec.date,
    },
    quantitative: {
      score: quantModelScore,
      coverage: 1,
      metrics: s5Metrics,
      summary: `纯本地统计引擎：去均值对数 FHS + 严格峰谷回撤 + 样本层经验贝叶斯混合（N_eff=${nEff}）。`,
      dataFreshness: rec.date,
    },
  }, String(horizonKey));
}

/** 构造单一视野（5 / 20 / 60 日）的严格因果 FHS 概率走势（v2.4: F01/F02/F04/F12 全量修复） */
function buildSingleHorizonForecast(records, closes, cnyCloses, features, asOfIdx, horizon, spot, spotCny, usdCny) {
  const pw = HORIZON_PILLAR_WEIGHTS[horizon] || HORIZON_PILLAR_WEIGHTS[20];
  const curFeat = features[asOfIdx];
  const curRec = records[asOfIdx];
  const sigma0 = curFeat.volPct;

  // 有效历史样本必须满足：d + horizon <= asOfIdx（严格杜绝前视泄漏！）
  const maxSampleIdx = asOfIdx - horizon;
  const candidateIndices = [];
  for (let d = 5; d <= maxSampleIdx; d++) {
    candidateIndices.push(d);
  }

  // 如果历史长度不够 60 日视野（例如极早期日期），降级使用基于 5 日分块拼接的 FHS Bootstrap（严格因果 <= asOfIdx）
  const useBlockBootstrap = candidateIndices.length < 10;

  // 计算标准化统计量（仅使用 <= asOfIdx 的特征，零泄漏）
  const featSlice = features.slice(0, asOfIdx + 1);
  const keys = ['tips', 'dxy', 'ma20Dev', 'ma50Dev', 'rsi', 'volPct', 'flow', 'quantScore', 'midTermScore'];
  const stats = {};
  for (const k of keys) {
    const vals = featSlice.map(f => f[k]);
    stats[k] = { m: mean(vals), s: std(vals) || 1 };
  }

  // 按视野分配特征距离权重（5日偏技术+波动；20/60日偏基本面+慢变量+宏观）
  const distWeights = horizon === 5
    ? { ma20Dev: 1.5, rsi: 1.2, volPct: 1.4, quantScore: 1.5, tips: 1.1, dxy: 1.1, flow: 1.0, midTermScore: 0.4, ma50Dev: 0.5 }
    : { tips: 2.0, dxy: 1.8, midTermScore: 1.8, ma50Dev: 1.4, flow: 1.4, volPct: 1.1, ma20Dev: 0.5, rsi: 0.3, quantScore: 0.5 };

  // 1) 收集历史路径 + 去均值单步对数 FHS（F02）+ 严格几何峰谷最大回撤（F01）+ 人民币联合汇率路径（F12）
  const muUsd = causalMeanLogReturn(closes, asOfIdx);
  const muCny = causalMeanLogReturn(cnyCloses, asOfIdx);
  const cnySigma0 = realizedDailyVolPctAt(cnyCloses, asOfIdx, 20);
  const sampleEntries = [];
  if (!useBlockBootstrap) {
    for (const d of candidateIndices) {
      const startPrice = closes[d];
      const sigmaD = features[d].volPct;
      const volScale = clamp(sigma0 / sigmaD, 0.45, 2.2);
      const cnySigmaD = realizedDailyVolPctAt(cnyCloses, d, 20);
      const cnyVolScale = clamp(cnySigma0 / cnySigmaD, 0.45, 2.2);

      const scaledPath = buildDemeanedLogFhsPath(closes, d, horizon, volScale, muUsd);
      const cnyScaledPath = buildDemeanedLogFhsPath(cnyCloses, d, horizon, cnyVolScale, muCny);

      const ddInfo = computePathMaxDrawdown(scaledPath);
      const cnyDdInfo = computePathMaxDrawdown(cnyScaledPath);
      let maxRet = 0;
      for (let h = 0; h < scaledPath.length; h++) {
        if (scaledPath[h] > maxRet) maxRet = scaledPath[h];
      }

      let sqSum = 0;
      let wSum = 0;
      for (const k of keys) {
        const w = distWeights[k] || 0;
        if (w <= 0) continue;
        const z0 = (curFeat[k] - stats[k].m) / stats[k].s;
        const zd = (features[d][k] - stats[k].m) / stats[k].s;
        sqSum += w * (z0 - zd) * (z0 - zd);
        wSum += w;
      }
      const dist = Math.sqrt(sqSum / (wSum || 1));
      const regimeMult = (curFeat.macroTag !== 'unknown' && features[d].macroTag === curFeat.macroTag) ? 1.35 : 0.85;
      const similarity = Math.exp(-dist * dist / 2.2);
      const rawWeight = similarity * regimeMult;

      sampleEntries.push({
        idx: d,
        date: records[d].date,
        filename: records[d].filename,
        similarity: round(similarity * 100, 1),
        rawWeight,
        volScale: round(volScale, 2),
        scaledPath,
        cnyScaledPath,
        rawEndPct: round(((closes[d + horizon] - startPrice) / startPrice) * 100, 2),
        scaledEndPct: round(scaledPath[horizon - 1], 2),
        maxDdPct: ddInfo.maxDrawdownPct,
        maxUnderwaterPct: ddInfo.maxUnderwaterPct,
        cnyMaxDdPct: cnyDdInfo.maxDrawdownPct,
        minRet: ddInfo.maxUnderwaterPct,
        maxRet,
      });
    }
  } else {
    // 严格去均值对数收益分块 Bootstrap（保障 P > 0 且零漂移放大）
    const dayLogRets = [];
    const cnyDayLogRets = [];
    for (let i = 1; i <= asOfIdx; i++) {
      const rLog = (closes[i] > 0 && closes[i - 1] > 0) ? Math.log(closes[i] / closes[i - 1]) : 0;
      const volScale = clamp(sigma0 / features[i - 1].volPct, 0.45, 2.2);
      dayLogRets.push(clamp(muUsd + volScale * (rLog - muUsd), -0.35, 0.35));

      const cLog = (cnyCloses[i] > 0 && cnyCloses[i - 1] > 0) ? Math.log(cnyCloses[i] / cnyCloses[i - 1]) : 0;
      const cScale = clamp(cnySigma0 / realizedDailyVolPctAt(cnyCloses, i - 1, 20), 0.45, 2.2);
      cnyDayLogRets.push(clamp(muCny + cScale * (cLog - muCny), -0.35, 0.35));
    }
    const blockLen = 5;
    const nBlocks = Math.max(1, dayLogRets.length - blockLen + 1);
    const numPaths = Math.min(60, nBlocks);
    for (let s = 0; s < numPaths; s++) {
      const path = [];
      const cnyPath = [];
      let cumLog = 0;
      let cnyCumLog = 0;
      let maxRet = 0;
      for (let h = 0; h < horizon; h++) {
        const blkIdx = (s * 7 + Math.floor(h / blockLen) * 11) % nBlocks;
        cumLog += dayLogRets[blkIdx + (h % blockLen)] ?? 0;
        cnyCumLog += cnyDayLogRets[blkIdx + (h % blockLen)] ?? 0;
        const pct = (Math.exp(cumLog) - 1) * 100;
        const cnyPct = (Math.exp(cnyCumLog) - 1) * 100;
        path.push(pct);
        cnyPath.push(cnyPct);
        if (pct > maxRet) maxRet = pct;
      }
      const ddInfo = computePathMaxDrawdown(path);
      const cnyDdInfo = computePathMaxDrawdown(cnyPath);
      sampleEntries.push({
        idx: -1,
        date: records[Math.max(0, asOfIdx - s)].date,
        filename: null,
        similarity: 50,
        rawWeight: 1,
        volScale: 1,
        scaledPath: path,
        cnyScaledPath: cnyPath,
        rawEndPct: round(path[horizon - 1], 2),
        scaledEndPct: round(path[horizon - 1], 2),
        maxDdPct: ddInfo.maxDrawdownPct,
        maxUnderwaterPct: ddInfo.maxUnderwaterPct,
        cnyMaxDdPct: cnyDdInfo.maxDrawdownPct,
        minRet: ddInfo.maxUnderwaterPct,
        maxRet,
      });
    }
  }

  // 2) 去重叠降权（O(N * overlapWindow) 索引查找）+ 计算 Kish 有效样本数 N_eff
  const sortedByWeight = sampleEntries.slice().sort((a, b) => b.rawWeight - a.rawWeight);
  const overlapWindow = Math.min(horizon, 10);
  const acceptedIdx = new Uint8Array(records.length + 1);
  for (const item of sortedByWeight) {
    let overlapPenalty = 1;
    if (item.idx >= 0) {
      const lo = Math.max(0, item.idx - overlapWindow + 1);
      const hi = Math.min(records.length - 1, item.idx + overlapWindow - 1);
      for (let k = lo; k <= hi; k++) {
        if (acceptedIdx[k]) {
          const gap = Math.abs(item.idx - k);
          overlapPenalty *= 0.45 + 0.55 * (gap / overlapWindow);
        }
      }
      acceptedIdx[item.idx] = 1;
    }
    item.weight = item.rawWeight * overlapPenalty;
  }

  const weights = sampleEntries.map(e => e.weight);
  const sumW = weights.reduce((s, w) => s + w, 0);
  const sumW2 = weights.reduce((s, w) => s + w * w, 0);
  const effectiveSampleSize = sumW2 > 0 ? round((sumW * sumW) / sumW2, 1) : 0;

  const shrinkageWeight = useBlockBootstrap
    ? 1.0
    : round(SHRINKAGE_K / (effectiveSampleSize + SHRINKAGE_K), 2);

  // F04 + v2.5 噪音自适应收缩：统一在样本权重层构造经验贝叶斯混合测度 w_mix = (1 - λ) * w_norm + λ / N
  // 红档门禁时完全收缩回无条件分布（λ = 1）；疑似钓鱼/高噪音消息日在短中期额外抬高 λ，防追高杀跌
  const prevRecForAudit = asOfIdx > 0 ? records[asOfIdx - 1] : null;
  const horizonNewsAudit = (horizon === 5 || horizon === 20)
    ? auditDailyTransmissionVeracity(curRec, curFeat, prevRecForAudit)
    : null;
  const noiseShrinkageBoost = horizonNewsAudit
    ? round(horizon === 5 ? horizonNewsAudit.noiseShrinkageBoost : horizonNewsAudit.noiseShrinkageBoost * 0.5, 2)
    : 0;
  const gateBlocked = curRec.gate && curRec.gate.actionable === false;
  const effectiveShrinkage = gateBlocked
    ? 1.0
    : round(clamp(shrinkageWeight + noiseShrinkageBoost, 0, 0.92), 2);
  const mixedWeights = mixSampleWeights(weights, effectiveShrinkage);
  const uncondWeights = sampleEntries.map(() => 1);

  const techS = curFeat.techScore;
  const fundS = curFeat.fundScore;
  const infoS = curFeat.infoScore;
  const compositeScore = Math.round(
    techS * pw.technical + fundS * pw.fundamental + infoS * pw.information,
  );

  // 3) 逐日基于同一 mixedWeights 计算 USD 与联合汇率 CNY 双层分位 P10/P25/P50/P75/P90
  const cnyPerUsdRatio = spot > 0 ? (spotCny / spot) : (usdCny / TROY_OUNCE_TO_GRAM);
  const QUANT_LIST = [0.10, 0.25, 0.50, 0.75, 0.90];
  const points = [];
  for (let h = 1; h <= horizon; h++) {
    const vals = sampleEntries.map(e => e.scaledPath[h - 1]);
    const cnyVals = sampleEntries.map(e => e.cnyScaledPath[h - 1]);
    let [p10, p25, p50, p75, p90] = weightedQuantilesBatch(vals, mixedWeights, QUANT_LIST);
    const [uP50] = weightedQuantilesBatch(vals, uncondWeights, [0.50]);

    let [cp10, cp25, cp50, cp75, cp90] = weightedQuantilesBatch(cnyVals, mixedWeights, QUANT_LIST);
    const [cuP50] = weightedQuantilesBatch(cnyVals, uncondWeights, [0.50]);

    p25 = Math.max(p10, p25);
    p50 = Math.max(p25, p50);
    p75 = Math.max(p50, p75);
    p90 = Math.max(p75, p90);

    cp25 = Math.max(cp10, cp25);
    cp50 = Math.max(cp25, cp50);
    cp75 = Math.max(cp50, cp75);
    cp90 = Math.max(cp75, cp90);

    const toUsd = (pct) => round(spot * (1 + pct / 100), 2);
    const toCny = (pct) => round(spotCny * (1 + pct / 100), 2);

    points.push({
      h,
      p10: round(p10, 2),
      p25: round(p25, 2),
      p50: round(p50, 2),
      p75: round(p75, 2),
      p90: round(p90, 2),
      baselineP50: round(uP50, 2),
      usd: { p10: toUsd(p10), p25: toUsd(p25), p50: toUsd(p50), p75: toUsd(p75), p90: toUsd(p90), baselineP50: toUsd(uP50) },
      cny: { p10: toCny(cp10), p25: toCny(cp25), p50: toCny(cp50), p75: toCny(cp75), p90: toCny(cp90), baselineP50: toCny(cuP50) },
    });
  }

  // 4) F01 + F04: 同一 mixedWeights 下计算严格几何峰谷回撤（MaxDD）、相对起点浮亏（MaxUnderwater）与收涨概率
  const maxDdSeries = sampleEntries.map(e => e.maxDdPct);
  const maxUwSeries = sampleEntries.map(e => e.maxUnderwaterPct);
  const cnyMaxDdSeries = sampleEntries.map(e => e.cnyMaxDdPct);
  const [maxDdP90Raw, maxDdP50Raw] = weightedQuantilesBatch(maxDdSeries, mixedWeights, [0.10, 0.50]);
  const [maxUwP90Raw, maxUwP50Raw] = weightedQuantilesBatch(maxUwSeries, mixedWeights, [0.10, 0.50]);
  const [cnyDdP90Raw, cnyDdP50Raw] = weightedQuantilesBatch(cnyMaxDdSeries, mixedWeights, [0.10, 0.50]);
  const maxDdP50 = round(maxDdP50Raw, 2);
  const maxDdP90 = round(maxDdP90Raw, 2);
  const maxUnderwaterP50 = round(maxUwP50Raw, 2);
  const maxUnderwaterP90 = round(maxUwP90Raw, 2);
  const cnyMaxDdP50 = round(cnyDdP50Raw, 2);
  const cnyMaxDdP90 = round(cnyDdP90Raw, 2);

  const upEndProb = weightedEventProbPct(sampleEntries, mixedWeights, e => e.scaledPath[horizon - 1] > 0, 1) ?? 50;

  // 5) 动态结构位 + 同一 mixedWeights 历史触达概率
  const bb = bollingerAt(closes, asOfIdx, 20, 2);
  const ma20 = smaAt(closes, asOfIdx, 20);
  const ma60 = smaAt(closes, asOfIdx, 60);
  const structureRaw = [];
  if (bb) {
    structureRaw.push({ label: '布林上轨', priceUsd: bb.upper });
    structureRaw.push({ label: 'MA20 (20日均线)', priceUsd: bb.middle });
    structureRaw.push({ label: '布林下轨', priceUsd: bb.lower });
  } else if (ma20) {
    structureRaw.push({ label: 'MA20 (20日均线)', priceUsd: ma20 });
  }
  if (ma60) {
    structureRaw.push({ label: 'MA60 (60日均线)', priceUsd: ma60 });
  }

  const structure = structureRaw.map(lvl => {
    const pctFromSpot = round(((lvl.priceUsd / spot) - 1) * 100, 2);
    const kind = pctFromSpot >= 0 ? 'resistance' : 'support';
    const touchProb = weightedEventProbPct(
      sampleEntries,
      mixedWeights,
      e => (kind === 'resistance' ? e.maxRet >= pctFromSpot : e.minRet <= pctFromSpot),
      0,
    );
    return {
      label: lvl.label,
      kind,
      pctFromSpot,
      priceUsd: round(lvl.priceUsd, 2),
      priceCny: round(lvl.priceUsd * cnyPerUsdRatio, 2),
      touchProb,
    };
  }).sort((a, b) => b.priceUsd - a.priceUsd);

  // 6) 前 5 个最相似历史交易日（可审计依据，附严格几何峰谷 MaxDD）
  const topAnalogs = useBlockBootstrap
    ? []
    : sampleEntries
        .filter(e => e.idx >= 0)
        .slice()
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 5)
        .map(e => ({
          date: e.date,
          filename: e.filename,
          similarity: e.similarity,
          rawEndPct: e.rawEndPct,
          scaledEndPct: e.scaledEndPct,
          maxDdPct: e.maxDdPct,
          volScale: e.volScale,
        }));

  // 7) 事后真实走势（仅用于历史日复盘叠加，人民币用实际汇率路径）
  const actualReplay = [];
  for (let h = 1; h <= horizon; h++) {
    const futIdx = asOfIdx + h;
    if (futIdx >= records.length) break;
    const pUsd = closes[futIdx];
    const pct = round(((pUsd - spot) / spot) * 100, 2);
    const cnyActual = records[futIdx].cnyPerGram != null
      ? round(records[futIdx].cnyPerGram, 2)
      : round(cnyCloses[futIdx], 2);
    actualReplay.push({
      h,
      date: records[futIdx].date,
      pct,
      usd: round(pUsd, 2),
      cny: cnyActual,
    });
  }

  const last = points[points.length - 1];
  const verdict = last.p50 >= 0.8
    ? { code: 'bullish', label: '震荡偏多' }
    : last.p50 <= -0.8
      ? { code: 'bearish', label: '震荡偏弱' }
      : { code: 'neutral', label: '区间震荡' };

  const degraded = useBlockBootstrap
    ? 'unconditional_only'
    : effectiveSampleSize >= 25
      ? 'full'
      : 'sparse';

  // 8) 短期/中期可查证据链（每一个判断均可追溯至具体官方数据源、5年分位与5年同类回测结果）
  const pctRank5y = (getter) => {
    const curVal = getter(curFeat);
    if (!Number.isFinite(curVal)) return 50;
    let le = 0;
    let cnt = 0;
    for (let i = 0; i <= asOfIdx; i++) {
      const v = getter(features[i]);
      if (Number.isFinite(v)) { cnt++; if (v <= curVal) le++; }
    }
    return cnt > 0 ? Math.round((le / cnt) * 100) : 50;
  };
  const empDaily = (pred, condLabel) => {
    const m = sampleEntries.filter(e => e.idx >= 0 && pred(features[e.idx]));
    if (m.length < 5) return `近 5 年同类状态样本较少，自动向全样本基准收缩`;
    const rets = m.map(x => x.rawEndPct).sort((a, b) => a - b);
    const med = round(rets[Math.floor(rets.length / 2)], 2);
    const win = Math.round((rets.filter(v => v > 0).length / rets.length) * 100);
    return `近5年「${condLabel}」共 ${m.length} 交易日：随后 ${horizon} 日中位涨跌 ${med >= 0 ? '+' : ''}${med}%，收涨概率 ${win}%`;
  };
  const factorAudit = [
    {
      dimensionKey: 'fundamental',
      dimensionCode: DIMENSION_META.fundamental.code,
      dimensionTitle: DIMENSION_META.fundamental.title,
      factor: '10Y TIPS 实际利率',
      currentValue: curRec.tipsYield != null ? `${round(curRec.tipsYield, 2)}%` : `${round(curFeat.tips, 2)}%`,
      sourceDate: `FRED DFII10 · ${curRec.macroObsDate || curRec.date}`,
      percentile25y: `近5年第 ${pctRank5y(f => f.tips)}% 分位`,
      impact: curFeat.tips >= 2.0 ? 'bear' : curFeat.tips <= 1.2 ? 'bull' : 'neutral',
      impactLabel: curFeat.tips >= 2.0 ? '高位压制' : curFeat.tips <= 1.2 ? '低利率支撑' : '中性均衡',
      empiricalStat: empDaily(
        f => (curFeat.tips >= 2.0 ? f.tips >= 2.0 : curFeat.tips <= 1.2 ? f.tips <= 1.2 : f.tips > 1.2 && f.tips < 2.0),
        curFeat.tips >= 2.0 ? 'TIPS≥2.0%' : curFeat.tips <= 1.2 ? 'TIPS≤1.2%' : 'TIPS 1.2–2.0%',
      ),
      mechanism: '美债实际利率直接锚定无息黄金的持有机会成本。',
    },
    {
      dimensionKey: 'fundamental',
      dimensionCode: DIMENSION_META.fundamental.code,
      dimensionTitle: DIMENSION_META.fundamental.title,
      factor: '美元指数 (DXY)',
      currentValue: curRec.dxy != null ? `${round(curRec.dxy, 2)}` : `${round(curFeat.dxy, 1)}`,
      sourceDate: `Yahoo DX-Y.NYB · ${curRec.date}`,
      percentile25y: `近5年第 ${pctRank5y(f => f.dxy)}% 分位`,
      impact: curFeat.dxy >= 105 ? 'bear' : curFeat.dxy <= 100 ? 'bull' : 'neutral',
      impactLabel: curFeat.dxy >= 105 ? '强美元压力' : curFeat.dxy <= 100 ? '弱美元顺风' : '中枢震荡',
      empiricalStat: empDaily(
        f => (curFeat.dxy >= 105 ? f.dxy >= 105 : curFeat.dxy <= 100 ? f.dxy <= 100 : f.dxy > 100 && f.dxy < 105),
        curFeat.dxy >= 105 ? 'DXY≥105' : curFeat.dxy <= 100 ? 'DXY≤100' : 'DXY 100–105',
      ),
      mechanism: '黄金以美元计价，美元走强往往压制短期上行动能。',
    },
    {
      dimensionKey: 'technical',
      dimensionCode: DIMENSION_META.technical.code,
      dimensionTitle: DIMENSION_META.technical.title,
      factor: '均线乖离 (相对 MA20)',
      currentValue: `${curFeat.ma20Dev >= 0 ? '+' : ''}${round(curFeat.ma20Dev, 2)}%`,
      sourceDate: `5年实盘日线 · ${curRec.date}`,
      percentile25y: `近5年第 ${pctRank5y(f => f.ma20Dev)}% 分位`,
      impact: curFeat.ma20Dev >= 3.5 ? 'bear' : curFeat.ma20Dev <= -2.5 ? 'bull' : curFeat.ma20Dev >= 0.5 ? 'bull' : 'neutral',
      impactLabel: curFeat.ma20Dev >= 3.5 ? '短线偏热' : curFeat.ma20Dev <= -2.5 ? '超跌修复' : curFeat.ma20Dev >= 0.5 ? '趋势偏强' : '均线附近',
      empiricalStat: empDaily(
        f => (curFeat.ma20Dev >= 2 ? f.ma20Dev >= 2 : curFeat.ma20Dev <= -2 ? f.ma20Dev <= -2 : Math.abs(f.ma20Dev) < 2),
        curFeat.ma20Dev >= 2 ? '高于MA20≥2%' : curFeat.ma20Dev <= -2 ? '低于MA20≥2%' : '贴近MA20 ±2%',
      ),
      mechanism: '刻画短期趋势强度与均值回归张力。',
    },
    {
      dimensionKey: 'quantitative',
      dimensionCode: DIMENSION_META.quantitative.code,
      dimensionTitle: DIMENSION_META.quantitative.title,
      factor: '20日实现日波动率 σ₀',
      currentValue: `${round(sigma0, 2)}%/日 (年化${round(sigma0 * Math.sqrt(252), 1)}%)`,
      sourceDate: `对数FHS 波动定标 · ${curRec.date}`,
      percentile25y: `近5年第 ${pctRank5y(f => f.volPct)}% 分位`,
      impact: 'neutral',
      impactLabel: sigma0 >= 1.5 ? '高波加宽风险带' : '常态带宽',
      empiricalStat: empDaily(
        f => (sigma0 >= 1.4 ? f.volPct >= 1.4 : f.volPct < 1.4),
        sigma0 >= 1.4 ? '高波动 σ≥1.4%/日' : '常态波动 σ<1.4%/日',
      ),
      mechanism: '去均值对数 FHS 仅用 σ₀ 缩放路径带宽与风控仓位，绝不给方向押注。',
    },
    {
      dimensionKey: 'capitalFlow',
      dimensionCode: DIMENSION_META.capitalFlow.code,
      dimensionTitle: DIMENSION_META.capitalFlow.title,
      factor: 'GLD ETF 与 CFTC 资金动量',
      currentValue: curRec.gld20dRet != null
        ? `GLD 20日 ${curRec.gld20dRet >= 0 ? '+' : ''}${curRec.gld20dRet}% · 资金分 ${curFeat.flow}`
        : `资金分 ${curFeat.flow}/100`,
      sourceDate: `Yahoo GLD & CFTC · ${curRec.cftcObsDate || curRec.date}`,
      percentile25y: `近5年第 ${pctRank5y(f => f.flow)}% 分位`,
      impact: curFeat.flow >= 58 ? 'bull' : curFeat.flow <= 42 ? 'bear' : 'neutral',
      impactLabel: curFeat.flow >= 58 ? '资金偏多' : curFeat.flow <= 42 ? '资金谨慎' : '资金平衡',
      empiricalStat: empDaily(
        f => (curFeat.flow >= 58 ? f.flow >= 58 : curFeat.flow <= 42 ? f.flow <= 42 : f.flow > 42 && f.flow < 58),
        curFeat.flow >= 58 ? '资金分≥58' : curFeat.flow <= 42 ? '资金分≤42' : '资金中性',
      ),
      mechanism: '追踪黄金 ETF 申赎动量、CFTC 4 周边际变动与内外盘资金流向。',
    },
    {
      dimensionKey: 'positioning',
      dimensionCode: DIMENSION_META.positioning.code,
      dimensionTitle: DIMENSION_META.positioning.title,
      factor: 'CFTC 3年持仓拥挤与 60日筹码成本',
      currentValue: curRec.cftcPercentile != null
        ? `CFTC 第${Math.round(curRec.cftcPercentile)}%分位${curRec.vwap60Usd ? ` · 60日成本 $${round(curRec.vwap60Usd, 0)}` : ''}`
        : (curRec.vwap60Usd ? `60日成本 $${round(curRec.vwap60Usd, 0)}` : '待更新'),
      sourceDate: `CFTC COT & 量权成本 · ${curRec.cftcObsDate || curRec.date}`,
      percentile25y: curRec.cftcPercentile != null ? `3年第 ${Math.round(curRec.cftcPercentile)}% 分位` : '—',
      impact: (curRec.cftcPercentile ?? 50) >= 85 ? 'bear' : (curRec.cftcPercentile ?? 50) <= 25 ? 'bull' : 'neutral',
      impactLabel: (curRec.cftcPercentile ?? 50) >= 85 ? '多头极度拥挤' : (curRec.cftcPercentile ?? 50) <= 25 ? '筹码出清' : '结构温和',
      empiricalStat: empDaily(
        f => (curFeat.flow >= 58 ? f.flow >= 58 : f.flow < 58),
        curFeat.flow >= 58 ? '资金偏强环境' : '常态筹码环境',
      ),
      mechanism: '区分存量拥挤度（极端反向）与增量资金流，避免多头极端拥挤时追高。',
    },
  ];
  const invalidationTriggers = [
    {
      metric: '收盘价结构位',
      current: `$${round(spot, 1)}/oz`,
      trigger: ma20 ? `有效跌破 MA20 ($${round(ma20, 1)}) 或放量突破布林上轨 ($${round(bb?.upper || spot * 1.03, 1)})` : '突破近20日区间极值',
      meaning: '决定短线震荡中枢是否发生方向性切换。',
    },
    {
      metric: '10Y TIPS 实际利率',
      current: `${round(curFeat.tips, 2)}%`,
      trigger: '单周变动超过 ±20bp',
      meaning: '若美债实际利率急涨/急跌，会迅速打破历史静态相似度权重。',
    },
    {
      metric: '20日实现波动率',
      current: `${round(sigma0, 2)}%/日`,
      trigger: '突破 1.80%/日（年化 >28%）',
      meaning: '进入高波避险/去杠杆态，需自动收紧波段仓位、改回定投纪律。',
    },
  ];

  return {
    horizon,
    isLongTerm: false,
    unitType: 'day',
    label: pw.label,
    trackName: pw.trackName,
    degraded,
    compositeScore,
    verdict,
    pillarWeights: pw,
    sampleStats: {
      rawSampleSize: sampleEntries.length,
      effectiveSampleSize,
      shrinkageWeight: effectiveShrinkage,
      noiseShrinkageBoost,
      newsVeracityStatus: horizonNewsAudit?.status || 'quiet',
      currentVolPct: round(sigma0, 2),
      annualizedVolPct: round(sigma0 * Math.sqrt(252), 1),
      volUnit: '%/日',
      method: useBlockBootstrap ? 'demeaned_log_fhs_block_bootstrap' : 'demeaned_log_fhs_mixed_weights',
    },
    summary: {
      endP50Pct: last.p50,
      endP10Pct: last.p10,
      endP25Pct: last.p25,
      endP75Pct: last.p75,
      endP90Pct: last.p90,
      baselineEndP50Pct: last.baselineP50,
      endUsd: last.usd,
      endCny: last.cny,
      maxDdP50,
      maxDdP90,
      maxUnderwaterP50,
      maxUnderwaterP90,
      cnyMaxDdP50,
      cnyMaxDdP90,
      cnyBasisNote: CNY_BASIS_NOTE,
      upEndProb,
    },
    points,
    structure,
    topAnalogs,
    actualReplay,
    evidence: {
      factorAudit,
      scenarios: null,
      invalidationTriggers,
      methodologyNote: `基于近 5 年连续实盘日线（${records[0].date} ～ ${curRec.date}，严格零前视泄漏），采用去均值单步对数 FHS + 严格几何峰谷回撤 + 9 项特征 Z-score 相似核（N_eff=${effectiveSampleSize}）+ 样本权重层 ${Math.round(effectiveShrinkage * 100)}% 经验贝叶斯混合（分位数与胜率同源完全自洽）；人民币路径纳入历史 USD/CNY 联合汇率波动。`,
    },
  };
}

function buildForecastAtIndex(records, closes, cnyCloses, features, asOfIdx, monthlyRecords) {
  const rec = records[asOfIdx];
  const spotUsd = closes[asOfIdx];
  const usdCny = rec.usdCnyRate || DEFAULT_USD_CNY;
  const spotCny = rec.cnyPerGram != null ? rec.cnyPerGram : round((spotUsd * usdCny) / TROY_OUNCE_TO_GRAM, 2);

  // 历史段（近 60 个交易日，严格以今日 spot 为 0% 基准，零跳空；人民币用历史实际汇率路径）
  const histStart = Math.max(0, asOfIdx - 59);
  const history = [];
  for (let i = histStart; i <= asOfIdx; i++) {
    const pUsd = closes[i];
    const ma20Val = smaAt(closes, i, 20);
    const ma20CnyVal = smaAt(cnyCloses, i, 20);
    const pCny = i === asOfIdx ? spotCny : round(cnyCloses[i], 2);
    history.push({
      date: records[i].date,
      usd: round(pUsd, 2),
      cny: pCny,
      pct: round(((pUsd - spotUsd) / spotUsd) * 100, 2),
      ma20Usd: ma20Val != null ? round(ma20Val, 2) : null,
      ma20Cny: ma20CnyVal != null ? round(ma20CnyVal, 2) : null,
      ma20Pct: ma20Val != null ? round(((ma20Val - spotUsd) / spotUsd) * 100, 2) : null,
    });
  }

  const bb = bollingerAt(closes, asOfIdx, 20, 2);
  const ma20 = smaAt(closes, asOfIdx, 20);
  const ma50 = smaAt(closes, asOfIdx, 50);
  const ma60 = smaAt(closes, asOfIdx, 60);

  const horizons = {};
  const pillarsByHorizon = {};
  const eightDimensionsByHorizon = {};
  const historyByHorizon = {};
  const prevRec = asOfIdx > 0 ? records[asOfIdx - 1] : null;
  for (const h of HORIZONS) {
    const hData = buildSingleHorizonForecast(records, closes, cnyCloses, features, asOfIdx, h, spotUsd, spotCny, usdCny);
    const eightD = buildDailyEightDimensions(rec, features[asOfIdx], bb, ma20, ma60, spotUsd, String(h), hData, prevRec);
    hData.compositeScore = eightD.compositeScore;
    horizons[String(h)] = hData;
    pillarsByHorizon[String(h)] = buildThreePillars(rec, features[asOfIdx], bb, ma20, ma50, ma60, HORIZON_PILLAR_WEIGHTS[h]);
    eightDimensionsByHorizon[String(h)] = eightD;
  }

  // 叠加 26 年真实月线驱动的 1年 / 2年 / 5年 长期宏观走势预测
  let monthlyStats = null;
  if (Array.isArray(monthlyRecords) && monthlyRecords.length >= 72) {
    const longTerm = buildLongTermForecastBundle({
      monthlyRecords,
      asOfDate: rec.date,
      spotUsd,
      spotCny,
      usdCny,
      dailyRec: rec,
    });
    if (longTerm) {
      Object.assign(horizons, longTerm.horizons);
      Object.assign(pillarsByHorizon, longTerm.pillarsByHorizon);
      if (longTerm.eightDimensionsByHorizon) {
        Object.assign(eightDimensionsByHorizon, longTerm.eightDimensionsByHorizon);
      }
      Object.assign(historyByHorizon, longTerm.historyByHorizon);
      monthlyStats = longTerm.monthlyStats;
    }
  }

  const gateHint = rec.gate && !rec.gate.actionable
    ? '当前数据门禁未通过（红档）：走势图已自动完全收缩回无条件基准分布，仅供研究参考，不构成操作建议。'
    : rec.gate?.tier === 'yellow'
      ? '数据黄档：预测区间可辅助阅读，仓位仍以短期门禁与定投纪律为准。'
      : null;

  return {
    asOf: rec.date,
    filename: rec.filename || null,
    hasAiReport: Boolean(rec.hasAiReport ?? rec.filename),
    dataSource: rec.dataSource || (rec.filename ? 'ai_report_fused' : 'market_live_fused'),
    priceSource: rec.priceSource || (rec.filename ? 'report_md' : 'yahoo_gc'),
    macroObsDate: rec.macroObsDate || null,
    cftcObsDate: rec.cftcObsDate || null,
    totalTradingDays: records.length,
    datasetDateRange: {
      from: records[0].date,
      to: records[records.length - 1].date,
    },
    monthlyStats,
    isLatest: asOfIdx === records.length - 1,
    prevDate: asOfIdx > 10 ? records[asOfIdx - 1].date : null,
    nextDate: asOfIdx < records.length - 1 ? records[asOfIdx + 1].date : null,
    spot: {
      usd: round(spotUsd, 2),
      cny: round(spotCny, 2),
      cnySource: rec.cnySource || 'converted',
      usdCnyRate: usdCny,
      cnyBasisNote: CNY_BASIS_NOTE,
    },
    gate: rec.gate,
    gateHint,
    position: rec.position,
    macroLabel: rec.macroLabel,
    history,
    historyByHorizon,
    horizons,
    pillarsByHorizon,
    eightDimensionsByHorizon,
    disclaimer: '短中期（5/20/60日）基于近5年实盘日线去均值对数 FHS，长期（1/2/5年）基于26年连续月线与 1971+ 实际购买力先验锚；全框架采用三基+五专八维正交体系，所有结论均附历史样本与观测日期可查，不构成投资建议。',
  };
}

/**
 * 为指定日期构建完整的黄金走势预测包（每日一图，零前视泄漏）
 * @param {Array} records 按日期升序排列的完整历史日线数据集
 * @param {string} [asOfDate] 默认最新一天
 * @param {Array} [monthlyRecords] 可选 25 年月线数据集（传入后自动生成 1y / 2y / 5y 长期预测）
 */
function buildDailyGoldForecast(records, asOfDate, monthlyRecords) {
  if (!records || records.length < 10) return null;

  let asOfIdx = records.length - 1;
  if (asOfDate) {
    const found = records.findIndex(r => r.date === asOfDate);
    if (found >= 0) asOfIdx = found;
  }

  const closes = records.map(r => r.londonClose);
  const cnyCloses = records.map(r => (r.londonClose * (r.usdCnyRate || DEFAULT_USD_CNY)) / TROY_OUNCE_TO_GRAM);
  const features = records.map((_, i) => extractCausalFeatures(records, closes, i));

  return buildForecastAtIndex(records, closes, cnyCloses, features, asOfIdx, monthlyRecords);
}

let _archiveCache = null;

/** 生成每日预测存档列表（预计算特征向量一次，并按数据集指纹缓存） */
function buildDailyForecastArchive(records, limit = 18) {
  if (!records || records.length < 15) return [];
  const last = records[records.length - 1];
  const sig = `${records.length}:${last.date}:${last.londonClose}:${limit}`;
  if (_archiveCache && _archiveCache.sig === sig) {
    return _archiveCache.list;
  }

  const closes = records.map(r => r.londonClose);
  const cnyCloses = records.map(r => (r.londonClose * (r.usdCnyRate || DEFAULT_USD_CNY)) / TROY_OUNCE_TO_GRAM);
  const features = records.map((_, i) => extractCausalFeatures(records, closes, i));

  const list = [];
  const start = Math.max(15, records.length - limit);
  for (let i = records.length - 1; i >= start; i--) {
    const rec = records[i];
    const spotUsd = closes[i];
    const usdCny = rec.usdCnyRate || DEFAULT_USD_CNY;
    const spotCny = rec.cnyPerGram != null ? rec.cnyPerGram : round((spotUsd * usdCny) / TROY_OUNCE_TO_GRAM, 2);

    const h5 = buildSingleHorizonForecast(records, closes, cnyCloses, features, i, 5, spotUsd, spotCny, usdCny);
    const h20 = buildSingleHorizonForecast(records, closes, cnyCloses, features, i, 20, spotUsd, spotCny, usdCny);
    const actual5 = h5.actualReplay.length >= 5 ? h5.actualReplay[4] : null;
    const inBand5 = actual5 != null
      ? (actual5.pct >= h5.summary.endP10Pct && actual5.pct <= h5.summary.endP90Pct)
      : null;

    list.push({
      date: rec.date,
      filename: rec.filename || null,
      hasAiReport: Boolean(rec.hasAiReport ?? rec.filename),
      spotUsd: round(spotUsd, 2),
      spotCny: round(spotCny, 2),
      verdict5: h5.verdict,
      p50_5d: h5.summary.endP50Pct,
      p50_20d: h20.summary.endP50Pct,
      p10_5d: h5.summary.endP10Pct,
      p90_5d: h5.summary.endP90Pct,
      actual5dPct: actual5 ? actual5.pct : null,
      inBand5,
      gateTier: rec.gate?.tier || 'green',
    });
  }
  _archiveCache = { sig, list };
  return list;
}

module.exports = {
  HORIZONS,
  HORIZON_PILLAR_WEIGHTS,
  weightedQuantile,
  realizedDailyVolPctAt,
  buildDailyGoldForecast,
  buildDailyForecastArchive,
};
