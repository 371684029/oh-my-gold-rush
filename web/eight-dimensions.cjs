'use strict';

// GoldRush v2.4 八维全景分析与预测统一契约（CJS 镜像，供 web/ 预测引擎与页面渲染调用）
// 与 src/utils/eight-dimensions.ts 保持完全一致的权重矩阵与正交定义

const HORIZON_8D_WEIGHTS = {
  '5':   { fundamental: 0.05, news: 0.15, technical: 0.20, capitalFlow: 0.20, policy: 0.00, sentiment: 0.15, positioning: 0.07, quantitative: 0.18 },
  '20':  { fundamental: 0.20, news: 0.05, technical: 0.12, capitalFlow: 0.18, policy: 0.10, sentiment: 0.05, positioning: 0.15, quantitative: 0.15 },
  '60':  { fundamental: 0.25, news: 0.00, technical: 0.10, capitalFlow: 0.15, policy: 0.15, sentiment: 0.00, positioning: 0.20, quantitative: 0.15 },
  '1y':  { fundamental: 0.30, news: 0.00, technical: 0.08, capitalFlow: 0.08, policy: 0.22, sentiment: 0.00, positioning: 0.17, quantitative: 0.15 },
  '2y':  { fundamental: 0.35, news: 0.00, technical: 0.05, capitalFlow: 0.05, policy: 0.25, sentiment: 0.00, positioning: 0.15, quantitative: 0.15 },
  '5y':  { fundamental: 0.35, news: 0.00, technical: 0.05, capitalFlow: 0.05, policy: 0.25, sentiment: 0.00, positioning: 0.15, quantitative: 0.15 },
};

const DIMENSION_ORDER = [
  'fundamental',
  'news',
  'technical',
  'capitalFlow',
  'policy',
  'sentiment',
  'positioning',
  'quantitative',
];

const DIMENSION_META = {
  fundamental:  { code: 'B1', category: 'base',        title: '基本面', subtitle: '实际利率 · 通胀估值 · 美元中枢' },
  news:         { code: 'B2', category: 'base',        title: '消息面', subtitle: '事件三通道传导 · 预期差催化' },
  technical:    { code: 'B3', category: 'base',        title: '技术面', subtitle: '多周期均线 · MACD · 结构位' },
  capitalFlow:  { code: 'S1', category: 'specialized', title: '资金面', subtitle: 'GLD/ETF · CFTC 4W边际 · 上海溢价' },
  policy:       { code: 'S2', category: 'specialized', title: '政策面', subtitle: '联储周期 · 央行购金 · 监管制度' },
  sentiment:    { code: 'S3', category: 'specialized', title: '情绪面', subtitle: 'GVZ/VIX · RSI极端段 · 羊群警示' },
  positioning:  { code: 'S4', category: 'specialized', title: '筹码面', subtitle: 'CFTC 3Y拥挤 · VWAP成本 · AISC底盘' },
  quantitative: { code: 'S5', category: 'specialized', title: '量化面', subtitle: '对数FHS · ATR风控 · 统计显著性' },
};

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round(v, digits = 2) {
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}

function toDir(score) {
  if (score == null || !Number.isFinite(score)) return { code: 'neutral', label: '缺数' };
  if (score >= 58) return { code: 'bullish', label: '偏多' };
  if (score <= 42) return { code: 'bearish', label: '偏空' };
  return { code: 'neutral', label: '中性' };
}

/**
 * 为指定视野装配完整八维输出包：
 * - 计算有效权重重归一后的综合分与覆盖度
 * - 标记当前视野权重最高的 Top 4 主导维度（isDominant: true），其余为可展开辅助维度
 */
function assembleHorizonEightDimensions(rawDimsByKey, horizonKey) {
  const weights = HORIZON_8D_WEIGHTS[String(horizonKey)] || HORIZON_8D_WEIGHTS['20'];
  let activeW = 0;
  const missingDimensions = [];

  for (const key of DIMENSION_ORDER) {
    const w = weights[key] || 0;
    const d = rawDimsByKey[key];
    if (w > 0) {
      if (d && d.score != null && Number.isFinite(d.score) && (d.coverage ?? 1) > 0) {
        activeW += w;
      } else {
        missingDimensions.push(key);
      }
    }
  }

  let totalScore = 0;
  const items = DIMENSION_ORDER.map(key => {
    const meta = DIMENSION_META[key];
    const w = weights[key] || 0;
    const raw = rawDimsByKey[key] || {};
    const valid = w > 0 && raw.score != null && Number.isFinite(raw.score) && (raw.coverage ?? 1) > 0;
    const effW = valid && activeW > 0 ? w / activeW : 0;
    if (valid) totalScore += raw.score * effW;
    const score = raw.score != null && Number.isFinite(raw.score) ? Math.round(clamp(raw.score, 0, 100)) : null;
    const dir = toDir(score);

    return {
      key,
      code: meta.code,
      category: meta.category,
      title: meta.title,
      subtitle: raw.subtitle || meta.subtitle,
      score,
      codeDir: dir.code,
      label: dir.label,
      weightPct: Math.round(w * 100),
      effectiveWeightPct: Math.round(effW * 100),
      coverage: round(raw.coverage ?? (score != null ? 1 : 0), 2),
      isDominant: false,
      metrics: Array.isArray(raw.metrics) ? raw.metrics : [],
      summary: raw.summary || `${meta.title}暂无足够数据。`,
      warning: raw.warning || null,
      veracityBadge: raw.veracityBadge || null,
      veracityStatus: raw.veracityStatus || null,
      dataFreshness: raw.dataFreshness || null,
    };
  });

  // 按当前视野名义权重选出 Top 4 主导维度
  const byWeight = items
    .map((item, idx) => ({ idx, w: item.weightPct, valid: item.score != null }))
    .sort((a, b) => (b.w - a.w) || (Number(b.valid) - Number(a.valid)) || (a.idx - b.idx));

  let domCount = 0;
  for (const entry of byWeight) {
    if (domCount < 4 && entry.w > 0) {
      items[entry.idx].isDominant = true;
      domCount++;
    }
  }

  const coverage = round(activeW, 4);
  const compositeScore = activeW > 0 ? Math.round(clamp(totalScore, 0, 100)) : 50;
  const degradedWarning = coverage < 0.70
    ? `当前视野八维有效权重覆盖 ${Math.round(coverage * 100)}%（缺 ${missingDimensions.map(k => DIMENSION_META[k].title).join('/')}），已自动重归一`
    : null;

  return {
    horizon: String(horizonKey),
    compositeScore,
    direction: toDir(compositeScore),
    coverage,
    degradedWarning,
    missingDimensions,
    dimensions: items,
    dominant: items.filter(i => i.isDominant).sort((a, b) => b.weightPct - a.weightPct),
    auxiliary: items.filter(i => !i.isDominant),
  };
}

module.exports = {
  HORIZON_8D_WEIGHTS,
  DIMENSION_ORDER,
  DIMENSION_META,
  assembleHorizonEightDimensions,
};
