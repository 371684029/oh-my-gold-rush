// AUTO-GENERATED from src/utils/source-rank.ts by scripts/sync-web-cjs.mjs — DO NOT EDIT MANUALLY
// Run `npm run sync:web` after modifying src/utils/source-rank.ts.
"use strict";
// 来源分级 + 交叉验证工具
Object.defineProperty(exports, "__esModule", { value: true });
exports.singleSourceConfidence = singleSourceConfidence;
exports.gradeSource = gradeSource;
exports.crossValidate = crossValidate;
exports.checkFreshness = checkFreshness;
exports.validationSourcesFromPrices = validationSourcesFromPrices;
exports.weightedFieldConfidence = weightedFieldConfidence;
/** 已知来源分级映射 */
const SOURCE_GRADES = {
    // A级（权威 / 直连锚定）
    '上海黄金交易所': 'A',
    'COMEX': 'A',
    'CME': 'A',
    'Federal Reserve': 'A',
    '美联储': 'A',
    '世界黄金协会': 'A',
    'World Gold Council': 'A',
    'BIS': 'A',
    'IMF': 'A',
    'LBMA': 'A',
    'gold-api.com': 'A',
    'gold-api': 'A',
    'Yahoo Finance': 'A',
    'Yahoo Finance GC=F': 'A',
    'Yahoo Finance DX-Y.NYB': 'A',
    'FRED': 'A',
    'FRED DGS10': 'A',
    'FRED DFII10': 'A',
    'FRED DTWEXBGS': 'A',
    'sina hf_GC': 'A',
    'sina DINIW': 'A',
    'sina': 'A',
    '新浪': 'A',
    '新浪财经': 'A',
    // B级（可信）
    '金十数据': 'B',
    '东方财富': 'B',
    'Wind': 'B',
    '华尔街见闻': 'B',
    '财联社': 'B',
    '证券时报': 'B',
    '上海证券报': 'B',
    'Investing.com': 'B',
    'Bloomberg': 'B',
    'Reuters': 'B',
    '路透': 'B',
    'Financial Times': 'B',
    'Kitco': 'B',
    'TradingView': 'B',
    // C级（参考）
    '雪球': 'C',
    '微博': 'C',
    '知乎': 'C',
    '贴吧': 'C',
    '头条': 'C',
    '微信公众号': 'C',
};
/** 单源字段置信度：A 级直连不再封顶 55 */
function singleSourceConfidence(grade) {
    if (grade === 'A')
        return 72;
    if (grade === 'B')
        return 50;
    return 35;
}
/** 判断来源可信度等级 */
function gradeSource(sourceName) {
    // 直接匹配
    if (SOURCE_GRADES[sourceName]) {
        return SOURCE_GRADES[sourceName];
    }
    // 模糊匹配
    for (const [key, grade] of Object.entries(SOURCE_GRADES)) {
        if (sourceName.includes(key) || key.includes(sourceName)) {
            return grade;
        }
    }
    // 未知来源默认B级
    return 'B';
}
/** 交叉验证多个来源的数据 */
function crossValidate(field, sources, tolerancePct = 1) {
    if (sources.length === 0) {
        return {
            field,
            sources,
            consensus: 'major_conflict',
            finalValue: 0,
            confidence: 0,
        };
    }
    if (sources.length === 1) {
        const grade = sources[0].grade;
        return {
            field,
            sources,
            consensus: 'single_source',
            finalValue: sources[0].value,
            confidence: singleSourceConfidence(grade),
        };
    }
    // 数值型验证
    const numericValues = sources
        .filter(s => typeof s.value === 'number')
        .map(s => s.value);
    if (numericValues.length < 2) {
        return {
            field,
            sources,
            consensus: 'verified',
            finalValue: sources[0].value,
            confidence: 60,
        };
    }
    const avg = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
    const maxDeviation = Math.max(...numericValues.map(v => Math.abs((v - avg) / avg * 100)));
    let consensus;
    let finalValue;
    let confidence;
    if (maxDeviation < 0.5) {
        // 3源一致或偏差极小
        consensus = 'verified';
        finalValue = avg;
        confidence = 95;
    }
    else if (maxDeviation < tolerancePct) {
        // 2源一致，1源偏差 < 阈值
        consensus = 'minor_deviation';
        finalValue = avg;
        confidence = 80;
    }
    else {
        // 3源差异 > 阈值
        consensus = 'major_conflict';
        // 取A级来源的值，或平均值
        const aGradeSources = sources.filter(s => s.grade === 'A');
        finalValue = aGradeSources.length > 0
            ? aGradeSources[0].value
            : avg;
        confidence = 50;
    }
    return { field, sources, consensus, finalValue, confidence };
}
/** 判断数据时效性 */
function checkFreshness(dataTime, thresholdHours = 4) {
    const dataDate = new Date(dataTime);
    // 非法时间戳：视为不新鲜并提示，避免 NaN 比较被误判为 fresh
    if (Number.isNaN(dataDate.getTime())) {
        return {
            fresh: false,
            ageHours: 0,
            warning: `⚠️ 数据时间戳无效（${dataTime || '空'}），无法判断时效性`,
        };
    }
    const now = new Date();
    const ageMs = now.getTime() - dataDate.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours > thresholdHours) {
        return {
            fresh: false,
            ageHours: Math.round(ageHours * 10) / 10,
            warning: `⚠️ 数据已过 ${Math.round(ageHours)} 小时，可能过时`,
        };
    }
    return { fresh: true, ageHours: Math.round(ageHours * 10) / 10 };
}
/** 主报价 + 备用来源 → 交叉验证输入（拒绝 0 / N/A） */
function validationSourcesFromPrices(primary, alts) {
    const sources = [];
    const push = (p) => {
        if (p?.value == null || !Number.isFinite(p.value) || p.value === 0)
            return;
        if (p.source === 'N/A')
            return;
        const src = p.source ?? 'unknown';
        sources.push({
            value: p.value,
            source: src,
            grade: (p.sourceGrade ?? gradeSource(src)),
            timestamp: p.verifiedAt ?? '',
        });
    };
    push(primary);
    for (const alt of alts ?? []) {
        push(alt);
    }
    return sources;
}
/**
 * 字段置信度加权平均：伦敦金 50%，其余字段平分 50%。
 * 避免上海/ETF 单源把「金价已锚定」的总分拖死。
 */
function weightedFieldConfidence(validations) {
    if (validations.length === 0)
        return 50;
    const london = validations.find(v => v.field === 'london.price' || v.field.startsWith('london'));
    const others = validations.filter(v => v !== london);
    if (!london) {
        return Math.round(validations.reduce((s, v) => s + v.confidence, 0) / validations.length);
    }
    if (others.length === 0)
        return Math.round(london.confidence);
    const othersAvg = others.reduce((s, v) => s + v.confidence, 0) / others.length;
    return Math.round(london.confidence * 0.5 + othersAvg * 0.5);
}
