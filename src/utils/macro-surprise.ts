// GoldRush v2.6 — 宏观经济日历「预期差（Surprise z-score）」纯函数引擎
// 将 CPI / 非农 / PCE / FOMC 等 A 级宏观发布从“文本好坏”升级为标准化超预期幅度 z = (Actual - Consensus) / σ_hist。

export type MacroIndicatorKey =
  | 'CPI'
  | 'CORE_CPI'
  | 'PCE'
  | 'CORE_PCE'
  | 'NFP'
  | 'UNEMPLOYMENT'
  | 'FOMC_RATE'
  | 'GDP'
  | 'ISM_PMI'
  | 'RETAIL_SALES';

export interface MacroIndicatorSpec {
  key: MacroIndicatorKey;
  label: string;
  unit: string;
  /** 历史预测误差标准差 σ_hist（与 unit 一致） */
  histStd: number;
  /**
   * 黄金方向映射：
   *  -1 = 实际值高于预期 → 实际利率/美元走强预期 → 短期利空黄金（如 CPI/NFP/鹰派加息/强 GDP）
   *  +1 = 实际值高于预期 → 衰退/降息预期升温 → 短期利多黄金（如失业率走高）
   */
  goldSign: 1 | -1;
  /** 相对黄金的敏感度权重（0.5..1.5） */
  goldSensitivity: number;
}

export const MACRO_INDICATOR_SPECS: Record<MacroIndicatorKey, MacroIndicatorSpec> = {
  CPI:          { key: 'CPI',          label: '美国 CPI 同比',   unit: '%',   histStd: 0.12, goldSign: -1, goldSensitivity: 1.35 },
  CORE_CPI:     { key: 'CORE_CPI',     label: '美国核心 CPI',    unit: '%',   histStd: 0.10, goldSign: -1, goldSensitivity: 1.40 },
  PCE:          { key: 'PCE',          label: '美国 PCE 同比',   unit: '%',   histStd: 0.10, goldSign: -1, goldSensitivity: 1.25 },
  CORE_PCE:     { key: 'CORE_PCE',     label: '美国核心 PCE',    unit: '%',   histStd: 0.08, goldSign: -1, goldSensitivity: 1.35 },
  NFP:          { key: 'NFP',          label: '美国非农就业',    unit: '万人', histStd: 5.5,  goldSign: -1, goldSensitivity: 1.45 },
  UNEMPLOYMENT: { key: 'UNEMPLOYMENT', label: '美国失业率',      unit: '%',   histStd: 0.12, goldSign: 1,  goldSensitivity: 1.20 },
  FOMC_RATE:    { key: 'FOMC_RATE',    label: '美联储基准利率',  unit: '%',   histStd: 0.15, goldSign: -1, goldSensitivity: 1.50 },
  GDP:          { key: 'GDP',          label: '美国 GDP 季调年率', unit: '%', histStd: 0.45, goldSign: -1, goldSensitivity: 0.90 },
  ISM_PMI:      { key: 'ISM_PMI',      label: '美国 ISM PMI',    unit: '点',  histStd: 1.2,  goldSign: -1, goldSensitivity: 0.95 },
  RETAIL_SALES: { key: 'RETAIL_SALES', label: '美国零售销售环比', unit: '%',  histStd: 0.35, goldSign: -1, goldSensitivity: 0.85 },
};

export interface MacroReleaseInput {
  indicator: MacroIndicatorKey;
  actual: number;
  consensus: number;
  previous?: number | null;
  releaseDate?: string | null;
  source?: string;
}

export interface MacroSurpriseResult {
  indicator: MacroIndicatorKey;
  label: string;
  unit: string;
  actual: number;
  consensus: number;
  rawSurprise: number;
  /** 标准化统计预期差 z = (actual - consensus) / σ_hist（保留符号） */
  rawZscore: number;
  /** 映射至黄金方向的预期差 z_gold（正=超预期利多黄金，负=超预期利空黄金，限幅 [-3, +3]） */
  goldSurpriseZ: number;
  /** 对 B2 消息面的建议分值偏移（-24..+24） */
  b2DeltaPoints: number;
  goldDirection: 'bullish' | 'bearish' | 'neutral';
  /** 是否构成显著超预期（|z| >= 0.75） */
  isSignificant: boolean;
  summary: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round(v: number, digits = 2): number {
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}

/** 计算单条宏观数据发布的标准化预期差及其对黄金的方向影响 */
export function computeMacroSurprise(input: MacroReleaseInput): MacroSurpriseResult {
  const spec = MACRO_INDICATOR_SPECS[input.indicator];
  const rawSurprise = round(input.actual - input.consensus, 4);
  const rawZ = spec.histStd > 0 ? rawSurprise / spec.histStd : 0;
  const clampedRawZ = clamp(rawZ, -4, 4);
  const goldSurpriseZ = round(clamp(clampedRawZ * spec.goldSign, -3, 3), 2);
  const isSignificant = Math.abs(rawZ) >= 0.75;

  const b2DeltaPoints = round(
    clamp(goldSurpriseZ * 7.5 * spec.goldSensitivity, -24, 24),
    1,
  );

  const goldDirection: 'bullish' | 'bearish' | 'neutral' =
    goldSurpriseZ >= 0.65 ? 'bullish' : goldSurpriseZ <= -0.65 ? 'bearish' : 'neutral';

  const cmpText = rawSurprise > 0 ? '高于预期' : rawSurprise < 0 ? '低于预期' : '符合预期';
  const dirText = goldDirection === 'bullish' ? '利多黄金' : goldDirection === 'bearish' ? '利空黄金' : '影响中性';
  const summary = `${spec.label} 公布 ${input.actual}${spec.unit} vs 预期 ${input.consensus}${spec.unit}（${cmpText}，z=${goldSurpriseZ >= 0 ? '+' : ''}${goldSurpriseZ}，${dirText}）`;

  return {
    indicator: spec.key,
    label: spec.label,
    unit: spec.unit,
    actual: input.actual,
    consensus: input.consensus,
    rawSurprise,
    rawZscore: round(clampedRawZ, 2),
    goldSurpriseZ,
    b2DeltaPoints,
    goldDirection,
    isSignificant,
    summary,
  };
}

/** 聚合多条同日宏观发布的综合预期差（按敏感度加权） */
export function aggregateMacroSurprises(releases: MacroReleaseInput[]): {
  results: MacroSurpriseResult[];
  compositeGoldZ: number | null;
  b2ScoreAdjustment: number;
  dominantSummary: string | null;
} {
  if (!releases || releases.length === 0) {
    return { results: [], compositeGoldZ: null, b2ScoreAdjustment: 0, dominantSummary: null };
  }
  const results = releases.map(computeMacroSurprise);
  let wSum = 0;
  let zSum = 0;
  for (const r of results) {
    const w = MACRO_INDICATOR_SPECS[r.indicator].goldSensitivity;
    zSum += r.goldSurpriseZ * w;
    wSum += w;
  }
  const compositeGoldZ = wSum > 0 ? round(clamp(zSum / wSum, -3, 3), 2) : null;
  const b2ScoreAdjustment = compositeGoldZ != null ? round(clamp(compositeGoldZ * 8, -24, 24), 1) : 0;
  const top = results.slice().sort((a, b) => Math.abs(b.goldSurpriseZ) - Math.abs(a.goldSurpriseZ))[0];
  return {
    results,
    compositeGoldZ,
    b2ScoreAdjustment,
    dominantSummary: top ? top.summary : null,
  };
}

const INDICATOR_DETECTORS: Array<{ key: MacroIndicatorKey; pattern: RegExp; isNfpK?: boolean }> = [
  { key: 'CORE_PCE',     pattern: /核心\s*PCE|core\s+pce/i },
  { key: 'PCE',          pattern: /\bPCE\b/i },
  { key: 'CORE_CPI',     pattern: /核心\s*CPI|core\s+cpi/i },
  { key: 'CPI',          pattern: /\bCPI\b|消费者物价/i },
  { key: 'NFP',          pattern: /非农|non[-\s]?farm|NFP/i, isNfpK: true },
  { key: 'UNEMPLOYMENT', pattern: /失业率|unemployment\s+rate/i },
  { key: 'FOMC_RATE',    pattern: /美联储.*利率|联邦基金利率|FOMC.*rate|fed\s+funds/i },
  { key: 'ISM_PMI',      pattern: /ISM.*PMI|制造业\s*PMI/i },
  { key: 'RETAIL_SALES', pattern: /零售销售|retail\s+sales/i },
  { key: 'GDP',          pattern: /\bGDP\b/i },
];

/**
 * 从中英文财经标题/摘要中启发式抽取「实际值 vs 预期值」结构化预期差。
 * 示例：
 *   - "美国CPI同比公布2.9%，预期2.7%" -> CPI actual=2.9, consensus=2.7
 *   - "非农就业新增12万人，低于预期18万" -> NFP actual=12, consensus=18
 *   - "US Core CPI actual 3.1% vs consensus 3.3%" -> CORE_CPI actual=3.1, consensus=3.3
 */
export function extractMacroSurpriseFromText(text: string): MacroSurpriseResult | null {
  const s = String(text || '');
  if (!s.trim()) return null;

  const matched = INDICATOR_DETECTORS.find(d => d.pattern.test(s));
  if (!matched) return null;

  // 1) 中文「公布/录得/新增 X ... 预期/预测 Y」
  const cnMatch = s.match(
    /(?:公布|录得|实际|新增|为|达|报)\s*([+-]?\d+(?:\.\d+)?)\s*(%|万|万人|千|K|点)?[^。\n]{0,24}?(?:预期|市场预期|预测|共识|vs\.?)\s*(?:为|的)?\s*([+-]?\d+(?:\.\d+)?)\s*(%|万|万人|千|K|点)?/i,
  );
  // 2) 简写「CPI 2.9% vs 预期 2.7%」或「actual 3.1% vs consensus 3.3%」
  const vsMatch = !cnMatch
    ? s.match(
        /([+-]?\d+(?:\.\d+)?)\s*(%|万|万人|k|K)?\s*(?:vs\.?|对比|高于预期|低于预期|超预期|不及预期|预期)\s*(?:consensus|expected|forecast|预期|市场预期)?\s*([+-]?\d+(?:\.\d+)?)\s*(%|万|万人|k|K)?/i,
      )
    : null;

  const m = cnMatch || vsMatch;
  if (!m) return null;

  let actual = parseFloat(m[1]);
  let consensus = parseFloat(m[3]);
  if (!Number.isFinite(actual) || !Number.isFinite(consensus)) return null;

  // 非农单位统一为「万人」（若文本给的是千人/K，如 120K -> 12 万人）
  if (matched.isNfpK) {
    const u1 = (m[2] || '').toLowerCase();
    const u2 = (m[4] || '').toLowerCase();
    if (u1 === 'k' || u1 === '千' || (!u1 && Math.abs(actual) > 50)) actual = round(actual / 10, 2);
    if (u2 === 'k' || u2 === '千' || (!u2 && Math.abs(consensus) > 50)) consensus = round(consensus / 10, 2);
  }

  return computeMacroSurprise({
    indicator: matched.key,
    actual,
    consensus,
  });
}
