'use strict';

// GoldRush v2.5 — 消息面真伪甄别与跨市场防钓鱼证伪引擎（Web CJS 镜像）
// 与 src/utils/news-veracity.ts 保持完全一致的四道防线逻辑：
//   1. 信源分级（未知源降 C） 2. 匿名吹风/煽动识别 3. 跨市场三通道价格证伪 4. 钓鱼反向情绪提取

const RUMOR_OR_TRIAL_BALLOON_RE =
  /知情人士|消息人士|据传|网传|小作文|传闻|据说|听说|有消息称|sources\s*say|people\s*familiar|unnamed\s*official|rumou?r|unconfirmed/i;
const SENSATIONAL_HYPE_RE =
  /史诗级|必涨|必买|马上破|冲上\d+|崩盘预警|一夜暴富|惊天|重磅炸弹|暴涨倒计时|血洗|紧急逃命|shocking|guaranteed|skyrocket|crash\s*imminent/i;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round(v, digits = 2) {
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}

/**
 * 结合当日日报事件传导摘要与客观市场通道（TIPS / DXY / 金价日涨跌 / GLD 动量 / CFTC 拥挤度），
 * 执行跨市场真伪证伪并提取 S3 反向钓鱼警示。
 */
function auditDailyTransmissionVeracity(rec, feat, prevRec) {
  const tr = rec?.transmission;
  if (!tr || !Array.isArray(tr.channels) || tr.channels.length === 0) {
    return {
      status: 'quiet',
      badge: rec?.hasAiReport ? '— 无显著事件催化' : '— 无当日AI日报(重归一)',
      b2Score: null,
      b2Coverage: 0,
      marketConfirmation: 'unconfirmed',
      contrarianSentimentBias: 0,
      baitAlert: null,
      noiseShrinkageBoost: 0,
      evidenceLine: '当日无显著事件传导通道，已自动交由其余有效维度重归一',
    };
  }

  // 1) 从三通道计算事件面宣称的净方向
  let net = 0;
  let wSum = 0;
  let ratesBias = 0;
  let dollarBias = 0;
  let riskBias = 0;
  for (const ch of tr.channels) {
    const s = Math.max(1, ch.strength || 1);
    const sign = ch.bias === '利多金' ? 1 : ch.bias === '利空金' ? -1 : 0;
    net += sign * s;
    wSum += s;
    if (/利率|TIPS/i.test(ch.channel || '')) ratesBias = sign * s;
    else if (/美元|DXY/i.test(ch.channel || '')) dollarBias = sign * s;
    else if (/避险|风险|地缘/i.test(ch.channel || '')) riskBias = sign * s;
  }
  const rawScore = wSum > 0 ? Math.round(clamp(50 + (net / wSum) * 28, 18, 84)) : 50;
  const claimedSign = rawScore >= 56 ? 1 : rawScore <= 44 ? -1 : 0;

  // 2) 计算客观跨市场价格投票（真金白银二阶反应）
  const goldDailyRetPct =
    prevRec && prevRec.londonClose > 0 && rec.londonClose > 0
      ? ((rec.londonClose - prevRec.londonClose) / prevRec.londonClose) * 100
      : null;
  const dxyDailyRetPct =
    prevRec && prevRec.dxy > 0 && rec.dxy > 0
      ? ((rec.dxy - prevRec.dxy) / prevRec.dxy) * 100
      : null;
  const tipsDeltaBp =
    prevRec && prevRec.tipsYield != null && rec.tipsYield != null
      ? (rec.tipsYield - prevRec.tipsYield) * 100
      : null;

  let mSum = 0;
  let mW = 0;
  const evParts = [];
  if (tipsDeltaBp != null && Math.abs(tipsDeltaBp) >= 3) {
    mSum += clamp(-tipsDeltaBp / 10, -1, 1) * 0.35;
    mW += 0.35;
    evParts.push(`TIPS ${tipsDeltaBp > 0 ? '+' : ''}${round(tipsDeltaBp, 1)}bp`);
  }
  if (dxyDailyRetPct != null && Math.abs(dxyDailyRetPct) >= 0.25) {
    mSum += clamp(-dxyDailyRetPct / 0.8, -1, 1) * 0.25;
    mW += 0.25;
    evParts.push(`DXY ${dxyDailyRetPct > 0 ? '+' : ''}${round(dxyDailyRetPct, 2)}%`);
  }
  if (goldDailyRetPct != null && Math.abs(goldDailyRetPct) >= 0.45) {
    mSum += clamp(goldDailyRetPct / 1.5, -1, 1) * 0.30;
    mW += 0.30;
    evParts.push(`金价 ${goldDailyRetPct > 0 ? '+' : ''}${round(goldDailyRetPct, 2)}%`);
  }
  if (rec.gld5dRet != null && Math.abs(rec.gld5dRet) >= 1.2) {
    mSum += clamp(rec.gld5dRet / 4, -1, 1) * 0.10;
    mW += 0.10;
    evParts.push(`GLD5日 ${rec.gld5dRet > 0 ? '+' : ''}${round(rec.gld5dRet, 1)}%`);
  }

  const marketVote = mW > 0 ? mSum / mW : 0;
  const textAll = `${tr.verdict || ''} ${tr.excerpt || ''}`;
  const hasRumor = RUMOR_OR_TRIAL_BALLOON_RE.test(textAll);
  const hasHype = SENSATIONAL_HYPE_RE.test(textAll);

  // 特殊高发陷阱：地缘/战争标题单独喊多，但实际利率+美元双双逆风
  const geoOnlyDivergence = riskBias >= 40 && (ratesBias <= -40 || dollarBias <= -40);

  let marketConfirmation = 'unconfirmed';
  if (mW > 0 && claimedSign !== 0) {
    const align = claimedSign * marketVote;
    if (align >= 0.22) marketConfirmation = 'confirmed';
    else if (align <= -0.25) marketConfirmation = 'contradicted';
  }

  // 3) 裁决真消息 / 疑似钓鱼背离 / 噪音过滤
  if (
    (claimedSign !== 0 && marketConfirmation === 'contradicted')
    || (geoOnlyDivergence && (goldDailyRetPct == null || goldDailyRetPct < 0.2))
  ) {
    const isBullBait = claimedSign > 0 || (geoOnlyDivergence && claimedSign >= 0);
    const crowded = (rec.cftcPercentile ?? 50) >= 82;
    const biasMag = isBullBait ? (crowded ? -10 : -7) : 7;
    const baitAlert = isBullBait
      ? `防钓鱼警示：消息/地缘偏多但跨市场证伪（${evParts.slice(0, 2).join(' · ') || '债汇逆风'}），警惕利好派发忌追高`
      : `防诱空警示：消息偏空但市场反向走强（${evParts.slice(0, 2).join(' · ') || '实际利率/金价韧性'}），警惕恐慌错杀`;

    return {
      status: 'bait_suspected',
      badge: isBullBait ? '⚠️ 疑似利多钓鱼/背离' : '⚠️ 疑似利空诱空/背离',
      b2Score: null, // 剥离出事实层，不污染 B2，交由其余正交维度重归一
      b2Coverage: 0,
      marketConfirmation: 'contradicted',
      contrarianSentimentBias: biasMag,
      baitAlert,
      noiseShrinkageBoost: 0.15,
      evidenceLine: evParts.length > 0 ? `价格证伪：${evParts.join(' · ')}` : '地缘叙事与利率/美元硬通道冲突',
    };
  }

  if (hasRumor || hasHype) {
    return {
      status: 'noise_filtered',
      badge: '🚫 吹风/标题党已降权',
      b2Score: Math.round(50 + (rawScore - 50) * 0.35),
      b2Coverage: 0.4,
      marketConfirmation,
      contrarianSentimentBias: 0,
      baitAlert: '消息摘录含匿名吹风或情绪化措辞，B2 权重已自动压缩',
      noiseShrinkageBoost: 0.10,
      evidenceLine: evParts.length > 0 ? `待核实（${evParts.join(' · ')}）` : '含吹风措辞，降权观察',
    };
  }

  if (marketConfirmation === 'confirmed') {
    return {
      status: 'confirmed',
      badge: '✅ 跨市场实证确认',
      b2Score: rawScore,
      b2Coverage: 1,
      marketConfirmation: 'confirmed',
      contrarianSentimentBias: 0,
      baitAlert: null,
      noiseShrinkageBoost: 0,
      evidenceLine: `三通道共振确认：${evParts.join(' · ')}`,
    };
  }

  return {
    status: 'confirmed',
    badge: '✓ 日报三通道核验',
    b2Score: Math.round(50 + (rawScore - 50) * 0.75),
    b2Coverage: 0.8,
    marketConfirmation: 'unconfirmed',
    contrarianSentimentBias: 0,
    baitAlert: null,
    noiseShrinkageBoost: 0,
    evidenceLine: evParts.length > 0 ? `通道参考：${evParts.join(' · ')}` : '已按利率/美元/避险三通道压缩噪音',
  };
}

module.exports = {
  auditDailyTransmissionVeracity,
};
