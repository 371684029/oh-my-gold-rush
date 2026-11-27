// GoldRush v2.5 — 消息面真伪甄别、防钓鱼证伪与反向价值提取引擎（纯本地纯函数，零 LLM/DB/网络）
//
// 四道防线：
//   1. 信源分级 + 独立交叉核验（A 级官方/交易所，B 级主流电讯需多源印证，C 级/未知源绝不入事实层）
//   2. 时效与文本特征检测（>72h 旧闻翻炒归零；识别匿名吹风、试探气球、煽动性标题党）
//   3. 三通道跨市场价格证伪（TIPS 实际利率 / DXY 美元 / 金价二阶反应 / GLD 资金流）
//      - 利好消息 + 债汇不买账 / 金价下跌 / 筹码拥挤 => bait_trap（疑似钓鱼派发）
//      - 利空恐慌 + 实际利率下行 / 金价不跌反涨       => bait_trap（疑似诱空错杀）
//   4. 价值分流与指数半衰期衰减（T½ = 36h）：
//      - verified_fact -> 按预期差与衰减进入 B2 消息面
//      - noise_filtered / unconfirmed_rumor / stale_rehash -> B2 权重严格为 0
//      - bait_trap -> B2 事实权重置 0，同时提取反向情绪修正量与预警注入 S3 情绪面

import type { Direction } from '../types/analysis.js';
import type { SourceGrade } from '../types/market.js';
import { directionFromScore } from './decision-thresholds.js';
import { gradeSource } from './source-rank.js';

export type NewsVeracityCategory =
  | 'verified_fact'
  | 'bait_trap'
  | 'stale_rehash'
  | 'unconfirmed_rumor'
  | 'noise_filtered';

export type MarketConfirmationStatus = 'confirmed' | 'unconfirmed' | 'contradicted';

export interface NewsItemInput {
  headline: string;
  snippet?: string;
  /** 报道/引用来源列表 */
  sources: string[];
  /** 报道发布时间 ISO 字符串（可选） */
  publishedAt?: string | null;
  /** 底层事件发生时间 ISO 字符串（可选，用于拦截旧闻翻炒） */
  eventDate?: string | null;
  /** 文本表面宣称的方向 */
  claimedDirection: Direction;
  /** 可选：预期差强度（正=超预期利多黄金，负=超预期利空黄金，范围建议 -3..+3） */
  surpriseZscore?: number | null;
}

export interface MarketVerificationSnapshot {
  /** 伦敦金当日涨跌幅（%） */
  goldDailyRetPct?: number | null;
  /** 伦敦金近 5 日涨跌幅（%） */
  gold5dRetPct?: number | null;
  /** 10Y TIPS 当日/近期变动（基点 bp，正=实际利率上升利空金，负=下行利多金） */
  tipsDeltaBp?: number | null;
  /** 美元指数 DXY 当日涨跌幅（%，正=美元走强利空金，负=走弱利多金） */
  dxyDailyRetPct?: number | null;
  /** CBOE VIX 水平 */
  vix?: number | null;
  /** GLD ETF 近 5 日资金流（吨或%，正=流入，负=流出） */
  gldFlow5d?: number | null;
  /** CFTC 3 年持仓拥挤分位（0-100，>=85 极度拥挤） */
  cftcCrowdingPct?: number | null;
}

export interface AuditedNewsItem {
  headline: string;
  category: NewsVeracityCategory;
  categoryLabel: string;
  /** 综合真伪可信度 0-100 */
  veracityScore: number;
  /** 进入 B2 消息面事实层的有效权重（0..1；假/旧闻/钓鱼严格为 0） */
  effectiveWeight: number;
  /** 有效方向（滤除后归 neutral） */
  effectiveDirection: Direction;
  /** 钓鱼/派发/诱空嫌疑分 0-100 */
  baitRiskScore: number;
  /** 独立 A/B 级信源数量 */
  corroborationCount: number;
  topSourceGrade: SourceGrade;
  marketConfirmation: MarketConfirmationStatus;
  /** 时间半衰期衰减因子 0..1 */
  decayFactor: number;
  reasons: string[];
  /** 若为钓鱼消息，提取给 S3 情绪面的反向警示 */
  contrarianSignal: {
    direction: 'bullish' | 'bearish';
    biasPoints: number; // 负=防追高扣分，正=防错杀加分
    note: string;
  } | null;
}

export interface NewsVeracityAuditResult {
  items: AuditedNewsItem[];
  verifiedCount: number;
  baitCount: number;
  filteredCount: number;
  /** 经真伪过滤后的 B2 消息面得分（0-100；无有效真消息时为 null，交由八维引擎重归一） */
  newsScore: number | null;
  newsDirection: Direction;
  /** B2 消息面有效覆盖度 0..1 */
  coverage: number;
  /** 整体真伪状态标签 */
  veracityStatus: 'confirmed' | 'bait_suspected' | 'noise_filtered' | 'quiet';
  veracityBadge: string;
  /** 供 S3 情绪面使用的反向修正分（-15..+15） */
  contrarianSentimentBias: number;
  /** 供日报与 Web 展示的一句话钓鱼警示（无则 null） */
  baitAlert: string | null;
  /** 供 FHS 预测模型使用的噪音收缩加成（0..0.25，钓鱼/噪音日提高向无条件基准的收缩） */
  noiseShrinkageBoost: number;
  summary: string;
}

/** 信息半衰期（小时）：36 小时后边际权重减半 */
export const NEWS_HALF_LIFE_HOURS = 36;
/** 超过该小时数视为旧闻翻炒，不再进入当日 B2 消息面 */
export const NEWS_MAX_AGE_HOURS = 72;

/** 显式 A 级官方/权威机构关键词（用于更严格的新闻信源分级） */
const STRICT_GRADE_A_PATTERNS = [
  /federal\s*reserve|fomc|美联储|鲍威尔/i,
  /bureau\s*of\s*labor|bls|美国劳工部|bea|美国商务部/i,
  /pboc|中国人民银行|外管局|国家外汇管理局/i,
  /lbma|comex|cme|上海黄金交易所|上金所|sge/i,
  /world\s*gold\s*council|世界黄金协会|imf|bis|fred/i,
];

/** 显式 B 级主流财经电讯 */
const STRICT_GRADE_B_PATTERNS = [
  /reuters|路透|bloomberg|彭博|financial\s*times|ft\.com|wsj|华尔街日报/i,
  /财联社|华尔街见闻|金十|东方财富|证券时报|上海证券报|第一财经|investing\.com|kitco|wind/i,
];

/** 显式 C 级社媒/自媒体/论坛 */
const STRICT_GRADE_C_PATTERNS = [
  /雪球|微博|知乎|贴吧|头条|公众号|小红书|抖音|reddit|twitter|x\.com|匿名|网传|自媒体|论坛|群聊/i,
];

/** 吹风/试探气球/匿名传闻文本模式 */
const RUMOR_OR_TRIAL_BALLOON_RE =
  /知情人士|消息人士|据传|网传|小作文|传闻|据说|听说|有消息称|sources\s*say|people\s*familiar|unnamed\s*official|rumou?r|unconfirmed/i;

/** 情绪煽动/标题党模式 */
const SENSATIONAL_HYPE_RE =
  /史诗级|必涨|必买|马上破|冲上\d+|崩盘预警|一夜暴富|惊天|重磅炸弹|暴涨倒计时|血洗|紧急逃命|shocking|guaranteed|skyrocket|crash\s*imminent|to\s*the\s*moon/i;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round(v: number, digits = 2): number {
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}

/**
 * v2.5 严格新闻信源分级：
 * 与行情报价的 gradeSource 不同，新闻领域「未知来源默认降为 C 级」（宁缺毋滥），
 * 避免匿名博客或自媒体混入 B 级事实层。
 */
export function gradeNewsSourceStrict(sourceName: string): SourceGrade {
  const s = (sourceName || '').trim();
  if (!s) return 'C';
  if (STRICT_GRADE_A_PATTERNS.some(re => re.test(s))) return 'A';
  if (STRICT_GRADE_C_PATTERNS.some(re => re.test(s))) return 'C';
  if (STRICT_GRADE_B_PATTERNS.some(re => re.test(s))) return 'B';
  // 回落查已有表：仅当显式命中 A 级时保留 A，否则未知来源统一降为 C
  const known = gradeSource(s);
  if (known === 'A') return 'A';
  return 'C';
}

/** 独立信源去重统计 */
function analyzeSources(sources: string[]): {
  topGrade: SourceGrade;
  gradeACount: number;
  gradeBCount: number;
  gradeCCount: number;
  independentTrustedCount: number;
} {
  const uniq = Array.from(new Set(sources.map(s => s.trim().toLowerCase()).filter(Boolean)));
  let gradeACount = 0;
  let gradeBCount = 0;
  let gradeCCount = 0;
  for (const s of uniq) {
    const g = gradeNewsSourceStrict(s);
    if (g === 'A') gradeACount++;
    else if (g === 'B') gradeBCount++;
    else gradeCCount++;
  }
  const topGrade: SourceGrade = gradeACount > 0 ? 'A' : gradeBCount > 0 ? 'B' : 'C';
  return {
    topGrade,
    gradeACount,
    gradeBCount,
    gradeCCount,
    independentTrustedCount: gradeACount + gradeBCount,
  };
}

/** 计算消息时效与指数半衰期衰减 */
function computeAgeAndDecay(
  publishedAt: string | null | undefined,
  eventDate: string | null | undefined,
  nowMs: number,
): { ageHours: number | null; isStale: boolean; decayFactor: number } {
  const pickMs = (iso?: string | null): number | null => {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  };
  const evMs = pickMs(eventDate);
  const pubMs = pickMs(publishedAt);
  // 优先用更早的底层事件时间，防止旧闻换今天发布时间重炒
  const refMs = evMs != null && pubMs != null ? Math.min(evMs, pubMs) : (evMs ?? pubMs);
  if (refMs == null) {
    return { ageHours: null, isStale: false, decayFactor: 0.85 };
  }
  const ageHours = Math.max(0, (nowMs - refMs) / (1000 * 60 * 60));
  if (ageHours > NEWS_MAX_AGE_HOURS) {
    return { ageHours: round(ageHours, 1), isStale: true, decayFactor: 0 };
  }
  const decayFactor = Math.pow(0.5, ageHours / NEWS_HALF_LIFE_HOURS);
  return { ageHours: round(ageHours, 1), isStale: false, decayFactor: round(clamp(decayFactor, 0.15, 1), 3) };
}

/**
 * 跨市场三通道客观验证：计算客观市场对「黄金看多(+1) / 看空(-1)」的投票净值
 * 返回 [-1, +1] 的 marketVote 及可读通道证据。
 */
function evaluateCrossMarketVote(market?: MarketVerificationSnapshot | null): {
  hasSignals: boolean;
  marketVote: number; // +1 = 跨市场强确认看多金, -1 = 跨市场强确认看空金
  priceRetPct: number | null;
  evidence: string[];
} {
  if (!market) {
    return { hasSignals: false, marketVote: 0, priceRetPct: null, evidence: [] };
  }

  let weightedSum = 0;
  let weightTotal = 0;
  const evidence: string[] = [];

  // 1) TIPS 实际利率通道（反向：上升利空金，下行利多金）
  if (market.tipsDeltaBp != null && Number.isFinite(market.tipsDeltaBp)) {
    const bp = market.tipsDeltaBp;
    if (Math.abs(bp) >= 3) {
      const vote = clamp(-bp / 10, -1, 1);
      weightedSum += vote * 0.35;
      weightTotal += 0.35;
      evidence.push(`TIPS ${bp > 0 ? '+' : ''}${round(bp, 1)}bp(${bp > 0 ? '利空金' : '利多金'})`);
    }
  }

  // 2) DXY 美元通道（反向：走强利空金，走弱利多金）
  if (market.dxyDailyRetPct != null && Number.isFinite(market.dxyDailyRetPct)) {
    const dxy = market.dxyDailyRetPct;
    if (Math.abs(dxy) >= 0.25) {
      const vote = clamp(-dxy / 0.8, -1, 1);
      weightedSum += vote * 0.25;
      weightTotal += 0.25;
      evidence.push(`DXY ${dxy > 0 ? '+' : ''}${round(dxy, 2)}%(${dxy > 0 ? '利空金' : '利多金'})`);
    }
  }

  // 3) 黄金自身二阶价格反应（利好不涨反跌 / 利空不跌反涨是最硬的证伪证据）
  const priceRetPct = market.goldDailyRetPct != null && Number.isFinite(market.goldDailyRetPct)
    ? market.goldDailyRetPct
    : null;
  if (priceRetPct != null && Math.abs(priceRetPct) >= 0.4) {
    const vote = clamp(priceRetPct / 1.5, -1, 1);
    weightedSum += vote * 0.30;
    weightTotal += 0.30;
    evidence.push(`金价反应 ${priceRetPct > 0 ? '+' : ''}${round(priceRetPct, 2)}%`);
  }

  // 4) GLD 资金流确认
  if (market.gldFlow5d != null && Number.isFinite(market.gldFlow5d) && Math.abs(market.gldFlow5d) >= 1.5) {
    const vote = clamp(market.gldFlow5d / 10, -1, 1);
    weightedSum += vote * 0.10;
    weightTotal += 0.10;
    evidence.push(`GLD资金 ${market.gldFlow5d > 0 ? '+' : ''}${round(market.gldFlow5d, 1)}`);
  }

  if (weightTotal <= 0) {
    return { hasSignals: false, marketVote: 0, priceRetPct, evidence };
  }
  return {
    hasSignals: true,
    marketVote: round(weightedSum / weightTotal, 3),
    priceRetPct,
    evidence,
  };
}

/** 审计单条消息：区分真消息 / 假谣言 / 旧闻翻炒 / 钓鱼消息 */
export function auditSingleNewsItem(
  item: NewsItemInput,
  market?: MarketVerificationSnapshot | null,
  nowMs: number = Date.now(),
): AuditedNewsItem {
  const fullText = `${item.headline || ''} ${item.snippet || ''}`;
  const srcInfo = analyzeSources(item.sources || []);
  const { ageHours, isStale, decayFactor } = computeAgeAndDecay(item.publishedAt, item.eventDate, nowMs);
  const cross = evaluateCrossMarketVote(market);
  const reasons: string[] = [];

  const hasRumorText = RUMOR_OR_TRIAL_BALLOON_RE.test(fullText);
  const hasHypeText = SENSATIONAL_HYPE_RE.test(fullText);
  const claimedSign = item.claimedDirection === 'bullish' ? 1 : item.claimedDirection === 'bearish' ? -1 : 0;

  // 1) 判定跨市场确认状态
  let marketConfirmation: MarketConfirmationStatus = 'unconfirmed';
  if (cross.hasSignals && claimedSign !== 0) {
    const alignment = claimedSign * cross.marketVote;
    if (alignment >= 0.25) {
      marketConfirmation = 'confirmed';
      reasons.push(`跨市场通道同向确认（${cross.evidence.join(' · ')}）`);
    } else if (alignment <= -0.25) {
      marketConfirmation = 'contradicted';
      reasons.push(`跨市场价格证伪（宣称${claimedSign > 0 ? '利多' : '利空'}，但${cross.evidence.join(' · ')}反向运行）`);
    }
  }

  // 2) 旧闻翻炒直接拦截
  if (isStale) {
    reasons.push(`底层事件已过 ${ageHours}h（>${NEWS_MAX_AGE_HOURS}h），属旧闻翻炒`);
    return {
      headline: item.headline,
      category: 'stale_rehash',
      categoryLabel: '旧闻翻炒',
      veracityScore: 20,
      effectiveWeight: 0,
      effectiveDirection: 'neutral',
      baitRiskScore: 35,
      corroborationCount: srcInfo.independentTrustedCount,
      topSourceGrade: srcInfo.topGrade,
      marketConfirmation,
      decayFactor: 0,
      reasons,
      contrarianSignal: null,
    };
  }

  // 3) 计算钓鱼风险分（0-100）
  let baitRiskScore = 10;
  if (hasRumorText) {
    baitRiskScore += 28;
    reasons.push('含匿名吹风/传闻措辞（警惕政策试探气球或小作文）');
  }
  if (hasHypeText) {
    baitRiskScore += 26;
    reasons.push('含强煽动性标题党词汇');
  }
  if (marketConfirmation === 'contradicted') {
    baitRiskScore += 36;
  }
  if (claimedSign > 0 && (market?.cftcCrowdingPct ?? 0) >= 82) {
    baitRiskScore += 14;
    reasons.push(`CFTC 存量筹码高度拥挤（第${Math.round(market!.cftcCrowdingPct!)}%分位），高位利多谨防派发`);
  }
  if (srcInfo.topGrade === 'A' && !hasRumorText && !hasHypeText) {
    baitRiskScore -= 20;
  }
  baitRiskScore = Math.round(clamp(baitRiskScore, 0, 100));

  // 4) 分类裁决
  // 4a) 疑似钓鱼/派发/诱空消息：跨市场显著反向打脸，且存在吹风/煽动/拥挤或非 A 级硬决议
  const isBaitTrap =
    claimedSign !== 0
    && marketConfirmation === 'contradicted'
    && (baitRiskScore >= 55 || hasRumorText || hasHypeText || srcInfo.topGrade !== 'A');

  if (isBaitTrap) {
    const contrarianDir: 'bullish' | 'bearish' = claimedSign > 0 ? 'bearish' : 'bullish';
    const biasMag = Math.round(clamp(6 + (baitRiskScore - 55) * 0.2, 6, 14));
    const contrarianNote = claimedSign > 0
      ? `疑似利多钓鱼/高位派发（${cross.evidence.slice(0, 2).join('，')}反向走弱），忌 FOMO 追高`
      : `疑似利空诱空/情绪错杀（${cross.evidence.slice(0, 2).join('，')}反向走强），忌恐慌割肉`;

    return {
      headline: item.headline,
      category: 'bait_trap',
      categoryLabel: claimedSign > 0 ? '疑似利多钓鱼' : '疑似利空诱空',
      veracityScore: 25,
      effectiveWeight: 0, // 严格剥离出 B2 事实层
      effectiveDirection: 'neutral',
      baitRiskScore,
      corroborationCount: srcInfo.independentTrustedCount,
      topSourceGrade: srcInfo.topGrade,
      marketConfirmation,
      decayFactor,
      reasons,
      contrarianSignal: {
        direction: contrarianDir,
        biasPoints: contrarianDir === 'bearish' ? -biasMag : biasMag,
        note: contrarianNote,
      },
    };
  }

  // 4b) 假消息/无依据噪音：仅 C 级或未知来源（无 A/B 级背书）
  if (srcInfo.topGrade === 'C') {
    reasons.push('仅 C 级/未知来源，缺乏官方或主流财经电讯交叉印证，已拦截出事实层');
    return {
      headline: item.headline,
      category: hasHypeText || hasRumorText ? 'noise_filtered' : 'unconfirmed_rumor',
      categoryLabel: hasHypeText || hasRumorText ? '噪音已滤除' : '未核实传闻',
      veracityScore: 20,
      effectiveWeight: 0,
      effectiveDirection: 'neutral',
      baitRiskScore,
      corroborationCount: 0,
      topSourceGrade: 'C',
      marketConfirmation,
      decayFactor,
      reasons,
      contrarianSignal: null,
    };
  }

  // 4c) 单 B 级 + 匿名吹风且无市场确认 => 未核实传闻（防试探气球混入实证）
  if (srcInfo.gradeACount === 0 && srcInfo.gradeBCount < 2 && hasRumorText && marketConfirmation !== 'confirmed') {
    reasons.push('单源 B 级匿名传闻且未获跨市场定价确认，暂列观察不计入事实分');
    return {
      headline: item.headline,
      category: 'unconfirmed_rumor',
      categoryLabel: '单源吹风待核实',
      veracityScore: 42,
      effectiveWeight: 0,
      effectiveDirection: 'neutral',
      baitRiskScore,
      corroborationCount: srcInfo.gradeBCount,
      topSourceGrade: 'B',
      marketConfirmation,
      decayFactor,
      reasons,
      contrarianSignal: null,
    };
  }

  // 4d) 实证真消息（A 级官方，或 >=2 家独立 B 级交叉印证，或单 B 级获跨市场同向确认）
  let veracityScore = 62;
  if (srcInfo.gradeACount > 0) {
    veracityScore += 22;
    reasons.push('含 A 级官方/交易所一级信源');
  } else if (srcInfo.gradeBCount >= 2) {
    veracityScore += 16;
    reasons.push(`${srcInfo.gradeBCount} 家独立 B 级财经电讯交叉印证`);
  } else {
    reasons.push('单源 B 级信源（需持续跟踪二阶反应）');
  }

  if (marketConfirmation === 'confirmed') veracityScore += 12;
  else if (marketConfirmation === 'contradicted') {
    // 即使是 A 级真消息，若市场反向定价（如“利好出尽”），大幅衰减权重并标注预期差背离
    veracityScore -= 24;
    reasons.push('虽为一手事实但市场反向定价（疑已提前计价/利好出尽），权重已大幅衰减');
  }
  if (hasRumorText) veracityScore -= 12;
  if (hasHypeText) veracityScore -= 10;

  veracityScore = Math.round(clamp(veracityScore, 30, 98));

  // 计算最终进入 B2 的有效权重（受真伪分、半衰期、跨市场背离折扣共同约束）
  const contradictionMult = marketConfirmation === 'contradicted' ? 0.25 : 1.0;
  const effectiveWeight = round(clamp((veracityScore / 100) * decayFactor * contradictionMult, 0, 1), 3);

  return {
    headline: item.headline,
    category: 'verified_fact',
    categoryLabel: marketConfirmation === 'confirmed' ? '实证真消息(市场确认)' : '实证真消息',
    veracityScore,
    effectiveWeight,
    effectiveDirection: item.claimedDirection,
    baitRiskScore,
    corroborationCount: srcInfo.independentTrustedCount,
    topSourceGrade: srcInfo.topGrade,
    marketConfirmation,
    decayFactor,
    reasons,
    contrarianSignal: null,
  };
}

/**
 * 对当日消息池执行完整真伪审计、B2 净得分合成与 S3 钓鱼反向信号提取
 */
export function auditNewsVeracity(
  items: NewsItemInput[],
  market?: MarketVerificationSnapshot | null,
  nowMs: number = Date.now(),
): NewsVeracityAuditResult {
  if (!items || items.length === 0) {
    return {
      items: [],
      verifiedCount: 0,
      baitCount: 0,
      filteredCount: 0,
      newsScore: null,
      newsDirection: 'neutral',
      coverage: 0,
      veracityStatus: 'quiet',
      veracityBadge: '无显著事件催化',
      contrarianSentimentBias: 0,
      baitAlert: null,
      noiseShrinkageBoost: 0,
      summary: '当日无待审计突发事件，B2 消息面保持静默并由其余维度自动重归一。',
    };
  }

  const audited = items.map(it => auditSingleNewsItem(it, market, nowMs));
  const verified = audited.filter(a => a.category === 'verified_fact' && a.effectiveWeight > 0);
  const baits = audited.filter(a => a.category === 'bait_trap');
  const filtered = audited.filter(
    a => a.category === 'noise_filtered' || a.category === 'unconfirmed_rumor' || a.category === 'stale_rehash',
  );

  // 合成 B2 消息面得分（仅采纳 verified_fact，严格零污染）
  let newsScore: number | null = null;
  let coverage = 0;
  if (verified.length > 0) {
    let weightedNet = 0;
    let totalW = 0;
    for (let i = 0; i < audited.length; i++) {
      const a = audited[i]!;
      if (a.category !== 'verified_fact' || a.effectiveWeight <= 0) continue;
      const orig = items[i]!;
      const sign = a.effectiveDirection === 'bullish' ? 1 : a.effectiveDirection === 'bearish' ? -1 : 0;
      const surpriseBoost = orig.surpriseZscore != null && Number.isFinite(orig.surpriseZscore)
        ? clamp(1 + Math.abs(orig.surpriseZscore) * 0.25, 0.8, 1.6)
        : 1;
      const w = a.effectiveWeight * surpriseBoost;
      weightedNet += sign * w;
      totalW += w;
    }
    if (totalW > 0) {
      const norm = weightedNet / totalW; // -1..+1
      // 最大幅度控制在 [20, 80]，防止单日消息过度挤压基本面与量化面
      newsScore = Math.round(clamp(50 + norm * 28, 20, 80));
      coverage = round(clamp(totalW / Math.max(1, verified.length), 0.35, 1), 2);
    }
  }

  // 提取 S3 情绪面反向修正与预警
  let contrarianBias = 0;
  const baitNotes: string[] = [];
  for (const b of baits) {
    if (b.contrarianSignal) {
      contrarianBias += b.contrarianSignal.biasPoints;
      baitNotes.push(b.contrarianSignal.note);
    }
  }
  contrarianBias = Math.round(clamp(contrarianBias, -15, 15));
  const baitAlert = baitNotes.length > 0 ? baitNotes[0]! : null;

  let veracityStatus: NewsVeracityAuditResult['veracityStatus'];
  let veracityBadge: string;
  let noiseShrinkageBoost = 0;

  if (baits.length > 0 && verified.length === 0) {
    veracityStatus = 'bait_suspected';
    veracityBadge = `⚠️ 疑似钓鱼/背离(${baits.length}条已隔离)`;
    noiseShrinkageBoost = 0.20;
  } else if (baits.length > 0) {
    veracityStatus = 'bait_suspected';
    veracityBadge = `⚠️ 实证${verified.length}条 · 拦截疑似钓鱼${baits.length}条`;
    noiseShrinkageBoost = 0.12;
  } else if (verified.length > 0) {
    veracityStatus = 'confirmed';
    const confirmedMarket = verified.some(v => v.marketConfirmation === 'confirmed');
    veracityBadge = confirmedMarket
      ? `✅ 跨市场实证确认(${verified.length}条)`
      : `✅ 一/二级信源核验(${verified.length}条)`;
    noiseShrinkageBoost = 0;
  } else {
    veracityStatus = 'noise_filtered';
    veracityBadge = `🚫 噪音/传闻已滤除(${filtered.length}条)`;
    noiseShrinkageBoost = 0.10;
  }

  const parts: string[] = [];
  if (verified.length > 0) parts.push(`采信实证真消息 ${verified.length} 条`);
  if (baits.length > 0) parts.push(`拦截疑似钓鱼 ${baits.length} 条并转入情绪反向预警`);
  if (filtered.length > 0) parts.push(`滤除未核实/旧闻噪音 ${filtered.length} 条`);

  return {
    items: audited,
    verifiedCount: verified.length,
    baitCount: baits.length,
    filteredCount: filtered.length,
    newsScore,
    newsDirection: newsScore != null ? directionFromScore(newsScore) : 'neutral',
    coverage,
    veracityStatus,
    veracityBadge,
    contrarianSentimentBias: contrarianBias,
    baitAlert,
    noiseShrinkageBoost,
    summary: parts.join('；') || '当日消息面平稳。',
  };
}
