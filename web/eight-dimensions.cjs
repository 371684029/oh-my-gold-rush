'use strict';

// GoldRush v2.6 八维全景分析与预测 Web 适配器
// 权重矩阵与维度元数据直接引用自 scripts/sync-web-cjs.mjs 自动生成的 eight-dimensions-core.cjs，零人工双写。
const {
  HORIZON_8D_WEIGHTS: CORE_WEIGHTS,
  DIMENSION_META,
} = require('./eight-dimensions-core.cjs');

const HORIZON_8D_WEIGHTS = {
  '5':  CORE_WEIGHTS['5d'],
  '20': CORE_WEIGHTS['20d'],
  '60': CORE_WEIGHTS['60d'],
  '5d': CORE_WEIGHTS['5d'],
  '20d': CORE_WEIGHTS['20d'],
  '60d': CORE_WEIGHTS['60d'],
  '1y': CORE_WEIGHTS['1y'],
  '2y': CORE_WEIGHTS['2y'],
  '5y': CORE_WEIGHTS['5y'],
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
