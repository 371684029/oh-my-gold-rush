// AUTO-GENERATED from src/utils/regime-kernel.ts by scripts/sync-web-cjs.mjs — DO NOT EDIT MANUALLY
// Run `npm run sync:web` after modifying src/utils/regime-kernel.ts.
"use strict";
// GoldRush v2.6 — 分宏观体制（Regime-Aware）动态特征核（严格因果零前视）
// 根据截止 asOf 的宏观状态（实际利率水平与趋势、美元强弱、波动率/GVZ、收益率曲线），
// 对 5/20/60 日相似历史检索的 9 维特征距离权重做带安全收缩（shrinkage toward base）的轻量动态倾斜，
// 降低牛熊/加息-降息体制切换时的权重滞后，同时避免过拟合。
Object.defineProperty(exports, "__esModule", { value: true });
exports.BASE_DIST_WEIGHTS_MID = exports.BASE_DIST_WEIGHTS_5D = void 0;
exports.classifyCausalMacroRegime = classifyCausalMacroRegime;
exports.buildRegimeAwareWeights = buildRegimeAwareWeights;
const FEATURE_LABELS = {
    tips: '实际利率(TIPS)',
    dxy: '美元指数(DXY)',
    ma20Dev: '20日均线偏离',
    ma50Dev: '50日均线偏离',
    rsi: 'RSI(14)动量',
    volPct: '波动率状态',
    flow: '主力资金流',
    quantScore: '量化综合分',
    midTermScore: '中期慢变量',
};
exports.BASE_DIST_WEIGHTS_5D = {
    ma20Dev: 1.5,
    rsi: 1.2,
    volPct: 1.4,
    quantScore: 1.5,
    tips: 1.1,
    dxy: 1.1,
    flow: 1.0,
    midTermScore: 0.4,
    ma50Dev: 0.5,
};
exports.BASE_DIST_WEIGHTS_MID = {
    tips: 2.0,
    dxy: 1.8,
    midTermScore: 1.8,
    ma50Dev: 1.4,
    flow: 1.4,
    volPct: 1.1,
    ma20Dev: 0.5,
    rsi: 0.3,
    quantScore: 0.5,
};
const REGIME_TILTS = {
    // 高实际利率紧缩体制：TIPS、DXY、估值/中期慢变量主导定价
    tightening_headwind: {
        tips: 1.45,
        dxy: 1.35,
        midTermScore: 1.20,
        ma50Dev: 1.10,
        flow: 0.90,
        volPct: 1.05,
        ma20Dev: 0.85,
        rsi: 0.80,
        quantScore: 0.95,
    },
    // 降息/实际利率下行体制：趋势动量、资金流（ETF/CFTC）与中期慢变量共振
    easing_tailwind: {
        tips: 1.25,
        dxy: 1.10,
        flow: 1.40,
        ma50Dev: 1.25,
        ma20Dev: 1.20,
        quantScore: 1.15,
        midTermScore: 1.20,
        volPct: 0.90,
        rsi: 0.85,
    },
    // 滞胀/高波避险体制：波动率状态、资金避险流与超买超卖反转权重抬升，利率压制钝化
    stagflation_haven: {
        volPct: 1.55,
        flow: 1.40,
        rsi: 1.25,
        ma20Dev: 1.15,
        tips: 0.85,
        dxy: 0.90,
        ma50Dev: 0.95,
        quantScore: 1.10,
        midTermScore: 0.95,
    },
    // 均衡震荡体制：维持原始基础权重
    balanced_neutral: {
        tips: 1.0,
        dxy: 1.0,
        ma20Dev: 1.0,
        ma50Dev: 1.0,
        rsi: 1.0,
        volPct: 1.0,
        flow: 1.0,
        quantScore: 1.0,
        midTermScore: 1.0,
    },
};
const REGIME_META = {
    tightening_headwind: {
        label: '实际利率紧缩体制',
        badge: '紧缩核',
        rationale: '实际利率偏高或上行叠加美元偏强，相似检索自动提高 TIPS 与 DXY 权重',
    },
    easing_tailwind: {
        label: '宽松顺风趋势体制',
        badge: '顺风核',
        rationale: '实际利率回落或美元转弱，相似检索自动提高主力资金流与均线趋势权重',
    },
    stagflation_haven: {
        label: '高波避险/滞胀体制',
        badge: '避险核',
        rationale: '波动率（实现波动/GVZ）高企或曲线倒挂，相似检索自动提高波动状态与资金避险权重',
    },
    balanced_neutral: {
        label: '均衡震荡体制',
        badge: '标准核',
        rationale: '宏观与波动处于常态区间，沿用基础正交特征权重',
    },
};
function round(v, digits = 2) {
    const m = Math.pow(10, digits);
    return Math.round(v * m) / m;
}
/** 严格因果判别当前宏观体制（仅依赖 <= asOf 的可观测量） */
function classifyCausalMacroRegime(input) {
    const tips = input.tips ?? null;
    const tipsDelta = input.tipsDelta60dBp ?? null;
    const dxyDev = input.dxyDevMa60 ?? null;
    const volPct = input.volPct ?? null;
    const gvz = input.gvz ?? null;
    const spread = input.yieldSpread2s10s ?? null;
    const highVol = (gvz != null && gvz >= 22) || (volPct != null && volPct >= 1.55);
    const curveStress = spread != null && spread < -0.15;
    // 1) 高波/滞胀避险优先识别（危机阶段利率相关性常阶段性钝化）
    if (highVol && (curveStress || (volPct != null && volPct >= 1.75) || (gvz != null && gvz >= 25))) {
        return 'stagflation_haven';
    }
    // 2) 实际利率紧缩逆风：TIPS 偏高且未显著下行，或 60 日上行 >= 20bp 且美元偏强
    const tipsHighOrRising = (tips != null && tips >= 1.9 && (tipsDelta == null || tipsDelta > -15))
        || (tipsDelta != null && tipsDelta >= 20);
    if (tipsHighOrRising && (dxyDev == null || dxyDev >= -0.5)) {
        return 'tightening_headwind';
    }
    // 3) 宽松顺风：TIPS 60 日显著下行 <= -18bp，或实际利率低位 (<1.2%) 且美元走弱
    const tipsFallingOrLow = (tipsDelta != null && tipsDelta <= -18)
        || (tips != null && tips <= 1.2);
    if (tipsFallingOrLow && (dxyDev == null || dxyDev <= 1.0)) {
        return 'easing_tailwind';
    }
    return 'balanced_neutral';
}
/**
 * 构造分宏观体制的动态特征距离权重：
 *   w_final(k) = norm((1 - blendAlpha) * w_base(k) + blendAlpha * w_base(k) * tilt(regime, k))
 * 保持总权重和与基础核完全一致，避免距离尺度漂移。
 */
function buildRegimeAwareWeights(horizon, input, blendAlpha = 0.55) {
    const regime = classifyCausalMacroRegime(input);
    const base = horizon === 5 ? exports.BASE_DIST_WEIGHTS_5D : exports.BASE_DIST_WEIGHTS_MID;
    const tilt = REGIME_TILTS[regime];
    const alpha = Math.max(0, Math.min(1, blendAlpha));
    const keys = Object.keys(base);
    const baseSum = keys.reduce((s, k) => s + base[k], 0);
    const raw = {};
    let rawSum = 0;
    for (const k of keys) {
        const v = base[k] * (1 - alpha + alpha * tilt[k]);
        raw[k] = v;
        rawSum += v;
    }
    const weights = {};
    const scale = rawSum > 0 ? baseSum / rawSum : 1;
    for (const k of keys) {
        weights[k] = round(raw[k] * scale, 2);
    }
    const topWeightedFeatures = keys
        .map(k => ({ key: k, label: FEATURE_LABELS[k], weight: weights[k] }))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 3);
    const meta = REGIME_META[regime];
    return {
        regime,
        label: meta.label,
        badge: meta.badge,
        rationale: meta.rationale,
        blendAlpha: alpha,
        weights,
        topWeightedFeatures,
    };
}
