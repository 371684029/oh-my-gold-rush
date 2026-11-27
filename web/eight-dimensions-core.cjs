// AUTO-GENERATED from src/utils/eight-dimensions.ts by scripts/sync-web-cjs.mjs — DO NOT EDIT MANUALLY
// Run `npm run sync:web` after modifying src/utils/eight-dimensions.ts.
"use strict";
// GoldRush v2.4 八维全景分析与预测统一契约（「三基 + 五专」正交体系）
// B1 基本面 / B2 消息面 / B3 技术面 + S1 资金面 / S2 政策面 / S3 情绪面 / S4 筹码面 / S5 量化面
// 核心铁律：
//   1. 任何指标只归属一个维度（零跨维重复计分）
//   2. 按时间尺度实施动态权重（60D/1Y/2Y/5Y 中消息面 B2 与情绪面 S3 权重严格为 0%）
//   3. 缺失维度自动剔除并重归一，覆盖度 < 70% 触发降级提示
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_HEALTHY_8D_COVERAGE = exports.DIMENSION_METRIC_OWNERSHIP = exports.DIMENSION_META = exports.HORIZON_8D_WEIGHTS = void 0;
exports.computeHorizonEightDimensionScore = computeHorizonEightDimensionScore;
exports.makeDimensionItem = makeDimensionItem;
const decision_thresholds_js_1 = require("./decision-thresholds.cjs");
/** §5.3 多时间尺度八维动态权重矩阵（每行严格合计 = 1.00；60D/1Y/2Y/5Y 中 news & sentiment 严格为 0） */
exports.HORIZON_8D_WEIGHTS = {
    '5d': {
        fundamental: 0.05,
        news: 0.15,
        technical: 0.20,
        capitalFlow: 0.20,
        policy: 0.00,
        sentiment: 0.15,
        positioning: 0.07,
        quantitative: 0.18,
    },
    '20d': {
        fundamental: 0.20,
        news: 0.05,
        technical: 0.12,
        capitalFlow: 0.18,
        policy: 0.10,
        sentiment: 0.05,
        positioning: 0.15,
        quantitative: 0.15,
    },
    '60d': {
        fundamental: 0.25,
        news: 0.00,
        technical: 0.10,
        capitalFlow: 0.15,
        policy: 0.15,
        sentiment: 0.00,
        positioning: 0.20,
        quantitative: 0.15,
    },
    '1y': {
        fundamental: 0.30,
        news: 0.00,
        technical: 0.08,
        capitalFlow: 0.08,
        policy: 0.22,
        sentiment: 0.00,
        positioning: 0.17,
        quantitative: 0.15,
    },
    '2y': {
        fundamental: 0.35,
        news: 0.00,
        technical: 0.05,
        capitalFlow: 0.05,
        policy: 0.25,
        sentiment: 0.00,
        positioning: 0.15,
        quantitative: 0.15,
    },
    '5y': {
        fundamental: 0.35,
        news: 0.00,
        technical: 0.05,
        capitalFlow: 0.05,
        policy: 0.25,
        sentiment: 0.00,
        positioning: 0.15,
        quantitative: 0.15,
    },
};
exports.DIMENSION_META = {
    fundamental: { code: 'B1', category: 'base', title: '基本面', subtitle: '实际利率 · 通胀估值 · 美元中枢' },
    news: { code: 'B2', category: 'base', title: '消息面', subtitle: '事件三通道传导 · 预期差催化' },
    technical: { code: 'B3', category: 'base', title: '技术面', subtitle: '多周期均线 · MACD · 结构位' },
    capitalFlow: { code: 'S1', category: 'specialized', title: '资金面', subtitle: 'GLD/ETF · CFTC 4W边际 · 上海溢价' },
    policy: { code: 'S2', category: 'specialized', title: '政策面', subtitle: '联储周期 · 央行购金 · 监管制度' },
    sentiment: { code: 'S3', category: 'specialized', title: '情绪面', subtitle: 'GVZ/VIX · RSI极端段 · 羊群警示' },
    positioning: { code: 'S4', category: 'specialized', title: '筹码面', subtitle: 'CFTC 3Y拥挤 · VWAP成本 · AISC底盘' },
    quantitative: { code: 'S5', category: 'specialized', title: '量化面', subtitle: '对数FHS · ATR风控 · 统计显著性' },
};
/** 静态正交指标归属表 — 单测用于验证零指标跨维重复计分 */
exports.DIMENSION_METRIC_OWNERSHIP = {
    fundamental: ['tips_level_bp', 'cpi_yoy', 'breakeven_inflation', 'real_gold_cpi_pct', 'dxy_ma60_dev'],
    news: ['event_transmission_rate', 'event_transmission_usd', 'event_transmission_haven', 'macro_calendar_surprise'],
    technical: ['ma_structure', 'macd_momentum', 'bollinger_structure', 'price_support_resistance'],
    capitalFlow: ['gld_flow', 'cftc_delta_4w', 'sge_premium', 'comex_vol_flow', 'cn_etf_flow'],
    policy: ['fed_rate_expectation', 'pboc_reserve_cycle', 'yield_curve_cycle', 'regulatory_stance'],
    sentiment: ['gvz_vix_regime', 'rsi_extreme_behavior', 'herding_overreaction'],
    positioning: ['cftc_crowding_3y', 'cost_anchor_profit_ratio', 'aisc_supply_floor'],
    quantitative: ['quant_composite_score', 'fhs_prob_path', 'wilder_atr_risk_band', 'rank_icir_calibration'],
};
exports.MIN_HEALTHY_8D_COVERAGE = 0.70;
function round(v, digits = 2) {
    const m = Math.pow(10, digits);
    return Math.round(v * m) / m;
}
/**
 * 按指定时间视野动态加权合成八维分数：
 * - 权重为 0 的维度（如 1Y/2Y/5Y 的消息面与情绪面）严格不参与；
 * - 有权重但缺数（score == null 或 coverage <= 0）的维度自动剔除，按剩余权重重归一；
 * - 有效覆盖度 < 70% 时返回降级提示。
 */
function computeHorizonEightDimensionScore(profile, horizon) {
    const weights = exports.HORIZON_8D_WEIGHTS[horizon];
    const keys = Object.keys(weights);
    let activeWeightSum = 0;
    const missingDimensions = [];
    for (const key of keys) {
        const w = weights[key];
        if (w <= 0)
            continue;
        const item = profile[key];
        if (item && item.score != null && Number.isFinite(item.score) && item.coverage > 0) {
            activeWeightSum += w;
        }
        else {
            missingDimensions.push(key);
        }
    }
    let total = 0;
    const rankedRaw = keys.map(key => {
        const w = weights[key];
        const meta = exports.DIMENSION_META[key];
        const item = profile[key];
        const valid = w > 0 && item != null && item.score != null && Number.isFinite(item.score) && item.coverage > 0;
        const effW = valid && activeWeightSum > 0 ? w / activeWeightSum : 0;
        if (valid && item?.score != null) {
            total += item.score * effW;
        }
        return {
            key,
            code: meta.code,
            category: meta.category,
            title: meta.title,
            score: item?.score ?? null,
            direction: item?.direction ?? 'neutral',
            nominalWeightPct: Math.round(w * 100),
            effectiveWeightPct: Math.round(effW * 100),
            isDominant: false,
            coverage: item?.coverage ?? 0,
        };
    });
    // 排序：名义权重高者优先，同权按固定顺序
    const sorted = rankedRaw.slice().sort((a, b) => b.nominalWeightPct - a.nominalWeightPct);
    let domCount = 0;
    for (const row of sorted) {
        if (domCount < 4 && row.nominalWeightPct > 0) {
            row.isDominant = true;
            domCount++;
        }
    }
    const coverage = round(activeWeightSum, 4);
    const score = activeWeightSum > 0 ? Math.round(Math.max(0, Math.min(100, total))) : 50;
    const degradedWarning = coverage < exports.MIN_HEALTHY_8D_COVERAGE
        ? `当前视野(${horizon})八维有效权重覆盖仅 ${Math.round(coverage * 100)}%（缺失 ${missingDimensions.map(k => exports.DIMENSION_META[k].title).join('/')}），已自动重归一但参考度下降。`
        : null;
    return {
        horizon,
        score,
        direction: (0, decision_thresholds_js_1.directionFromScore)(score),
        coverage,
        degradedWarning,
        missingDimensions,
        rankedDimensions: sorted,
    };
}
/** 构造单个标准化维度对象 */
function makeDimensionItem(key, partial) {
    const meta = exports.DIMENSION_META[key];
    const score = partial.score != null && Number.isFinite(partial.score)
        ? Math.round(Math.max(0, Math.min(100, partial.score)))
        : null;
    return {
        key,
        code: meta.code,
        category: meta.category,
        title: meta.title,
        subtitle: meta.subtitle,
        score,
        direction: score != null ? (0, decision_thresholds_js_1.directionFromScore)(score) : 'neutral',
        coverage: round(Math.max(0, Math.min(1, partial.coverage)), 4),
        metrics: partial.metrics ?? [],
        keyPoints: partial.keyPoints ?? [],
        counterPoints: partial.counterPoints ?? [],
        sources: partial.sources ?? [],
        dataFreshness: partial.dataFreshness ?? '未观测',
        summary: partial.summary ?? `${meta.title}暂无足够数据。`,
    };
}
