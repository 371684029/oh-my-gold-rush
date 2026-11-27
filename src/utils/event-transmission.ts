// 事件 → 黄金传导 — 只展示利率/美元/避险通道；无传导则明确「可忽略热点」
// Explain 层：不改仓位算法，只压缩噪声
//
// 暂定（2026-07-24）：不进入 quant-score / event_heat 权重。
// 理由：热点对金方向不稳、易与美元/利率对冲、文本难复现 → 加分易成噪音。
// 详见 docs/USER-VALUE.md §3.1

import type { MarketData } from '../types/market.js';
import type { SentimentAnalysis, TailRisk } from '../types/analysis.js';
import type { MacroRegime } from './macro-regime.js';
import type { CausalChainMatch } from './gold-causal-rules.js';

export type TransmissionChannel = 'rates' | 'dollar' | 'risk';

export interface TransmissionLeg {
  channel: TransmissionChannel;
  label: string;
  /** supportive / headwind / mixed / quiet */
  bias: 'supportive' | 'headwind' | 'mixed' | 'quiet';
  evidence: string;
  /** 0–100 展示用，quiet 通常很低 */
  strength: number;
}

export interface EventGoldTransmission {
  /** 是否有值得看的传导（否则用户可跳过热点） */
  actionable: boolean;
  headline: string;
  legs: TransmissionLeg[];
  /** 地缘/事件原文摘录（可空） */
  eventSnippet: string | null;
  /** 给用户的一句话 SOP */
  sop: string;
  /** 操作含义：从不直接给加减仓，只提示阅读 */
  readingHint: string;
  /** v2.5 跨市场真伪核验状态 */
  veracityStatus?: 'confirmed' | 'bait_suspected' | 'noise_filtered' | 'quiet';
  /** v2.5 真伪核验标签 */
  veracityBadge?: string;
  /** v2.5 钓鱼/派发/诱空警示（无则 null） */
  baitWarning?: string | null;
}

function parseVix(vixText: string | undefined): number | null {
  if (!vixText) return null;
  const m = vixText.match(/(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : null;
}

function geoLevel(text: string | undefined): 'high' | 'medium' | 'low' | 'unknown' {
  if (!text) return 'unknown';
  if (/高|升级|战争|冲突加剧|开战|袭击|escalat|war|conflict/i.test(text)) return 'high';
  if (/低|缓和|降温|de[- ]?escalat/i.test(text)) return 'low';
  return 'medium';
}

function tipBias(tips: number | null | undefined, tipsChangeHint: number | null): TransmissionLeg {
  // tips level high → headwind; falling tips → supportive
  let bias: TransmissionLeg['bias'] = 'quiet';
  let evidence = '实际利率数据不足';
  let strength = 15;
  if (tips != null && Number.isFinite(tips)) {
    if (tips >= 2.0) {
      bias = 'headwind';
      evidence = `TIPS 约 ${tips.toFixed(2)}%（偏高，压制金价）`;
      strength = 70;
    } else if (tips <= 1.2) {
      bias = 'supportive';
      evidence = `TIPS 约 ${tips.toFixed(2)}%（偏低，利多金）`;
      strength = 65;
    } else {
      bias = 'mixed';
      evidence = `TIPS 约 ${tips.toFixed(2)}%（中性区）`;
      strength = 35;
    }
  }
  if (tipsChangeHint != null && Math.abs(tipsChangeHint) >= 0.05) {
    if (tipsChangeHint > 0) {
      bias = bias === 'supportive' ? 'mixed' : 'headwind';
      evidence += ` · 较近变化 +${tipsChangeHint.toFixed(2)}pt`;
      strength = Math.min(90, strength + 15);
    } else {
      bias = bias === 'headwind' ? 'mixed' : 'supportive';
      evidence += ` · 较近变化 ${tipsChangeHint.toFixed(2)}pt`;
      strength = Math.min(90, strength + 15);
    }
  }
  return { channel: 'rates', label: '实际利率/联储路径', bias, evidence, strength };
}

function dollarBias(dxyChange: number | null | undefined): TransmissionLeg {
  let bias: TransmissionLeg['bias'] = 'quiet';
  let evidence = '美元变动不明或不显著';
  let strength = 15;
  if (dxyChange != null && Number.isFinite(dxyChange)) {
    if (dxyChange <= -0.3) {
      bias = 'supportive';
      evidence = `美元日变约 ${dxyChange.toFixed(2)}%（走弱利多金）`;
      strength = 65;
    } else if (dxyChange >= 0.4) {
      bias = 'headwind';
      evidence = `美元日变约 +${dxyChange.toFixed(2)}%（走强利空金）`;
      strength = 65;
    } else {
      bias = 'quiet';
      evidence = `美元日变约 ${dxyChange > 0 ? '+' : ''}${dxyChange.toFixed(2)}%（不足以降噪）`;
      strength = 25;
    }
  }
  return { channel: 'dollar', label: '美元', bias, evidence, strength };
}

function riskBias(
  geo: ReturnType<typeof geoLevel>,
  vix: number | null,
  tailRisks: TailRisk[] | undefined,
  geoText: string | undefined,
): TransmissionLeg {
  let bias: TransmissionLeg['bias'] = 'quiet';
  let strength = 15;
  const bits: string[] = [];

  if (geo === 'high') {
    bias = 'supportive'; // 避险倾向利多金（但常被美元对冲）
    strength = 55;
    bits.push('地缘风险偏高（避险叙事）');
  } else if (geo === 'low') {
    bits.push('地缘风险偏低');
    strength = 20;
  }

  if (vix != null) {
    if (vix >= 25) {
      bias = bias === 'quiet' ? 'supportive' : bias;
      strength = Math.max(strength, 60);
      bits.push(`VIX≈${vix}（风险偏好降温）`);
    } else if (vix <= 14) {
      bits.push(`VIX≈${vix}（风险偏好偏稳）`);
    } else {
      bits.push(`VIX≈${vix}`);
    }
  }

  const geoTails = (tailRisks ?? []).filter(t =>
    /地缘|战争|冲突|制裁|恐怖|war|geopolit/i.test(`${t.risk ?? ''} ${t.trigger ?? ''} ${t.impact ?? ''}`),
  );
  if (geoTails.length) {
    strength = Math.max(strength, 50);
    if (bias === 'quiet') bias = 'mixed';
    bits.push(`尾部提及：${geoTails[0].risk}`);
  }

  if (geoText && geoText.length > 8 && geo !== 'unknown') {
    bits.push(geoText.slice(0, 48));
  }

  if (!bits.length) {
    bits.push('未见清晰避险/地缘量化信号');
  }

  return {
    channel: 'risk',
    label: '风险偏好/避险',
    bias,
    evidence: bits.join(' · '),
    strength,
  };
}

export interface BuildTransmissionInput {
  marketData?: MarketData | null;
  sentiment?: Pick<SentimentAnalysis, 'geopoliticalRisk' | 'vix'> | null;
  macroRegime?: Pick<MacroRegime, 'tag' | 'label'> | null;
  tailRisks?: TailRisk[] | null;
  causalChains?: CausalChainMatch[] | null;
  /** 可选：较昨日 TIPS 变化（百分点） */
  tipsDelta?: number | null;
}

/**
 * 构建事件→黄金传导卡（含 v2.5 跨市场防钓鱼证伪）
 */
export function buildEventGoldTransmission(input: BuildTransmissionInput): EventGoldTransmission {
  const m = input.marketData;
  const tips = m?.usTreasury?.tips?.value ?? null;
  const dxyChange = m?.dollarIndex?.value?.change ?? null;
  const goldChange = m?.london?.price?.change ?? null;
  const geoText = input.sentiment?.geopoliticalRisk;
  const geo = geoLevel(geoText);
  const vix = parseVix(input.sentiment?.vix);

  const legs: TransmissionLeg[] = [
    tipBias(tips, input.tipsDelta ?? null),
    dollarBias(dxyChange),
    riskBias(geo, vix, input.tailRisks ?? undefined, geoText),
  ];

  // 因果链增强：命中则抬对应通道 strength
  for (const c of input.causalChains ?? []) {
    if (/利率|TIPS|实际利率/.test(c.cause + c.effect)) {
      const leg = legs.find(l => l.channel === 'rates')!;
      leg.strength = Math.min(95, leg.strength + 10);
      if (leg.bias === 'quiet') leg.bias = 'mixed';
    }
    if (/美元/.test(c.cause + c.effect)) {
      const leg = legs.find(l => l.channel === 'dollar')!;
      leg.strength = Math.min(95, leg.strength + 10);
    }
    if (/避险|地缘|风险/.test(c.cause + c.effect)) {
      const leg = legs.find(l => l.channel === 'risk')!;
      leg.strength = Math.min(95, leg.strength + 10);
    }
  }

  if (input.macroRegime?.tag === 'real_rate_headwind') {
    const leg = legs.find(l => l.channel === 'rates')!;
    leg.bias = 'headwind';
    leg.strength = Math.max(leg.strength, 70);
    leg.evidence += ` · 宏观阶段「${input.macroRegime.label}」`;
  }

  const loud = legs.filter(l => l.strength >= 50 && l.bias !== 'quiet');
  const conflict =
    loud.some(l => l.bias === 'supportive') && loud.some(l => l.bias === 'headwind');

  const ratesLeg = legs.find(l => l.channel === 'rates')!;
  const dollarLeg = legs.find(l => l.channel === 'dollar')!;
  const riskLeg = legs.find(l => l.channel === 'risk')!;

  // v2.5 跨市场防钓鱼证伪：
  // 1) 避险/地缘叙事喊多，但实际利率或美元逆风且金价不涨反跌 => 疑似利多钓鱼/高位派发
  // 2) 宏观利空通道主导，但金价放量逆势大涨 => 疑似利空诱空/已充分计价
  let veracityStatus: EventGoldTransmission['veracityStatus'] = 'quiet';
  let veracityBadge = '— 无显著事件催化';
  let baitWarning: string | null = null;

  const bullBait =
    riskLeg.bias === 'supportive'
    && (
      ((ratesLeg.bias === 'headwind' || dollarLeg.bias === 'headwind') && (goldChange == null || goldChange <= 0.15))
      || (goldChange != null && goldChange <= -0.5)
    );
  const bearBait =
    loud.length > 0
    && loud.every(l => l.bias === 'headwind')
    && goldChange != null
    && goldChange >= 0.5;

  const actionable = loud.length > 0;
  if (bullBait) {
    veracityStatus = 'bait_suspected';
    veracityBadge = '⚠️ 疑似利多钓鱼/跨市场证伪';
    const pxStr = goldChange != null ? `伦敦金反跌 ${goldChange.toFixed(2)}%` : '利率/美元硬通道逆风';
    baitWarning = `地缘/避险叙事偏多但${pxStr}，谨防高位利多派发或消息试探气球，勿凭标题追高。`;
  } else if (bearBait) {
    veracityStatus = 'bait_suspected';
    veracityBadge = '⚠️ 疑似利空诱空/市场反向走强';
    baitWarning = `宏观通道偏利空但伦敦金逆势上涨 +${goldChange!.toFixed(2)}%，警惕利空出尽或诱空洗盘。`;
  } else if (!actionable) {
    veracityStatus = 'quiet';
    veracityBadge = '— 无显著事件催化';
  } else if (conflict) {
    veracityStatus = 'noise_filtered';
    veracityBadge = '⚠️ 通道分歧/需二次核验';
  } else {
    veracityStatus = 'confirmed';
    veracityBadge = '✅ 跨市场三通道同向确认';
  }

  let headline: string;
  if (!actionable) {
    headline = '热点对金价传导不清，可忽略标题党';
  } else if (conflict) {
    headline = '多通道互相打架（常见：避险利多 vs 美元/利率利空）——先看数字通道，勿单看战争标题';
  } else if (loud.every(l => l.bias === 'supportive')) {
    headline = '传导偏利多金（利率/美元/避险中有支撑）';
  } else if (loud.every(l => l.bias === 'headwind')) {
    headline = '传导偏利空金（利率或美元逆风为主）';
  } else {
    headline = '存在部分传导，强度有限';
  }

  const eventSnippet = geoText && geoText.trim().length > 4 ? geoText.trim().slice(0, 120) : null;

  return {
    actionable,
    headline,
    legs,
    eventSnippet,
    sop: '每条热点只问：改利率？改美元？改避险？且需看真金白银（TIPS/DXY/金价）二阶反应证伪。',
    readingHint: baitWarning
      ? `防钓鱼提示：${baitWarning}`
      : actionable
        ? (conflict
          ? '阅读：对照双打分与仓位%；冲突时维持定投，不把战争当满仓理由。'
          : '阅读：把本卡与「较昨日驱动」对照；一致才提高关注，仍以仓位%为准。')
        : '阅读：跳过新闻长文，只看仓位%、较昨日与对错行即可。',
    veracityStatus,
    veracityBadge,
    baitWarning,
  };
}

function biasZh(b: TransmissionLeg['bias']): string {
  switch (b) {
    case 'supportive': return '利多金';
    case 'headwind': return '利空金';
    case 'mixed': return '混杂';
    default: return '静默';
  }
}

export function formatTransmissionConsole(t: EventGoldTransmission, indent = '  '): string {
  const lines = [
    `${indent}🛰️ 事件→黄金传导${t.veracityBadge ? `  [${t.veracityBadge}]` : ''}`,
    `${indent}  ${t.headline}`,
  ];
  for (const leg of t.legs) {
    if (leg.strength < 25 && leg.bias === 'quiet') continue;
    lines.push(`${indent}  · ${leg.label}：${biasZh(leg.bias)}（${leg.strength}）— ${leg.evidence}`);
  }
  if (t.baitWarning) {
    lines.push(`${indent}  ⚠️ ${t.baitWarning}`);
  }
  lines.push(`${indent}  ${t.readingHint}`);
  return lines.join('\n');
}

export function formatTransmissionMarkdown(t: EventGoldTransmission): string {
  const lines = [
    '## 🛰️ 事件→黄金传导',
    '',
    `> **${t.headline}**${t.veracityBadge ? `  \`${t.veracityBadge}\`` : ''}`,
    '',
    t.sop,
    '',
    '| 通道 | 偏向 | 强度 | 依据 |',
    '|------|------|------|------|',
  ];
  for (const leg of t.legs) {
    lines.push(`| ${leg.label} | ${biasZh(leg.bias)} | ${leg.strength} | ${leg.evidence} |`);
  }
  lines.push('');
  if (t.baitWarning) {
    lines.push(`- **⚠️ 防钓鱼警示**：${t.baitWarning}`);
  }
  if (t.eventSnippet) {
    lines.push(`- 事件摘录：${t.eventSnippet}`);
  }
  lines.push(`- **怎么读**：${t.readingHint}`);
  if (!t.actionable) {
    lines.push('- 💡 无有效传导：战争/热点标题可跳过，不进入操作讨论。');
  }
  lines.push('');
  return lines.join('\n');
}
