// AUTO-GENERATED from src/utils/fhs-math.ts by scripts/sync-web-cjs.mjs — DO NOT EDIT MANUALLY
// Run `npm run sync:web` after modifying src/utils/fhs-math.ts.
"use strict";
// 共享金融工程数学核心 — F01 严格几何峰谷最大回撤 + F02 去均值对数 FHS + F04 混合权重分位与概率自洽
Object.defineProperty(exports, "__esModule", { value: true });
exports.computePathMaxDrawdown = computePathMaxDrawdown;
exports.causalMeanLogReturn = causalMeanLogReturn;
exports.buildDemeanedLogFhsPath = buildDemeanedLogFhsPath;
exports.scaleCumPctPathLogFhs = scaleCumPctPathLogFhs;
exports.mixSampleWeights = mixSampleWeights;
exports.weightedQuantilesBatch = weightedQuantilesBatch;
exports.weightedEventProbPct = weightedEventProbPct;
function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}
function round(v, digits = 2) {
    const m = Math.pow(10, digits);
    return Math.round(v * m) / m;
}
/**
 * F01: 计算路径的严格几何峰谷最大回撤与相对起点最大浮亏。
 * 输入为相对起点 t=0（净值 V_0 = 1）的累计涨跌幅序列（单位 %）。
 */
function computePathMaxDrawdown(cumPctPath) {
    let runningPeak = 1;
    let maxDd = 0;
    let maxUnderwater = 0;
    for (let i = 0; i < cumPctPath.length; i++) {
        const pct = cumPctPath[i];
        if (!Number.isFinite(pct))
            continue;
        const nav = Math.max(1e-9, 1 + pct / 100);
        if (nav > runningPeak)
            runningPeak = nav;
        const ddPct = ((nav / runningPeak) - 1) * 100;
        if (ddPct < maxDd)
            maxDd = ddPct;
        if (pct < maxUnderwater)
            maxUnderwater = pct;
    }
    return {
        maxDrawdownPct: round(maxDd, 2),
        maxUnderwaterPct: round(maxUnderwater, 2),
    };
}
/**
 * 计算因果样本段 [0..asOfIdx] 的无条件单步对数收益均值 μ_0。
 */
function causalMeanLogReturn(prices, asOfIdx) {
    const end = Math.min(asOfIdx, prices.length - 1);
    let sum = 0;
    let count = 0;
    for (let i = 1; i <= end; i++) {
        const p0 = prices[i - 1];
        const p1 = prices[i];
        if (p0 > 0 && p1 > 0) {
            sum += Math.log(p1 / p0);
            count++;
        }
    }
    return count > 0 ? sum / count : 0;
}
/**
 * F02: 标准去均值单步对数收益 FHS（Barone-Adesi, Giannopoulos & Vosper, 1999）。
 *   r_k = ln(P_{d+k} / P_{d+k-1})
 *   r_tilde_k = muRef + volScale * (r_k - muRef)
 *   R_h = (exp(sum_{k=1..h} r_tilde_k) - 1) * 100
 *
 * 数学保证：
 * 1. 价格严格为正：R_h > -100%，无需硬编码截断补丁；
 * 2. 期望漂移不被 volScale 放大，仅残差波动率按 sigma_0 / sigma_d 缩放；
 * 3. 当 volScale = 1 时精确还原真实几何累计收益。
 */
function buildDemeanedLogFhsPath(prices, startIdx, horizon, volScale, muRef = 0) {
    const safeScale = Number.isFinite(volScale) && volScale > 0 ? volScale : 1;
    const safeMu = Number.isFinite(muRef) ? muRef : 0;
    const out = [];
    let cumLog = 0;
    for (let k = 1; k <= horizon; k++) {
        const pPrev = prices[startIdx + k - 1];
        const pCur = prices[startIdx + k];
        const r = pPrev > 0 && pCur > 0 ? Math.log(pCur / pPrev) : 0;
        const rScaled = safeMu + safeScale * (r - safeMu);
        // 防止极端输入导致 exp 溢出
        cumLog += clamp(rScaled, -3, 3);
        const cumPct = (Math.exp(cumLog) - 1) * 100;
        out.push(cumPct);
    }
    return out;
}
/**
 * 从累计收益百分比路径直接做去均值单步对数 FHS（适用于已有相对起点累计收益序列的场景，如 prob-path-forecast.ts）。
 */
function scaleCumPctPathLogFhs(rawCumPct, volScale, muRef = 0) {
    const safeScale = Number.isFinite(volScale) && volScale > 0 ? volScale : 1;
    const safeMu = Number.isFinite(muRef) ? muRef : 0;
    const out = [];
    let prevNav = 1;
    let cumLog = 0;
    for (let i = 0; i < rawCumPct.length; i++) {
        const nav = Math.max(1e-9, 1 + rawCumPct[i] / 100);
        const r = Math.log(nav / prevNav);
        prevNav = nav;
        const rScaled = safeMu + safeScale * (r - safeMu);
        cumLog += clamp(rScaled, -3, 3);
        out.push((Math.exp(cumLog) - 1) * 100);
    }
    return out;
}
/**
 * F04: 在样本权重层构造条件分布与无条件分布的经验贝叶斯混合权重：
 *   w_mix_i = (1 - lambda) * (w_i / sumW) + lambda * (1 / N)
 * 确保分位数、回撤分位、期末收涨概率、跑赢通胀概率、触达概率均出自同一概率测度。
 */
function mixSampleWeights(condWeights, shrinkageLambda) {
    const n = condWeights.length;
    if (n === 0)
        return [];
    const lam = clamp(Number.isFinite(shrinkageLambda) ? shrinkageLambda : 0, 0, 1);
    let sumW = 0;
    for (let i = 0; i < n; i++) {
        const w = condWeights[i];
        if (Number.isFinite(w) && w > 0)
            sumW += w;
    }
    const uniform = 1 / n;
    if (sumW <= 0)
        return new Array(n).fill(uniform);
    return condWeights.map(w => {
        const nw = Number.isFinite(w) && w > 0 ? w / sumW : 0;
        return (1 - lam) * nw + lam * uniform;
    });
}
/** 一次排序批量计算加权分位数 */
function weightedQuantilesBatch(values, weights, qs) {
    if (!values.length)
        return qs.map(() => 0);
    const pairs = [];
    let totalW = 0;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        const w = Math.max(0, weights[i] ?? 0);
        if (Number.isFinite(v) && w > 0) {
            pairs.push({ v, w });
            totalW += w;
        }
    }
    if (!pairs.length)
        return qs.map(() => 0);
    pairs.sort((a, b) => a.v - b.v);
    if (totalW <= 0) {
        const mid = pairs[Math.floor(pairs.length / 2)].v;
        return qs.map(() => mid);
    }
    return qs.map(q => {
        const target = clamp(q, 0, 1) * totalW;
        let cum = 0;
        for (let i = 0; i < pairs.length; i++) {
            const prevCum = cum;
            cum += pairs[i].w;
            if (cum >= target) {
                if (i === 0)
                    return pairs[0].v;
                const frac = pairs[i].w > 0 ? (target - prevCum) / pairs[i].w : 0;
                return pairs[i - 1].v + (pairs[i].v - pairs[i - 1].v) * clamp(frac, 0, 1);
            }
        }
        return pairs[pairs.length - 1].v;
    });
}
/** 按给定样本权重计算事件发生概率（0..100） */
function weightedEventProbPct(items, weights, predicate, digits = 1) {
    let hitW = 0;
    let validW = 0;
    for (let i = 0; i < items.length; i++) {
        const w = weights[i] ?? 0;
        if (!Number.isFinite(w) || w <= 0)
            continue;
        const res = predicate(items[i], i);
        if (res == null)
            continue;
        validW += w;
        if (res)
            hitW += w;
    }
    if (validW <= 0)
        return null;
    return round((hitW / validW) * 100, digits);
}
