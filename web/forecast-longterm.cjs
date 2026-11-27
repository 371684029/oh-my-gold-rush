'use strict';

// 黄金长期宏观周期预测引擎（1年 / 2年 / 5年 · 纯函数、严格因果零前视泄漏）
// 数据源：26年连续月线（Yahoo GC=F + DX-Y.NYB + FRED DFII10/DGS10/CPIAUCSL/DEXCHUS）
// 原则（对齐 AGENTS.md §8 与 long-term-outlook.ts）：
//   1. 1Y/2Y/5Y 与短期日线 RSI/MACD 完全脱钩，仅由慢变量（TIPS 实际利率、CPI 通胀、Gold/CPI 真实估值分位、美元36月周期、24月实现波动率）主导
//   2. 严格因果截断（仅使用 <= asOfYm 的月线与宏观观测），禁止任何未来信息泄漏
//   3. 每一个结论、每一个因子、每一个情景均附带 25 年历史实证统计与真实观测日期，做到有据可查、诚实标注不确定性

const { TROY_OUNCE_TO_GRAM, DEFAULT_USD_CNY } = require('./forecast-data.cjs');

const LONG_TERM_HORIZONS = [
  {
    key: '1y',
    months: 12,
    years: 1,
    histMonths: 36,
    label: '1年期（12个月 · 宏观周期）',
    shortLabel: '1年',
    trackName: '实际利率方向 + 通胀估值 + 美元周期（与日线噪音脱钩）',
    pillarWeights: { fundamental: 0.70, information: 0.20, technical: 0.10 },
    distWeights: { tips: 2.2, tipsChg12m: 2.0, realGoldPct: 1.7, dxyDev36m: 1.5, cpiYoY: 1.3, ma12Dev: 0.7, vol24m: 0.6 },
  },
  {
    key: '2y',
    months: 24,
    years: 2,
    histMonths: 48,
    label: '2年期（24个月 · 跨周期配置）',
    shortLabel: '2年',
    trackName: '实际利率周期 + 真实金价估值回归 + 美元与通胀中枢',
    pillarWeights: { fundamental: 0.75, information: 0.20, technical: 0.05 },
    distWeights: { tips: 2.4, tipsChg12m: 1.6, realGoldPct: 2.1, dxyDev36m: 1.5, cpiYoY: 1.5, ma12Dev: 0.3, vol24m: 0.5 },
  },
  {
    key: '5y',
    months: 60,
    years: 5,
    histMonths: 60,
    label: '5年期（60个月 · 长期资产配置）',
    shortLabel: '5年',
    trackName: '真实购买力估值(Gold/CPI) + 长期利率中枢 + 通胀复利（配置与定投视角）',
    pillarWeights: { fundamental: 0.80, information: 0.15, technical: 0.05 },
    distWeights: { tips: 2.4, realGoldPct: 2.6, cpiYoY: 1.7, dxyDev36m: 1.4, tipsChg12m: 0.9, ma12Dev: 0.15, vol24m: 0.4 },
  },
];

const SHRINKAGE_K_LONG = 8;

function round(v, digits = 2) {
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1);
  return Math.sqrt(Math.max(0, v));
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function weightedQuantilesBatch(values, weights, qs) {
  if (!values.length) return qs.map(() => 0);
  const pairs = [];
  let totalW = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const w = Math.max(0, weights[i] ?? 1);
    if (Number.isFinite(v) && w > 0) {
      pairs.push({ v, w });
      totalW += w;
    }
  }
  if (!pairs.length) return qs.map(() => 0);
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
        if (i === 0) return pairs[0].v;
        const frac = pairs[i].w > 0 ? (target - prevCum) / pairs[i].w : 0;
        return pairs[i - 1].v + (pairs[i].v - pairs[i - 1].v) * clamp(frac, 0, 1);
      }
    }
    return pairs[pairs.length - 1].v;
  });
}

function addMonthsYm(ym, offset) {
  const [y, m] = ym.split('-').map(Number);
  const total = y * 12 + (m - 1) + offset;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

function toCagrPct(cumPct, years) {
  if (!Number.isFinite(cumPct) || years <= 0) return 0;
  const gross = 1 + cumPct / 100;
  if (gross <= 0.05) return -99;
  return round((Math.pow(gross, 1 / years) - 1) * 100, 2);
}

function smaAt(arr, idx, period) {
  if (idx + 1 < period) return null;
  let s = 0;
  for (let i = idx - period + 1; i <= idx; i++) s += arr[i];
  return s / period;
}

/** 严格因果：计算截至第 idx 月的价值历史分位（0–100%） */
function causalPercentile(arr, idx, getter) {
  const cur = getter(arr[idx]);
  if (!Number.isFinite(cur)) return 50;
  let le = 0;
  let cnt = 0;
  for (let i = 0; i <= idx; i++) {
    const v = getter(arr[i]);
    if (Number.isFinite(v)) {
      cnt++;
      if (v <= cur) le++;
    }
  }
  return cnt > 0 ? round((le / cnt) * 100, 1) : 50;
}

/** 为历史月赋予直观可读的宏观时代标签（提升可审计说服力） */
function classifyMacroEra(row, feat) {
  const y = parseInt(row.ym.slice(0, 4), 10);
  if (y <= 2005) return '2003–2005 弱美元与加息初期';
  if (y <= 2007) return '2006–2007 高实际利率周期末段';
  if (y <= 2009) return '2008–2009 金融危机与零利率重启';
  if (y <= 2011) return '2010–2011 QE扩张与欧债高估值期';
  if (y <= 2015) return '2012–2015 实际利率回升与估值消化';
  if (y <= 2018) return '2016–2018 美联储加息筑底期';
  if (y === 2019) return '2019 降息拐点与贸易摩擦';
  if (y <= 2021) return '2020–2021 负实际利率与大通胀前夜';
  if (y <= 2023) return '2022–2023 激进加息与央行购金托底';
  if (feat.tips >= 2.0) return `${y} 高利率高位与避险重构`;
  return `${y} 宏观周期轮动期`;
}

/** 从月线序列提取严格因果的慢变量特征向量（仅使用 <= idx） */
function extractMonthlyFeatures(rows) {
  const closes = rows.map(r => r.londonClose);
  const feats = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const spot = closes[i];

    // 1) TIPS 实际利率（缺失则仅向过去回溯最多 2 个月）
    let tips = r.tips;
    for (let k = i - 1; k >= Math.max(0, i - 2) && tips == null; k--) {
      if (rows[k].tips != null) tips = rows[k].tips;
    }
    const hasTips = tips != null;

    // 2) TIPS 12 个月变动（百分点，正=收紧，负=宽松）
    let tipsChg12m = 0;
    if (hasTips && i >= 12) {
      let prevTips = rows[i - 12].tips;
      for (let k = i - 13; k >= Math.max(0, i - 14) && prevTips == null; k--) {
        if (rows[k].tips != null) prevTips = rows[k].tips;
      }
      if (prevTips != null) tipsChg12m = round(tips - prevTips, 3);
    }

    // 3) US CPI 同比通胀（%）
    let cpiYoY = r.cpiYoY;
    for (let k = i - 1; k >= Math.max(0, i - 3) && cpiYoY == null; k--) {
      if (rows[k].cpiYoY != null) cpiYoY = rows[k].cpiYoY;
    }

    // 4) 通胀调整后实际金价指数（Gold / CPI * 100）及 25 年因果历史分位
    let realGoldIndex = r.realGoldIndex;
    if (realGoldIndex == null && r.cpi > 0) {
      realGoldIndex = round((spot / r.cpi) * 100, 2);
    }
    const realGoldPct = causalPercentile(rows, i, x => x.realGoldIndex);

    // 5) 美元指数 DXY 相对 36 个月均值偏离（%）
    let dxy = r.dxy;
    for (let k = i - 1; k >= Math.max(0, i - 2) && dxy == null; k--) {
      if (rows[k].dxy != null) dxy = rows[k].dxy;
    }
    let dxyDev36m = 0;
    if (dxy != null) {
      const winStart = Math.max(0, i - 35);
      let s = 0;
      let cnt = 0;
      for (let k = winStart; k <= i; k++) {
        if (rows[k].dxy != null) { s += rows[k].dxy; cnt++; }
      }
      if (cnt >= 6) {
        const dMa36 = s / cnt;
        dxyDev36m = round(((dxy - dMa36) / dMa36) * 100, 2);
      }
    }

    // 6) 金价相对 12 个月均线偏离（%）
    const ma12 = smaAt(closes, i, Math.min(12, i + 1)) || spot;
    const ma12Dev = ma12 > 0 ? round(((spot - ma12) / ma12) * 100, 2) : 0;

    // 7) 24 个月实现月波动率 σ_m（%，对数月收益标准差）
    const volStart = Math.max(1, i - 23);
    const rets = [];
    for (let k = volStart; k <= i; k++) {
      if (closes[k] > 0 && closes[k - 1] > 0) {
        rets.push(Math.log(closes[k] / closes[k - 1]) * 100);
      }
    }
    const vol24m = rets.length >= 6 ? clamp(std(rets), 2.0, 7.5) : 4.4;

    feats.push({
      hasTips,
      tips: tips ?? 1.5,
      tipsRaw: tips ?? null,
      tipsChg12m,
      cpiYoY: cpiYoY ?? 2.5,
      cpiYoYRaw: cpiYoY ?? null,
      realGoldIndex: realGoldIndex ?? null,
      realGoldPct,
      dxy: dxy ?? 100,
      dxyRaw: dxy ?? null,
      dxyDev36m,
      ma12Dev,
      vol24m: round(vol24m, 2),
      us10yRaw: r.us10y ?? null,
    });
  }

  return feats;
}

/** 基于 25 年真实历史窗口计算特定宏观条件下的实证收益统计（彻底杜绝拍脑袋！） */
function computeEmpiricalSlice(sampleEntries, predicate, years) {
  const matched = sampleEntries.filter(predicate);
  if (matched.length < 3) return null;
  const rets = matched.map(m => m.rawEndPct);
  const cagrs = matched.map(m => m.cagrPct);
  const medRet = round(median(rets), 1);
  const medCagr = round(median(cagrs), 1);
  const winRate = round((rets.filter(v => v > 0).length / rets.length) * 100, 0);
  const beatCpiList = matched.filter(m => m.beatCpi != null);
  const beatCpiRate = beatCpiList.length >= 3
    ? round((beatCpiList.filter(m => m.beatCpi).length / beatCpiList.length) * 100, 0)
    : null;
  return {
    n: matched.length,
    medRet,
    medCagr,
    winRate,
    beatCpiRate,
    years,
  };
}

/** 构造长期三面依据（基本面 70–80%，彻底与日线 RSI 脱钩） */
function buildLongTermPillars(cfg, curRow, curFeat, dailyRec, sampleEntries, upEndProb, beatCpiProb) {
  // 1) 基本面（慢变量综合：TIPS水平 + TIPS 12M变化 + Gold/CPI 估值分位 + CPI + DXY 36M）
  const tipsLevelS = clamp(56 - (curFeat.tips - 1.2) * 14, 22, 82);
  const tipsChgS = clamp(50 - curFeat.tipsChg12m * 18, 22, 82);
  // 估值分位越高，长期均值回归压制越明显（防止高位盲目线性外推！）
  const valS = clamp(76 - curFeat.realGoldPct * 0.52, 24, 78);
  const cpiS = clamp(44 + curFeat.cpiYoY * 4.2, 32, 76);
  const dxyS = clamp(50 - curFeat.dxyDev36m * 2.2, 25, 78);

  const fundScore = Math.round(
    cfg.years >= 5
      ? tipsLevelS * 0.28 + valS * 0.34 + cpiS * 0.22 + dxyS * 0.16
      : tipsLevelS * 0.30 + tipsChgS * 0.22 + valS * 0.24 + cpiS * 0.12 + dxyS * 0.12,
  );

  const tipsDateTag = curRow.tipsObsDate ? ` (${curRow.tipsObsDate})` : '';
  const cpiDateTag = curRow.cpiObsDate ? ` (${curRow.cpiObsDate.slice(0, 7)})` : '';
  const fundMetrics = [
    {
      k: '10Y TIPS 实际利率',
      v: curFeat.tipsRaw != null ? `${round(curFeat.tipsRaw, 2)}%${tipsDateTag}` : '—',
      tone: curFeat.tips >= 2.0 ? 'bear' : curFeat.tips <= 0.8 ? 'bull' : 'neutral',
    },
    {
      k: 'TIPS 12个月变化',
      v: `${curFeat.tipsChg12m >= 0 ? '+' : ''}${Math.round(curFeat.tipsChg12m * 100)}bp`,
      tone: curFeat.tipsChg12m <= -0.35 ? 'bull' : curFeat.tipsChg12m >= 0.35 ? 'bear' : 'neutral',
    },
    {
      k: '实际金价估值(Gold/CPI)',
      v: `第 ${Math.round(curFeat.realGoldPct)}% 分位 (25年)`,
      tone: curFeat.realGoldPct >= 82 ? 'bear' : curFeat.realGoldPct <= 30 ? 'bull' : 'neutral',
    },
    {
      k: '美国 CPI 同比通胀',
      v: curFeat.cpiYoYRaw != null ? `${round(curFeat.cpiYoYRaw, 2)}%${cpiDateTag}` : '—',
      tone: curFeat.cpiYoY >= 2.8 ? 'bull' : 'neutral',
    },
    {
      k: '美元 DXY 相对36月均值',
      v: `${round(curFeat.dxy, 1)} (${curFeat.dxyDev36m >= 0 ? '+' : ''}${round(curFeat.dxyDev36m, 1)}%)`,
      tone: curFeat.dxyDev36m >= 3 ? 'bear' : curFeat.dxyDev36m <= -3 ? 'bull' : 'neutral',
    },
  ];

  // 2) 结构性资金与抗通胀护城河（CFTC 长期分位 + 跑赢 CPI 实证概率 + 央行/ETF 结构）
  const flowBase = dailyRec?.officialFlowScore ?? dailyRec?.flowScore ?? 55;
  const cpiEdge = beatCpiProb != null ? clamp(35 + (beatCpiProb - 40) * 0.7, 30, 80) : 55;
  const infoScore = Math.round(flowBase * 0.45 + cpiEdge * 0.55);
  const infoMetrics = [
    {
      k: `${cfg.shortLabel}跑赢美国CPI概率`,
      v: beatCpiProb != null ? `${beatCpiProb}% (25年实证)` : '—',
      tone: (beatCpiProb ?? 50) >= 60 ? 'bull' : (beatCpiProb ?? 50) <= 45 ? 'bear' : 'neutral',
    },
    {
      k: `${cfg.shortLabel}期末正收益概率`,
      v: `${upEndProb}% (${sampleEntries.length} 个历史窗口)`,
      tone: upEndProb >= 60 ? 'bull' : upEndProb <= 45 ? 'bear' : 'neutral',
    },
    {
      k: 'CFTC 净多头分位',
      v: dailyRec?.cftcPercentile != null ? `${Math.round(dailyRec.cftcPercentile)}% (${dailyRec.cftcObsDate || '最新'})` : '央行/ETF长期结构',
      tone: (dailyRec?.cftcPercentile ?? 50) >= 85 ? 'bear' : (dailyRec?.cftcPercentile ?? 50) <= 25 ? 'bull' : 'neutral',
    },
  ];

  // 3) 长期月线趋势与波动定标（刻意不引入日线 RSI/MACD）
  const ma12ToneScore = curFeat.ma12Dev >= 20
    ? clamp(58 - (curFeat.ma12Dev - 20) * 0.9, 36, 58)
    : clamp(50 + curFeat.ma12Dev * 0.85, 32, 72);
  const techScore = Math.round(ma12ToneScore);
  const techMetrics = [
    {
      k: '现价相对 12月均线',
      v: `${curFeat.ma12Dev >= 0 ? '+' : ''}${round(curFeat.ma12Dev, 1)}%`,
      tone: curFeat.ma12Dev >= 22 ? 'bear' : curFeat.ma12Dev >= 2 ? 'bull' : curFeat.ma12Dev <= -5 ? 'bear' : 'neutral',
    },
    {
      k: '24个月实现月波动率 σ_m',
      v: `${curFeat.vol24m}%/月 (年化 ${round(curFeat.vol24m * Math.sqrt(12), 1)}%)`,
      tone: curFeat.vol24m >= 5.5 ? 'bear' : 'neutral',
    },
    {
      k: '短期日线噪音隔离',
      v: '已脱钩 RSI / MACD 日线指标',
      tone: 'neutral',
    },
  ];

  const toDir = (s) => (s >= 58 ? { code: 'bullish', label: '偏多' } : s <= 42 ? { code: 'bearish', label: '谨慎' } : { code: 'neutral', label: '中性' });

  return {
    fundamental: {
      key: 'fundamental',
      title: '基本面慢变量（主导）',
      subtitle: '25年 TIPS · CPI · 真实金价估值 · 美元周期',
      score: fundScore,
      ...toDir(fundScore),
      weightPct: Math.round(cfg.pillarWeights.fundamental * 100),
      metrics: fundMetrics,
      summary: curFeat.realGoldPct >= 80 && curFeat.tips >= 2.0
        ? `实际利率（${round(curFeat.tips, 2)}%）与通胀调整金价（第 ${Math.round(curFeat.realGoldPct)}% 分位）双高，长期仍具抗通胀底色，但需防范估值消化回撤，宜分批定投而非一次性重仓追高。`
        : curFeat.tips <= 1.0
          ? `低实际利率（${round(curFeat.tips, 2)}%）显著降低持有黄金的机会成本，基本面周期对未来 ${cfg.shortLabel} 中枢形成较强顺风支撑。`
          : `实际利率与美元周期处于再平衡阶段，黄金长期回报主要由通胀复利与利率拐点共同驱动。`,
    },
    information: {
      key: 'information',
      title: '跨周期实证与结构',
      subtitle: '25年抗通胀胜率 · 央行/ETF 资金底盘',
      score: infoScore,
      ...toDir(infoScore),
      weightPct: Math.round(cfg.pillarWeights.information * 100),
      metrics: infoMetrics,
      summary: `过去 25 年真实月线显示，持有黄金 ${cfg.shortLabel} 的正收益概率为 ${upEndProb}%${beatCpiProb != null ? `，跑赢美国同期 CPI 通胀的概率为 ${beatCpiProb}%` : ''}；长期视角以配置护城河为核心。`,
    },
    technical: {
      key: 'technical',
      title: '长期均线与波动定标',
      subtitle: '12月趋势 · 24月实现波动率 FHS 缩放',
      score: techScore,
      ...toDir(techScore),
      weightPct: Math.round(cfg.pillarWeights.technical * 100),
      metrics: techMetrics,
      summary: `严格按金融学时间尺度将 ${cfg.shortLabel} 预测与短期 RSI/MACD 脱钩，仅保留 12 月长期趋势与 24 月实现波动率（年化 ${round(curFeat.vol24m * Math.sqrt(12), 1)}%）用于校准概率带宽。`,
    },
  };
}

/** 构造可审计的因子归因证据链（每一项均附真实观测日期、25年分位与25年实证回测数字） */
function buildFactorAudit(cfg, rows, feats, asOfIdx, sampleEntries, curRow, curFeat) {
  const years = cfg.years;
  const hName = cfg.shortLabel;

  const fmtEmp = (emp, condLabel) => {
    if (!emp) return `25年历史中处于「${condLabel}」的完整 ${hName} 窗口样本不足，自动向全样本无条件分布收缩`;
    const sign = emp.medCagr >= 0 ? '+' : '';
    const cumSign = emp.medRet >= 0 ? '+' : '';
    const base = `25年「${condLabel}」共 ${emp.n} 个起点月：随后 ${hName} 累计中位数 ${cumSign}${emp.medRet}%（年化 ${sign}${emp.medCagr}%），收涨概率 ${emp.winRate}%`;
    return emp.beatCpiRate != null ? `${base}，跑赢通胀 ${emp.beatCpiRate}%` : base;
  };

  // 1) 10Y TIPS 实际利率水平
  const tipsPct25y = causalPercentile(feats, asOfIdx, f => f.tipsRaw);
  const tipsBucket = curFeat.tips >= 2.0
    ? { label: 'TIPS ≥ 2.0% 高实际利率', pred: e => e.feat.tips >= 2.0, impact: 'bear', impactLabel: '机会成本压制' }
    : curFeat.tips <= 0.5
      ? { label: 'TIPS ≤ 0.5% 低/负实际利率', pred: e => e.feat.tips <= 0.5, impact: 'bull', impactLabel: '显著顺风' }
      : { label: '0.5% < TIPS < 2.0% 中性利率', pred: e => e.feat.tips > 0.5 && e.feat.tips < 2.0, impact: 'neutral', impactLabel: '中性均衡' };
  const empTips = computeEmpiricalSlice(sampleEntries, tipsBucket.pred, years);

  // 2) TIPS 12个月变化方向
  const tipsChgPct25y = causalPercentile(feats, asOfIdx, f => f.tipsChg12m);
  const tipsChgBp = Math.round(curFeat.tipsChg12m * 100);
  const tipsChgBucket = curFeat.tipsChg12m <= -0.25
    ? { label: 'TIPS 近12月下行 ≥25bp', pred: e => e.feat.tipsChg12m <= -0.25, impact: 'bull', impactLabel: '宽松拐点利多' }
    : curFeat.tipsChg12m >= 0.25
      ? { label: 'TIPS 近12月上行 ≥25bp', pred: e => e.feat.tipsChg12m >= 0.25, impact: 'bear', impactLabel: '利率收紧逆风' }
      : { label: 'TIPS 近12月变动 ±25bp 内', pred: e => Math.abs(e.feat.tipsChg12m) < 0.25, impact: 'neutral', impactLabel: '利率走平' };
  const empTipsChg = computeEmpiricalSlice(sampleEntries, tipsChgBucket.pred, years);

  // 3) 通胀调整后实际金价估值（Gold / CPI）
  const valBucket = curFeat.realGoldPct >= 75
    ? { label: '实际金价估值 ≥75% 高分位', pred: e => e.feat.realGoldPct >= 75, impact: 'bear', impactLabel: '估值偏贵·防回撤' }
    : curFeat.realGoldPct <= 35
      ? { label: '实际金价估值 ≤35% 低分位', pred: e => e.feat.realGoldPct <= 35, impact: 'bull', impactLabel: '低估安全边际' }
      : { label: '实际金价估值 35%–75% 中位', pred: e => e.feat.realGoldPct > 35 && e.feat.realGoldPct < 75, impact: 'neutral', impactLabel: '估值合理' };
  const empVal = computeEmpiricalSlice(sampleEntries, valBucket.pred, years);

  // 4) 美国 CPI 同比通胀
  const cpiPct25y = causalPercentile(feats, asOfIdx, f => f.cpiYoYRaw);
  const cpiBucket = curFeat.cpiYoY >= 3.0
    ? { label: '美国 CPI 同比 ≥ 3.0%', pred: e => e.feat.cpiYoY >= 3.0, impact: 'bull', impactLabel: '抗通胀需求支撑' }
    : curFeat.cpiYoY <= 1.5
      ? { label: '美国 CPI 同比 ≤ 1.5%', pred: e => e.feat.cpiYoY <= 1.5, impact: 'neutral', impactLabel: '低通胀平缓' }
      : { label: '美国 CPI 同比 1.5%–3.0%', pred: e => e.feat.cpiYoY > 1.5 && e.feat.cpiYoY < 3.0, impact: 'neutral', impactLabel: '温和通胀' };
  const empCpi = computeEmpiricalSlice(sampleEntries, cpiBucket.pred, years);

  // 5) 美元指数 DXY 相对 36 个月均值
  const dxyPct25y = causalPercentile(feats, asOfIdx, f => f.dxyRaw);
  const dxyBucket = curFeat.dxyDev36m >= 3.0
    ? { label: 'DXY 高于36月均值 ≥3%', pred: e => e.feat.dxyDev36m >= 3.0, impact: 'bear', impactLabel: '强美元压制' }
    : curFeat.dxyDev36m <= -3.0
      ? { label: 'DXY 低于36月均值 ≥3%', pred: e => e.feat.dxyDev36m <= -3.0, impact: 'bull', impactLabel: '弱美元顺风' }
      : { label: 'DXY 处于36月均值 ±3% 内', pred: e => Math.abs(e.feat.dxyDev36m) < 3.0, impact: 'neutral', impactLabel: '汇率中枢稳定' };
  const empDxy = computeEmpiricalSlice(sampleEntries, dxyBucket.pred, years);

  // 6) 24个月实现月波动率 σ_m
  const volPct25y = causalPercentile(feats, asOfIdx, f => f.vol24m);
  const volBucket = curFeat.vol24m >= 5.0
    ? { label: '月波动率 ≥ 5.0% 高波阶段', pred: e => e.feat.vol24m >= 5.0, impact: 'neutral', impactLabel: '区间加宽' }
    : { label: '月波动率 < 5.0% 常态波动', pred: e => e.feat.vol24m < 5.0, impact: 'neutral', impactLabel: '常规带宽' };
  const empVol = computeEmpiricalSlice(sampleEntries, volBucket.pred, years);

  return [
    {
      factor: '10Y TIPS 实际利率',
      currentValue: curFeat.tipsRaw != null ? `${round(curFeat.tipsRaw, 2)}%` : '—',
      sourceDate: `FRED DFII10 · ${curRow.tipsObsDate || curRow.date}`,
      percentile25y: `第 ${Math.round(tipsPct25y)}% 分位`,
      impact: tipsBucket.impact,
      impactLabel: tipsBucket.impactLabel,
      empiricalStat: fmtEmp(empTips, tipsBucket.label),
      mechanism: '黄金无票息，美债实际收益率决定长期持有黄金的机会成本。',
    },
    {
      factor: 'TIPS 12个月周期变化',
      currentValue: `${tipsChgBp >= 0 ? '+' : ''}${tipsChgBp} bp`,
      sourceDate: `FRED DFII10 12M Δ · ${curRow.tipsObsDate || curRow.date}`,
      percentile25y: `第 ${Math.round(tipsChgPct25y)}% 分位`,
      impact: tipsChgBucket.impact,
      impactLabel: tipsChgBucket.impactLabel,
      empiricalStat: fmtEmp(empTipsChg, tipsChgBucket.label),
      mechanism: '实证表明利率变化方向（紧缩 vs 降息周期）比静态绝对水平更具拐点意义。',
    },
    {
      factor: '通胀调整实际金价 (Gold/CPI)',
      currentValue: curFeat.realGoldIndex != null ? `${round(curFeat.realGoldIndex, 1)}` : '—',
      sourceDate: `Yahoo GC=F ÷ FRED CPIAUCSL · ${curRow.date}`,
      percentile25y: `第 ${Math.round(curFeat.realGoldPct)}% 分位`,
      impact: valBucket.impact,
      impactLabel: valBucket.impactLabel,
      empiricalStat: fmtEmp(empVal, valBucket.label),
      mechanism: '剔除美元长期通胀后的真实估值标尺，用于约束 2–5 年期的均值回归预期，防止高位线性外推。',
    },
    {
      factor: '美国 CPI 同比通胀',
      currentValue: curFeat.cpiYoYRaw != null ? `${round(curFeat.cpiYoYRaw, 2)}%` : '—',
      sourceDate: `FRED CPIAUCSL · ${curRow.cpiObsDate || curRow.ym}`,
      percentile25y: `第 ${Math.round(cpiPct25y)}% 分位`,
      impact: cpiBucket.impact,
      impactLabel: cpiBucket.impactLabel,
      empiricalStat: fmtEmp(empCpi, cpiBucket.label),
      mechanism: '黄金的百年名义价格中枢锚定法币购买力稀释速度。',
    },
    {
      factor: '美元指数 DXY (相对36月均值)',
      currentValue: `${round(curFeat.dxy, 1)} (${curFeat.dxyDev36m >= 0 ? '+' : ''}${round(curFeat.dxyDev36m, 1)}%)`,
      sourceDate: `Yahoo DX-Y.NYB · ${curRow.date}`,
      percentile25y: `第 ${Math.round(dxyPct25y)}% 分位`,
      impact: dxyBucket.impact,
      impactLabel: dxyBucket.impactLabel,
      empiricalStat: fmtEmp(empDxy, dxyBucket.label),
      mechanism: '黄金以美元计价，美元大周期走弱通常放大黄金名义涨幅。',
    },
    {
      factor: '24个月实现月波动率 σ_m',
      currentValue: `${curFeat.vol24m}%/月 (年化${round(curFeat.vol24m * Math.sqrt(12), 1)}%)`,
      sourceDate: `Yahoo GC=F 25Y 月线 · ${curRow.ym}`,
      percentile25y: `第 ${Math.round(volPct25y)}% 分位`,
      impact: volBucket.impact,
      impactLabel: volBucket.impactLabel,
      empiricalStat: fmtEmp(empVol, volBucket.label),
      mechanism: '用于 FHS 长期概率扇形带宽缩放（钳制在 0.70×–1.40×，避免短期波动扭曲多年预期）。',
    },
  ];
}

/** 构造三情景宏观推演与推翻条件 */
function buildScenariosAndTriggers(cfg, lastPt, cagr, curFeat, spotUsd, ma12, ma36) {
  const hName = cfg.shortLabel;
  const scenarios = [
    {
      key: 'bull',
      title: `上行情景 · 宽松降息 / 避险共振 (P75)`,
      probPct: 25,
      trigger: `10Y TIPS 回落至 1.50% 以下、美国 CPI 维持 3%+ 韧性，或美元指数 DXY 跌破 96 引发全球配置增持。`,
      targetPct: lastPt.p75,
      cagrPct: cagr.p75,
      targetUsd: lastPt.usd.p75,
      targetCny: lastPt.cny.p75,
      stance: cfg.years >= 2
        ? '核心仓位坚定持有，回踩 12 月均线时可适度提高定投额。'
        : '维持计划定投，遇宏观回撤可分批加码。',
    },
    {
      key: 'base',
      title: `基准情景 · 宏观周期条件中枢 (P50)`,
      probPct: 50,
      trigger: `实际利率由高位温和回落、通胀回归温和区间，央行结构性购金对冲部分高位估值消化。`,
      targetPct: lastPt.p50,
      cagrPct: cagr.p50,
      targetUsd: lastPt.usd.p50,
      targetCny: lastPt.cny.p50,
      stance: `以资产配置与月度定投为主（计划仓位 5%–15%），不赌单次买点，用时间平滑周期波动。`,
    },
    {
      key: 'bear',
      title: `下行情景 · 高实际利率久期压制 (P25)`,
      probPct: 25,
      trigger: `10Y TIPS 长期停留在 2.8% 以上、强美元（DXY > 108）叠加高真实估值（Gold/CPI 均值回归）引发阶段性深度回调。`,
      targetPct: lastPt.p25,
      cagrPct: cagr.p25,
      targetUsd: lastPt.usd.p25,
      targetCny: lastPt.cny.p25,
      stance: `严禁杠杆与高位一把梭；预留至少 12 个月分批建仓弹药，以应对 ${hName} 内可能出现的深度回撤。`,
    },
  ];

  const tipsNow = curFeat.tipsRaw != null ? `${round(curFeat.tipsRaw, 2)}%` : '—';
  const dxyNow = `${round(curFeat.dxy, 1)}`;
  const cpiNow = curFeat.cpiYoYRaw != null ? `${round(curFeat.cpiYoYRaw, 2)}%` : '—';
  const ma12Price = round(ma12 || (spotUsd / (1 + curFeat.ma12Dev / 100)), 0);
  const ma36Price = ma36 ? round(ma36, 0) : null;
  const belowMa12 = spotUsd < ma12Price * 0.995;

  const invalidationTriggers = [
    {
      metric: '10Y TIPS 实际利率',
      current: tipsNow,
      trigger: curFeat.tips >= 2.0 ? '持续跌破 1.80%' : '反弹突破 2.30%',
      meaning: curFeat.tips >= 2.0
        ? '若实际利率进入明确下行通道，将解除当前最核心的估值压制，切向上行情景。'
        : '若实际利率重回 2.3% 以上高紧缩区，需下修多年期回报中枢。',
    },
    {
      metric: '通胀调整实际金价 (Gold/CPI)',
      current: `第 ${Math.round(curFeat.realGoldPct)}% 分位`,
      trigger: belowMa12 && ma36Price
        ? `跌破 36 月均线（约 $${ma36Price}/oz）或连续 3 个月无法站回 12 月均线（$${ma12Price}/oz）`
        : `跌破 12 月均线（约 $${ma12Price}/oz）且连续 2 个月未收复`,
      meaning: belowMa12
        ? '现价已位于 12 月均线下方消化高估值，若进一步跌破 36 月周期中枢，将确认进入类似 2013–2015 年的估值收缩期。'
        : '意味着长期趋势动能减弱，大概率进入类似 2012–2015 年的横盘/估值消化期。',
    },
    {
      metric: '美元指数 (DXY)',
      current: dxyNow,
      trigger: curFeat.dxy >= 102 ? '站稳 110 上方 或 跌破 96 下方' : '突破 106 上方',
      meaning: '突破 110 将显著压制美元计价金价；有效跌破 96 则打开跨周期顺风。',
    },
    {
      metric: '美国 CPI 同比通胀',
      current: cpiNow,
      trigger: '二次冲破 4.0% 且货币政策转向宽松',
      meaning: '滞胀组合是历史上黄金 2–5 年超额收益最强的宏观温床。',
    },
  ];

  return { scenarios, invalidationTriggers };
}

/** 构建单个长期视野（1y / 2y / 5y）的完整严格因果预测包 */
function buildSingleLongTermHorizon(cfg, pastRows, futureRows, feats, spotUsd, spotCny, usdCny, dailyRec) {
  const asOfIdx = pastRows.length - 1;
  const curRow = pastRows[asOfIdx];
  const curFeat = feats[asOfIdx];
  const months = cfg.months;
  const years = cfg.years;
  const closes = pastRows.map(r => r.londonClose);
  const sigma0 = curFeat.vol24m;

  // 严格因果候选起点月：m >= 12 且 m + months <= asOfIdx
  const maxStart = asOfIdx - months;
  let candidateIndices = [];
  for (let m = 12; m <= maxStart; m++) {
    if (feats[m].hasTips) candidateIndices.push(m);
  }
  // 兼容极早期回放日期（TIPS 数据起点 2003-01 之前）
  if (candidateIndices.length < 20) {
    candidateIndices = [];
    for (let m = 12; m <= maxStart; m++) candidateIndices.push(m);
  }
  if (candidateIndices.length < 6) return null;

  // 严格因果标准化统计（仅使用 0..asOfIdx）
  const featKeys = Object.keys(cfg.distWeights);
  const stats = {};
  for (const k of featKeys) {
    const vals = feats.map(f => f[k]);
    stats[k] = { m: mean(vals), s: std(vals) || 1 };
  }

  const sampleEntries = [];
  for (const m of candidateIndices) {
    const startPrice = closes[m];
    const startCpi = pastRows[m].cpi;
    const endCpi = pastRows[m + months].cpi;
    const sigmaD = feats[m].vol24m;
    const volScale = clamp(sigma0 / sigmaD, 0.70, 1.40);

    const scaledPath = [];
    let minRet = 0;
    let maxRet = 0;
    let rawMinRet = 0;
    for (let h = 1; h <= months; h++) {
      const rawPct = ((closes[m + h] - startPrice) / startPrice) * 100;
      const scaled = rawPct * volScale;
      scaledPath.push(scaled);
      if (scaled < minRet) minRet = scaled;
      if (scaled > maxRet) maxRet = scaled;
      if (rawPct < rawMinRet) rawMinRet = rawPct;
    }

    let sqSum = 0;
    let wSum = 0;
    for (const k of featKeys) {
      const w = cfg.distWeights[k] || 0;
      if (w <= 0) continue;
      const z0 = (curFeat[k] - stats[k].m) / stats[k].s;
      const zd = (feats[m][k] - stats[k].m) / stats[k].s;
      sqSum += w * (z0 - zd) * (z0 - zd);
      wSum += w;
    }
    const dist = Math.sqrt(sqSum / (wSum || 1));
    const similarity = Math.exp(-dist * dist / 2.6);

    const rawEndPct = round(((closes[m + months] - startPrice) / startPrice) * 100, 2);
    const cpiCumPct = (startCpi > 0 && endCpi > 0) ? ((endCpi / startCpi) - 1) * 100 : null;
    const beatCpi = cpiCumPct != null ? rawEndPct > cpiCumPct : null;

    sampleEntries.push({
      idx: m,
      ym: pastRows[m].ym,
      endYm: pastRows[m + months].ym,
      row: pastRows[m],
      feat: feats[m],
      similarity: round(similarity * 100, 1),
      rawWeight: similarity,
      volScale: round(volScale, 2),
      scaledPath,
      rawEndPct,
      cagrPct: toCagrPct(rawEndPct, years),
      maxDdPct: round(rawMinRet, 1),
      scaledEndPct: round(scaledPath[months - 1], 2),
      minRet,
      maxRet,
      beatCpi,
    });
  }

  // 去重叠降权（避免同一轮行情相邻月份垄断权重）+ Kish N_eff
  const sortedByW = sampleEntries.slice().sort((a, b) => b.rawWeight - a.rawWeight);
  const overlapWindow = Math.min(months, 12);
  const accepted = new Uint8Array(pastRows.length + 1);
  for (const item of sortedByW) {
    let penalty = 1;
    const lo = Math.max(0, item.idx - overlapWindow + 1);
    const hi = Math.min(pastRows.length - 1, item.idx + overlapWindow - 1);
    for (let k = lo; k <= hi; k++) {
      if (accepted[k]) {
        const gap = Math.abs(item.idx - k);
        penalty *= 0.45 + 0.55 * (gap / overlapWindow);
      }
    }
    accepted[item.idx] = 1;
    item.weight = item.rawWeight * penalty;
  }

  const weights = sampleEntries.map(e => e.weight);
  const uncondWeights = sampleEntries.map(() => 1);
  const sumW = weights.reduce((s, w) => s + w, 0);
  const sumW2 = weights.reduce((s, w) => s + w * w, 0);
  const effectiveSampleSize = sumW2 > 0 ? round((sumW * sumW) / sumW2, 1) : 0;
  const shrinkageWeight = round(SHRINKAGE_K_LONG / (effectiveSampleSize + SHRINKAGE_K_LONG), 2);

  // 先算期末正收益概率与跑赢通胀概率，供三面卡片与 KPI 共享
  const endRets = sampleEntries.map(e => e.scaledPath[months - 1]);
  let upW = 0;
  let beatCpiW = 0;
  let cpiTotalW = 0;
  for (let i = 0; i < sampleEntries.length; i++) {
    if (endRets[i] > 0) upW += weights[i];
    if (sampleEntries[i].beatCpi != null) {
      cpiTotalW += weights[i];
      if (sampleEntries[i].beatCpi) beatCpiW += weights[i];
    }
  }
  const upEndProb = sumW > 0 ? round((upW / sumW) * 100, 1) : 50;
  const beatCpiProb = cpiTotalW > 0 ? round((beatCpiW / cpiTotalW) * 100, 1) : null;

  // 慢变量综合分与温和偏置（严格脱钩日线，红档归 0）
  const pillars = buildLongTermPillars(cfg, curRow, curFeat, dailyRec, sampleEntries, upEndProb, beatCpiProb);
  const compositeScore = Math.round(
    pillars.fundamental.score * cfg.pillarWeights.fundamental +
    pillars.information.score * cfg.pillarWeights.information +
    pillars.technical.score * cfg.pillarWeights.technical,
  );
  const gateBlocked = dailyRec?.gate && dailyRec.gate.actionable === false;
  const rawTiltNorm = gateBlocked ? 0 : clamp((compositeScore - 50) / 50, -1, 1);

  // 逐月计算双层分位 P10/P25/P50/P75/P90 + 无条件25年基准 P50
  const QUANT_LIST = [0.10, 0.25, 0.50, 0.75, 0.90];
  const points = [];
  for (let h = 1; h <= months; h++) {
    const vals = sampleEntries.map(e => e.scaledPath[h - 1]);
    const [cP10, cP25, cP50, cP75, cP90] = weightedQuantilesBatch(vals, weights, QUANT_LIST);
    const [uP10, uP25, uP50, uP75, uP90] = weightedQuantilesBatch(vals, uncondWeights, QUANT_LIST);

    // 长期偏置非常克制，主要由 25 年真实条件分布与无条件基准主导
    const driftPct = rawTiltNorm * 0.08 * sigma0 * Math.sqrt(h);
    const mix = (c, u) => (1 - shrinkageWeight) * c + shrinkageWeight * u + driftPct;

    let p10 = mix(cP10, uP10);
    let p25 = mix(cP25, uP25);
    let p50 = mix(cP50, uP50);
    let p75 = mix(cP75, uP75);
    let p90 = mix(cP90, uP90);

    // 防极端负价（黄金价格下限保护）
    p10 = Math.max(-55, p10);
    p25 = Math.max(p10, p25);
    p50 = Math.max(p25, p50);
    p75 = Math.max(p50, p75);
    p90 = Math.max(p75, p90);

    const toUsd = (pct) => round(spotUsd * (1 + pct / 100), 2);
    const toCny = (pct) => round(spotCny * (1 + pct / 100), 2);

    points.push({
      h,
      ym: addMonthsYm(curRow.ym, h),
      p10: round(p10, 2),
      p25: round(p25, 2),
      p50: round(p50, 2),
      p75: round(p75, 2),
      p90: round(p90, 2),
      baselineP50: round(uP50, 2),
      cagrP50: toCagrPct(p50, h / 12),
      usd: { p10: toUsd(p10), p25: toUsd(p25), p50: toUsd(p50), p75: toUsd(p75), p90: toUsd(p90), baselineP50: toUsd(uP50) },
      cny: { p10: toCny(p10), p25: toCny(p25), p50: toCny(p50), p75: toCny(p75), p90: toCny(p90), baselineP50: toCny(uP50) },
    });
  }

  // 期内最大回撤分位
  const minRets = sampleEntries.map(e => e.minRet);
  const [cDd90, cDd50] = weightedQuantilesBatch(minRets, weights, [0.10, 0.50]);
  const [uDd90, uDd50] = weightedQuantilesBatch(minRets, uncondWeights, [0.10, 0.50]);
  const maxDdP50 = round((1 - shrinkageWeight) * cDd50 + shrinkageWeight * uDd50, 1);
  const maxDdP90 = round((1 - shrinkageWeight) * cDd90 + shrinkageWeight * uDd90, 1);

  // 长期关键结构位（MA12 / MA36 / MA60 / 近5年高点）+ 历史触达频率
  const cnyPerUsdRatio = spotUsd > 0 ? (spotCny / spotUsd) : (usdCny / TROY_OUNCE_TO_GRAM);
  const ma12 = smaAt(closes, asOfIdx, 12);
  const ma36 = smaAt(closes, asOfIdx, 36);
  const ma60 = smaAt(closes, asOfIdx, 60);
  const last60High = Math.max(...closes.slice(Math.max(0, asOfIdx - 59), asOfIdx + 1));

  const structureRaw = [];
  if (last60High > spotUsd * 1.015) {
    structureRaw.push({ label: '近5年高点 (60M峰值)', priceUsd: last60High });
  }
  if (ma12) structureRaw.push({ label: '12月均线 (MA12 · 年度趋势)', priceUsd: ma12 });
  if (ma36) structureRaw.push({ label: '36月均线 (MA36 · 周期中枢)', priceUsd: ma36 });
  if (ma60) structureRaw.push({ label: '60月均线 (MA60 · 5年成本锚)', priceUsd: ma60 });

  const endDrift = rawTiltNorm * 0.08 * sigma0 * Math.sqrt(months);
  const structure = structureRaw.map(lvl => {
    const pctFromSpot = round(((lvl.priceUsd / spotUsd) - 1) * 100, 2);
    const kind = pctFromSpot >= 0 ? 'resistance' : 'support';
    let touchW = 0;
    for (let i = 0; i < sampleEntries.length; i++) {
      const e = sampleEntries[i];
      const touched = kind === 'resistance'
        ? (e.maxRet + endDrift >= pctFromSpot)
        : (e.minRet + endDrift <= pctFromSpot);
      if (touched) touchW += weights[i];
    }
    return {
      label: lvl.label,
      kind,
      pctFromSpot,
      priceUsd: round(lvl.priceUsd, 2),
      priceCny: round(lvl.priceUsd * cnyPerUsdRatio, 2),
      touchProb: sumW > 0 ? round((touchW / sumW) * 100, 0) : null,
    };
  }).sort((a, b) => b.priceUsd - a.priceUsd);

  // 精选 Top 5 独立历史宏观周期起点（严格相隔 >= 12 个月，避免连续月份凑数！）
  const topAnalogs = [];
  for (const e of sortedByW) {
    if (topAnalogs.length >= 5) break;
    if (topAnalogs.some(a => Math.abs(a.idx - e.idx) < 12)) continue;
    const tipsTxt = e.feat.tipsRaw != null ? `TIPS ${round(e.feat.tipsRaw, 2)}%` : 'TIPS —';
    const cpiTxt = e.feat.cpiYoYRaw != null ? `CPI ${round(e.feat.cpiYoYRaw, 1)}%` : '';
    const dxyTxt = e.feat.dxyRaw != null ? `DXY ${round(e.feat.dxyRaw, 0)}` : '';
    const valTxt = `估值${Math.round(e.feat.realGoldPct)}%分位`;
    topAnalogs.push({
      idx: e.idx,
      date: e.ym,
      endDate: e.endYm,
      eraLabel: classifyMacroEra(e.row, e.feat),
      macroSnap: [tipsTxt, cpiTxt, dxyTxt, valTxt].filter(Boolean).join(' · '),
      similarity: e.similarity,
      rawEndPct: e.rawEndPct,
      cagrPct: e.cagrPct,
      maxDdPct: e.maxDdPct,
      scaledEndPct: e.scaledEndPct,
      volScale: e.volScale,
    });
  }

  // 事后真实月线复盘（仅用于历史日期，如选择 2024-11-01 复盘 1 年走势）
  const actualReplay = [];
  for (let h = 1; h <= months && h <= futureRows.length; h++) {
    const fr = futureRows[h - 1];
    const pct = round(((fr.londonClose - spotUsd) / spotUsd) * 100, 2);
    actualReplay.push({
      h,
      date: fr.ym,
      pct,
      usd: round(fr.londonClose, 2),
      cny: round(spotCny * (1 + pct / 100), 2),
    });
  }

  const last = points[points.length - 1];
  const cagr = {
    p10: toCagrPct(last.p10, years),
    p25: toCagrPct(last.p25, years),
    p50: toCagrPct(last.p50, years),
    p75: toCagrPct(last.p75, years),
    p90: toCagrPct(last.p90, years),
    baselineP50: toCagrPct(last.baselineP50, years),
  };

  const verdict = cagr.p50 >= 6
    ? { code: 'bullish', label: '长期配置偏多' }
    : cagr.p50 <= 0
      ? { code: 'bearish', label: '高位承压谨慎' }
      : { code: 'neutral', label: '温和复利震荡' };

  const factorAudit = buildFactorAudit(cfg, pastRows, feats, asOfIdx, sampleEntries, curRow, curFeat);
  const { scenarios, invalidationTriggers } = buildScenariosAndTriggers(cfg, last, cagr, curFeat, spotUsd, ma12, ma36);

  // 月线历史段（用于图表左侧展示 3/4/5 年月线历史 + MA12）
  const histStart = Math.max(0, asOfIdx - cfg.histMonths + 1);
  const history = [];
  for (let i = histStart; i <= asOfIdx; i++) {
    const pUsd = closes[i];
    const ma12Val = smaAt(closes, i, 12);
    const pCny = i === asOfIdx ? spotCny : round(pUsd * cnyPerUsdRatio, 2);
    history.push({
      date: pastRows[i].ym,
      fullDate: pastRows[i].date,
      usd: round(pUsd, 2),
      cny: pCny,
      pct: round(((pUsd - spotUsd) / spotUsd) * 100, 2),
      ma20Usd: ma12Val != null ? round(ma12Val, 2) : null,
      ma20Cny: ma12Val != null ? round(ma12Val * cnyPerUsdRatio, 2) : null,
      ma20Pct: ma12Val != null ? round(((ma12Val - spotUsd) / spotUsd) * 100, 2) : null,
    });
  }

  return {
    horizonData: {
      horizon: cfg.key,
      isLongTerm: true,
      unitType: 'month',
      months,
      years,
      label: cfg.label,
      shortLabel: cfg.shortLabel,
      trackName: cfg.trackName,
      degraded: effectiveSampleSize >= 15 ? 'full' : 'sparse',
      compositeScore,
      verdict,
      pillarWeights: cfg.pillarWeights,
      sampleStats: {
        rawSampleSize: sampleEntries.length,
        effectiveSampleSize,
        shrinkageWeight,
        currentVolPct: round(sigma0, 2),
        annualizedVolPct: round(sigma0 * Math.sqrt(12), 1),
        volUnit: '%/月',
        monthlySpan: `${pastRows[0].ym} ～ ${curRow.ym}（${pastRows.length} 个月）`,
        method: 'macro_25y_monthly_fhs_shrinkage',
      },
      summary: {
        endP50Pct: last.p50,
        endP10Pct: last.p10,
        endP25Pct: last.p25,
        endP75Pct: last.p75,
        endP90Pct: last.p90,
        baselineEndP50Pct: last.baselineP50,
        endUsd: last.usd,
        endCny: last.cny,
        cagr,
        maxDdP50,
        maxDdP90,
        upEndProb,
        beatCpiProb,
      },
      points,
      structure,
      topAnalogs: topAnalogs.map(({ idx: _drop, ...rest }) => rest),
      actualReplay,
      evidence: {
        factorAudit,
        scenarios,
        invalidationTriggers,
        methodologyNote: `基于 ${pastRows[0].ym} 至 ${curRow.ym} 共 ${pastRows.length} 个真实历史月线（涵盖 2003–2011 宽松牛市、2011–2015 紧缩熊市、2016–2019 筑底、2020 零利率、2022–2026 高利率五轮完整宏观周期），按 5 项官方慢变量 Z-score 相似度加权、去重叠降权（N_eff=${effectiveSampleSize}）并向 25 年无条件分布执行 ${Math.round(shrinkageWeight * 100)}% 经验贝叶斯收缩。多年期分布用于资产配置与定投纪律，不承诺精确点位。`,
      },
    },
    pillars,
    history,
  };
}

/**
 * 为指定日期构建 1年 / 2年 / 5年 长期宏观走势预测包（零 I/O、严格因果）
 */
function buildLongTermForecastBundle({ monthlyRecords, asOfDate, spotUsd, spotCny, usdCny, dailyRec }) {
  if (!Array.isArray(monthlyRecords) || monthlyRecords.length < 72 || !asOfDate) {
    return null;
  }

  const asOfYm = asOfDate.slice(0, 7);
  const pastRows = [];
  const futureRows = [];
  for (const r of monthlyRecords) {
    if (!r?.ym || !Number.isFinite(r.londonClose) || r.londonClose <= 0) continue;
    if (r.ym <= asOfYm) pastRows.push({ ...r });
    else futureRows.push({ ...r });
  }

  if (pastRows.length < 72) return null;

  // 将当月收盘价精准锚定为 asOfDate 的实盘金价（确保图表 T+0 零跳变且严格因果）
  const lastBar = pastRows[pastRows.length - 1];
  if (lastBar.ym === asOfYm) {
    lastBar.date = asOfDate;
    lastBar.londonClose = round(spotUsd, 2);
    if (dailyRec?.tipsYield != null) lastBar.tips = dailyRec.tipsYield;
    if (dailyRec?.dxy != null) lastBar.dxy = dailyRec.dxy;
    if (dailyRec?.us10y != null) lastBar.us10y = dailyRec.us10y;
    if (dailyRec?.macroObsDate) lastBar.tipsObsDate = dailyRec.macroObsDate;
    if (lastBar.cpi > 0) {
      lastBar.realGoldIndex = round((spotUsd / lastBar.cpi) * 100, 2);
    }
  } else {
    const prev = pastRows[pastRows.length - 1];
    pastRows.push({
      ...prev,
      ym: asOfYm,
      date: asOfDate,
      londonClose: round(spotUsd, 2),
      tips: dailyRec?.tipsYield ?? prev.tips,
      dxy: dailyRec?.dxy ?? prev.dxy,
      us10y: dailyRec?.us10y ?? prev.us10y,
      tipsObsDate: dailyRec?.macroObsDate ?? prev.tipsObsDate,
      realGoldIndex: prev.cpi > 0 ? round((spotUsd / prev.cpi) * 100, 2) : prev.realGoldIndex,
    });
  }

  const feats = extractMonthlyFeatures(pastRows);
  const horizons = {};
  const pillarsByHorizon = {};
  const historyByHorizon = {};

  for (const cfg of LONG_TERM_HORIZONS) {
    const built = buildSingleLongTermHorizon(
      cfg,
      pastRows,
      futureRows,
      feats,
      spotUsd,
      spotCny,
      usdCny || DEFAULT_USD_CNY,
      dailyRec,
    );
    if (built) {
      horizons[cfg.key] = built.horizonData;
      pillarsByHorizon[cfg.key] = built.pillars;
      historyByHorizon[cfg.key] = built.history;
    }
  }

  if (Object.keys(horizons).length === 0) return null;

  return {
    horizons,
    pillarsByHorizon,
    historyByHorizon,
    monthlyStats: {
      bars: pastRows.length,
      from: pastRows[0].ym,
      to: pastRows[pastRows.length - 1].ym,
      cpiObsDate: pastRows[pastRows.length - 1].cpiObsDate || pastRows[pastRows.length - 1].ym,
      maLabel: 'MA12 均线',
    },
  };
}

module.exports = {
  LONG_TERM_HORIZONS,
  addMonthsYm,
  toCagrPct,
  buildLongTermForecastBundle,
};
