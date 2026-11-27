'use strict';

// 融合 5 年实盘日线快照（docs/market-data/gold-daily-5y.jsonl）与 AI 日报（docs/goldrush-analysis-*.md）
// 1) 优先使用 5 年连续实盘金价 + FRED 宏观 + CFTC/GLD 资金流作为连续底表（消除断档与跳空）
// 2) 有 AI 日报的交易日叠加三面研判、事件传导与仓位/门禁；无 AI 日报日仅使用客观实盘指标量化推导，绝不编造 AI 摘要
// 3) 带 mtime + 大小缓存，刷新数据或新增日报后自动失效

const fs = require('node:fs');
const path = require('node:path');
const {
  readMarketSnapshot,
  readMonthlySnapshot,
  readSyncMeta,
  getSnapshotPaths,
} = require('./market-sync.cjs');

const TROY_OUNCE_TO_GRAM = 31.1034768;
const DEFAULT_USD_CNY = 7.25;

let _cache = null;
let _monthlyCache = null;

function round(v, digits = 2) {
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function isValidGoldPrice(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1000 && v <= 10000;
}

function isValidCnyGram(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 300 && v <= 2500;
}

function daysBetween(dateA, dateB) {
  if (!dateA || !dateB) return null;
  const a = Date.parse(dateA + 'T00:00:00Z');
  const b = Date.parse(dateB + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function extractLondonClose(md) {
  const mDelta = md.match(/伦敦金[：:]\s*[\d,.]+\$?\s*→\s*([\d,.]+)/);
  if (mDelta) {
    const v = parseFloat(mDelta[1].replace(/,/g, ''));
    if (isValidGoldPrice(v)) return v;
  }
  const mSpot = md.match(/(?:当前金价|现价|伦敦金现货|伦敦金)[：:\s]*\$?([1-9]\d{3}(?:\.\d+)?)/);
  if (mSpot) {
    const v = parseFloat(mSpot[1]);
    if (isValidGoldPrice(v)) return v;
  }
  const mDollar = md.match(/\$([1-9]\d{3}(?:\.\d+)?)/);
  if (mDollar) {
    const v = parseFloat(mDollar[1]);
    if (isValidGoldPrice(v)) return v;
  }
  return null;
}

function extractShanghaiClose(md) {
  const m = md.match(/(?:上海金|Au99\.?99|沪金)[^0-9\n]{0,18}([3-9]\d{2}(?:\.\d+)?|1\d{3}(?:\.\d+)?)\s*(?:元|¥|RMB)/i);
  if (m) {
    const v = parseFloat(m[1]);
    if (isValidCnyGram(v)) return v;
  }
  return null;
}

function extractMacroNumbers(md, meta) {
  let tips = null;
  let dxy = null;
  let us10y = null;

  const mTipsArrow = md.match(/实际利率\(TIPS\)[：:]\s*[-+]?[\d.]+%?\s*→\s*([-+]?[\d.]+)/);
  if (mTipsArrow) tips = parseFloat(mTipsArrow[1]);
  if (tips == null) {
    const mTipsNote = md.match(/实际利率[^。\n]{0,40}当前\s*([-+]?[\d.]+)%/);
    if (mTipsNote) tips = parseFloat(mTipsNote[1]);
  }
  if (tips == null) {
    const mTipsInline = md.match(/TIPS\s*(?:约\s*)?([-+]?[\d.]+)%/);
    if (mTipsInline) tips = parseFloat(mTipsInline[1]);
  }
  if (tips != null && (!Number.isFinite(tips) || tips < -3 || tips > 8)) tips = null;

  const m10yArrow = md.match(/美债10Y[：:]\s*[\d.]+%?\s*→\s*([\d.]+)/);
  if (m10yArrow) us10y = parseFloat(m10yArrow[1]);
  if (us10y == null) {
    const m10y = md.match(/10Y\s*(?:美债\s*)?([\d.]+)%/);
    if (m10y) us10y = parseFloat(m10y[1]);
  }
  if (us10y != null && (!Number.isFinite(us10y) || us10y < 0.5 || us10y > 10)) us10y = null;

  const mDxy = md.match(/(?:DXY|美元指数)\s*[:：约]?\s*(9\d(?:\.\d+)?|1[0-3]\d(?:\.\d+)?)/);
  if (mDxy) dxy = parseFloat(mDxy[1]);
  if (dxy != null && (!Number.isFinite(dxy) || dxy < 80 || dxy > 140)) dxy = null;

  let macroLabel = null;
  let macroTag = null;
  const block = md.match(/## 🌐 宏观阶段[\s\S]*?(?=\n## |\n---|$)/);
  if (block) {
    const lb = block[0].match(/\*\*([^*]+)\*\*/);
    const tg = block[0].match(/`([^`]+)`/);
    if (lb) macroLabel = lb[1].trim();
    if (tg) macroTag = tg[1].trim();
  }

  const mtFactors = meta?.midTerm?.factors || null;
  const dxyDevMa60 = mtFactors?.dollar_trend?.rawValue ?? null;
  const tipsChange60dBp = mtFactors?.real_rate_trend?.rawValue ?? null;
  const cftcPercentile = mtFactors?.positioning?.rawValue ?? null;
  const officialFlowScore = mtFactors?.official_flow?.rawValue ?? null;

  return {
    tips,
    dxy,
    us10y,
    macroLabel,
    macroTag,
    dxyDevMa60,
    tipsChange60dBp,
    cftcPercentile,
    officialFlowScore,
  };
}

function extractDimensionDetails(md) {
  const out = {
    technical: { score: null, summary: '' },
    fundamental: { score: null, summary: '' },
    sentiment: { score: null, summary: '' },
  };
  const map = { '技术面': 'technical', '基本面': 'fundamental', '情绪面': 'sentiment' };

  const rowRe = /^\|\s*(技术面|基本面|情绪面)\s*\|\s*(\d+)\/100\s*\|\s*[^|]*\|\s*([^|\n]+)\|/gm;
  let m;
  while ((m = rowRe.exec(md)) !== null) {
    const key = map[m[1]];
    if (key && out[key].score == null) {
      out[key].score = parseInt(m[2], 10);
      out[key].summary = m[3].trim();
    }
  }

  const compRe = /^\|\s*(技术面|基本面|情绪面)\s*\|\s*(\d+)\/100/gm;
  while ((m = compRe.exec(md)) !== null) {
    const key = map[m[1]];
    if (key && out[key].score == null) {
      out[key].score = parseInt(m[2], 10);
    }
  }

  return out;
}

function extractTransmission(md) {
  const block = md.match(/## 🛰️ 事件→黄金传导[\s\S]*?(?=\n## |\n---|$)/);
  if (!block) return null;
  const text = block[0];
  const quote = text.match(/^>\s*\*\*([^*]+)\*\*/m);
  const channels = [];
  const rowRe = /^\|\s*([^|\n]+)\s*\|\s*(利多金|利空金|静默|中性|分歧)\s*\|\s*(\d+)\s*\|\s*([^|\n]+)\|/gm;
  let m;
  while ((m = rowRe.exec(text)) !== null) {
    channels.push({
      channel: m[1].trim(),
      bias: m[2].trim(),
      strength: parseInt(m[3], 10),
      evidence: m[4].trim().slice(0, 90),
    });
  }
  const excerpt = text.match(/^- 事件摘录[：:]\s*(.+)$/m);
  return {
    verdict: quote ? quote[1].trim() : '',
    channels,
    excerpt: excerpt ? excerpt[1].trim().slice(0, 140) : '',
  };
}

function extractOverallAndQuant(md, meta) {
  let overallScore = typeof meta?.score === 'number' ? meta.score : null;
  if (overallScore == null) {
    const m = md.match(/综合评分[：:]\s*\*\*(?:\d+[–-]\d+\/100\*\*（中心\s*(\d+)|(\d+)\/100)/);
    if (m) overallScore = parseInt(m[1] || m[2], 10);
  }
  let quantScore = typeof meta?.quantScore === 'number' ? meta.quantScore : null;
  if (quantScore == null) {
    const mq = md.match(/量化（纯本地因子）\s*\|\s*\*\*(\d+)\/100\*\*/)
      || md.match(/量化评分[：:]\s*\*\*(\d+)\/100\*\*/);
    if (mq) quantScore = parseInt(mq[1], 10);
  }
  let midTermScore = typeof meta?.midTermScore === 'number'
    ? meta.midTermScore
    : (typeof meta?.midTerm?.score === 'number' ? meta.midTerm.score : null);
  if (midTermScore == null) {
    const mm = md.match(/中期（1～3 个月）[^，\n]*，综合\s*(\d+)\/100/);
    if (mm) midTermScore = parseInt(mm[1], 10);
  }

  let flowScore = meta?.midTerm?.factors?.official_flow?.rawValue ?? null;
  if (flowScore == null) {
    const mf = md.match(/主力\(CFTC\+ETF\+央行\)\s*\|\s*(\d+(?:\.\d+)?)/);
    if (mf) flowScore = Math.round(parseFloat(mf[1]));
  }

  const gate = meta?.gate
    ? {
        tier: meta.gate.tier || 'green',
        actionable: meta.gate.actionable !== false,
        confidence: meta.gate.overallConfidence ?? 75,
      }
    : (() => {
        const mc = md.match(/数据置信度[：:]\s*(\d+)%/);
        const conf = mc ? parseInt(mc[1], 10) : 75;
        const blocked = md.includes('操作结论已关闭') || md.includes('不可依据本报告');
        return {
          tier: blocked ? 'red' : conf >= 70 ? 'green' : 'yellow',
          actionable: !blocked,
          confidence: conf,
        };
      })();

  const position = meta?.position
    ? {
        targetPct: meta.position.targetPct,
        label: meta.position.label,
        action: meta.position.action,
      }
    : null;

  return { overallScore, quantScore, midTermScore, flowScore, gate, position };
}

function loadMetaSafe(docsDir, mdFile) {
  const metaFile = mdFile.replace(/\.md$/i, '.meta.json');
  const full = path.join(docsDir, metaFile);
  if (!fs.existsSync(full)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(full, 'utf-8'));
    if (raw && raw.schemaVersion === 1) return raw;
  } catch { /* ignore */ }
  return null;
}

/** 严格因果：基于 5 年实盘日线与宏观/资金流计算客观三面量化指标（不编造 AI 叙事） */
function buildObjectiveMarketPillars(rows, idx, syncMeta, isLatest) {
  const cur = rows[idx];
  const spot = cur.londonClose;

  // 1) 均线与 RSI(14)（仅用 <= idx）
  let ma20 = spot;
  if (idx >= 19) {
    let s = 0;
    for (let k = idx - 19; k <= idx; k++) s += rows[k].londonClose;
    ma20 = s / 20;
  }
  let ma60 = ma20;
  if (idx >= 59) {
    let s = 0;
    for (let k = idx - 59; k <= idx; k++) s += rows[k].londonClose;
    ma60 = s / 60;
  }
  const ma20Dev = ma20 > 0 ? ((spot - ma20) / ma20) * 100 : 0;
  const ma60Dev = ma60 > 0 ? ((spot - ma60) / ma60) * 100 : 0;

  let rsi = 50;
  if (idx >= 14) {
    let g = 0;
    let l = 0;
    for (let k = idx - 13; k <= idx; k++) {
      const diff = rows[k].londonClose - rows[k - 1].londonClose;
      if (diff > 0) g += diff;
      else l -= diff;
    }
    rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }

  // 技术面量化分（均线结构 + RSI 动量，超买适度回拉）
  const trendPart = clamp(50 + ma20Dev * 3.8 + ma60Dev * 1.4, 15, 85);
  const rsiPart = rsi >= 72
    ? clamp(55 - (rsi - 72) * 1.6, 25, 65)
    : rsi <= 28
      ? clamp(45 + (28 - rsi) * 1.6, 35, 78)
      : clamp(35 + (rsi / 100) * 35, 30, 72);
  const technicalScore = Math.round(clamp(trendPart * 0.65 + rsiPart * 0.35, 18, 84));

  // 2) 基本面量化分（TIPS 水平 + 60 日变动方向 + DXY 相对 MA60 + 10Y）
  let dxyDevMa60 = null;
  if (cur.dxy != null) {
    const winStart = Math.max(0, idx - 59);
    let dSum = 0;
    let dCnt = 0;
    for (let k = winStart; k <= idx; k++) {
      if (rows[k].dxy != null) { dSum += rows[k].dxy; dCnt++; }
    }
    if (dCnt >= 10) {
      const dMa60 = dSum / dCnt;
      dxyDevMa60 = round(((cur.dxy - dMa60) / dMa60) * 100, 2);
    }
  }

  let tipsChange60dBp = null;
  if (cur.tips != null && idx >= 60) {
    let prevTips = null;
    for (let k = idx - 60; k >= Math.max(0, idx - 75); k--) {
      if (rows[k].tips != null) { prevTips = rows[k].tips; break; }
    }
    if (prevTips != null) {
      tipsChange60dBp = Math.round((cur.tips - prevTips) * 100);
    }
  }

  const tipsLevelPart = cur.tips != null ? clamp(54 - (cur.tips - 1.5) * 14, 18, 84) : 50;
  const tipsTrendPart = tipsChange60dBp != null ? clamp(50 - tipsChange60dBp * 0.45, 18, 84) : 50;
  const dxyPart = dxyDevMa60 != null ? clamp(50 - dxyDevMa60 * 6.5, 18, 84) : 50;
  const fundamentalScore = Math.round(clamp(tipsLevelPart * 0.4 + tipsTrendPart * 0.3 + dxyPart * 0.3, 18, 84));

  let macroTag = 'balanced_macro';
  let macroLabel = '宏观均衡';
  if (cur.tips != null && cur.tips >= 2.0 && (tipsChange60dBp == null || tipsChange60dBp >= 10)) {
    macroTag = 'real_rate_headwind';
    macroLabel = '实际利率逆风';
  } else if ((cur.tips != null && cur.tips <= 1.0) || (tipsChange60dBp != null && tipsChange60dBp <= -25)) {
    macroTag = 'real_rate_tailwind';
    macroLabel = '实际利率下行利多';
  } else if (dxyDevMa60 != null && dxyDevMa60 >= 2.0) {
    macroTag = 'strong_dollar_pressure';
    macroLabel = '强美元压制';
  } else if (dxyDevMa60 != null && dxyDevMa60 <= -2.0) {
    macroTag = 'weak_dollar_support';
    macroLabel = '弱美元支撑';
  } else if (cur.tips != null && cur.tips >= 1.8) {
    macroTag = 'high_rate_consolidation';
    macroLabel = '高利率震荡';
  }

  // 3) 信息面 / 资金流量化分（CFTC 持仓分位 + GLD 5日/20日资金动量）
  let gld5dRet = null;
  let gld20dRet = null;
  if (cur.gldClose != null) {
    if (idx >= 5 && rows[idx - 5].gldClose > 0) {
      gld5dRet = round(((cur.gldClose - rows[idx - 5].gldClose) / rows[idx - 5].gldClose) * 100, 2);
    }
    if (idx >= 20 && rows[idx - 20].gldClose > 0) {
      gld20dRet = round(((cur.gldClose - rows[idx - 20].gldClose) / rows[idx - 20].gldClose) * 100, 2);
    }
  }

  let flowParts = [];
  if (cur.cftcPct != null) {
    // 持仓拥挤度：极端高位(>85%)降温，低位(<25%)具修复空间，中位温和偏多
    const cftcScore = cur.cftcPct >= 85
      ? clamp(48 - (cur.cftcPct - 85) * 1.4, 24, 48)
      : cur.cftcPct <= 25
        ? clamp(56 + (25 - cur.cftcPct) * 0.9, 56, 78)
        : clamp(46 + (cur.cftcPct - 25) * 0.22, 44, 62);
    flowParts.push({ s: cftcScore, w: 0.55 });
  }
  if (gld20dRet != null) {
    flowParts.push({ s: clamp(50 + gld20dRet * 2.8, 22, 82), w: 0.30 });
  }
  if (gld5dRet != null) {
    flowParts.push({ s: clamp(50 + gld5dRet * 3.5, 22, 82), w: 0.15 });
  }
  const flowWeightSum = flowParts.reduce((a, b) => a + b.w, 0);
  const flowScore = flowWeightSum > 0
    ? Math.round(flowParts.reduce((a, b) => a + b.s * b.w, 0) / flowWeightSum)
    : 50;

  // 4) 动态门禁（依据锚定偏差与宏观数据时效，不硬拦正常交易日）
  const macroLagDays = cur.macroObsDate ? daysBetween(cur.macroObsDate, cur.date) : null;
  const anchorDiff = isLatest ? (syncMeta?.liveQuotes?.anchorDiffPct ?? null) : null;
  let gate = { tier: 'green', actionable: true, confidence: 82 };
  if (anchorDiff != null && anchorDiff > 3.0) {
    gate = { tier: 'red', actionable: false, confidence: 30 };
  } else if (cur.tips == null || (macroLagDays != null && macroLagDays > 10)) {
    gate = { tier: 'yellow', actionable: true, confidence: 66 };
  }

  const tipsStr = cur.tips != null ? `${round(cur.tips, 2)}%` : '缺失';
  const dxyStr = cur.dxy != null ? `${round(cur.dxy, 1)}` : '缺失';
  const cftcStr = cur.cftcPct != null ? `${round(cur.cftcPct, 0)}% 分位` : '待更新';
  const gldStr = gld20dRet != null ? `${gld20dRet >= 0 ? '+' : ''}${gld20dRet}%` : '—';

  return {
    technicalScore,
    fundamentalScore,
    sentimentScore: flowScore,
    flowScore,
    quantScore: technicalScore,
    midTermScore: Math.round(fundamentalScore * 0.65 + flowScore * 0.35),
    dxyDevMa60,
    tipsChange60dBp,
    gld5dRet,
    gld20dRet,
    macroTag,
    macroLabel,
    gate,
    fundamentalSummary: `实盘量化推导（无当日 AI 研报）：FRED 实际利率 TIPS ${tipsStr}，美元指数 ${dxyStr}${tipsChange60dBp != null ? `，TIPS 60日变动 ${tipsChange60dBp >= 0 ? '+' : ''}${tipsChange60dBp}bp` : ''}。`,
    sentimentSummary: `当日无 AI 日报解读，由机构持仓与 ETF 资金流客观驱动：CFTC 净多头 ${cftcStr}，GLD 近 20 日涨跌 ${gldStr}。`,
    technicalSummary: `由 5 年连续实盘日线推导：现价相对 MA20 ${ma20Dev >= 0 ? '+' : ''}${round(ma20Dev, 2)}%，相对 MA60 ${ma60Dev >= 0 ? '+' : ''}${round(ma60Dev, 2)}%，RSI(14) = ${round(rsi, 1)}。`,
  };
}

function parseAiReports(dir, files) {
  const rawRows = [];
  for (const file of files) {
    const date = file.slice('goldrush-analysis-'.length, 'goldrush-analysis-'.length + 10);
    const md = fs.readFileSync(path.join(dir, file), 'utf-8');
    const meta = loadMetaSafe(dir, file);
    const londonClose = extractLondonClose(md);
    const shanghaiClose = extractShanghaiClose(md);
    const macro = extractMacroNumbers(md, meta);
    const dims = extractDimensionDetails(md);
    const transmission = extractTransmission(md);
    const scores = extractOverallAndQuant(md, meta);

    rawRows.push({
      date,
      filename: file,
      hasAiReport: true,
      dataSource: 'ai_report_only',
      londonClose,
      shanghaiClose,
      cnyPerGram: shanghaiClose != null
        ? shanghaiClose
        : (londonClose != null ? round((londonClose * DEFAULT_USD_CNY) / TROY_OUNCE_TO_GRAM, 2) : null),
      cnySource: shanghaiClose != null ? 'shanghai' : 'converted',
      usdCnyRate: DEFAULT_USD_CNY,
      overallScore: scores.overallScore,
      quantScore: scores.quantScore,
      midTermScore: scores.midTermScore,
      flowScore: scores.flowScore,
      technicalScore: dims.technical.score,
      technicalSummary: dims.technical.summary,
      fundamentalScore: dims.fundamental.score,
      fundamentalSummary: dims.fundamental.summary,
      sentimentScore: dims.sentiment.score,
      sentimentSummary: dims.sentiment.summary,
      tipsYield: macro.tips,
      dxy: macro.dxy,
      us10y: macro.us10y,
      macroLabel: macro.macroLabel,
      macroTag: macro.macroTag,
      dxyDevMa60: macro.dxyDevMa60,
      tipsChange60dBp: macro.tipsChange60dBp,
      cftcPercentile: macro.cftcPercentile,
      officialFlowScore: macro.officialFlowScore,
      transmission,
      gate: scores.gate,
      position: scores.position,
      midTermDrivers: meta?.midTerm?.drivers || [],
      midTermWatchTriggers: meta?.midTerm?.watchTriggers || [],
      midTermSummary: meta?.midTerm?.summary || '',
    });
  }
  return rawRows;
}

function invalidateForecastCache() {
  _cache = null;
  _monthlyCache = null;
}

/** 加载 25 年连续月线宏观快照（带 mtime + 大小缓存，供 1年 / 2年 / 5年 预测引擎使用） */
function loadMonthlyForecastDataset(docsDir) {
  const dir = path.resolve(docsDir);
  if (!fs.existsSync(dir)) return [];
  const { monthlyJsonlPath } = getSnapshotPaths(dir);
  let sig = '0';
  try {
    const st = fs.statSync(monthlyJsonlPath);
    sig = `${st.mtimeMs}:${st.size}`;
  } catch {
    return [];
  }
  if (_monthlyCache && _monthlyCache.dir === dir && _monthlyCache.sig === sig) {
    return _monthlyCache.rows;
  }
  const rows = readMonthlySnapshot(dir);
  _monthlyCache = { dir, sig, rows };
  return rows;
}

/**
 * 加载完整按日期升序排列的黄金走势预测数据集（优先融合 5 年实盘快照 + AI 日报）
 * @param {string} docsDir
 */
function loadDailyForecastDataset(docsDir) {
  const dir = path.resolve(docsDir);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir)
    .filter(f => /^goldrush-analysis-\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();

  const { jsonlPath, metaPath } = getSnapshotPaths(dir);
  const safeStatSig = (p) => {
    try {
      const st = fs.statSync(p);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '0';
    }
  };

  const mdSig = files.length + ':' + (files[files.length - 1] || '') + ':' +
    (files.length ? safeStatSig(path.join(dir, files[files.length - 1])) : '0');
  const sig = `${mdSig}|snap:${safeStatSig(jsonlPath)}|meta:${safeStatSig(metaPath)}`;

  if (_cache && _cache.dir === dir && _cache.sig === sig) {
    return _cache.records;
  }

  const aiRows = parseAiReports(dir, files);
  const snapshotRows = readMarketSnapshot(dir);
  const syncMeta = readSyncMeta(dir);

  let records;

  if (snapshotRows.length >= 30) {
    // 主路径：以 5 年连续实盘日线为底表，叠加 AI 日报三面研判与事件传导
    const aiByDate = new Map();
    for (const a of aiRows) aiByDate.set(a.date, a);

    records = snapshotRows.map((row, idx) => {
      const ai = aiByDate.get(row.date) || null;
      const isLatest = idx === snapshotRows.length - 1;
      const obj = buildObjectiveMarketPillars(snapshotRows, idx, syncMeta, isLatest);

      const londonClose = row.londonClose;
      const usdCnyRate = row.usdCny || DEFAULT_USD_CNY;
      const convertedCny = round((londonClose * usdCnyRate) / TROY_OUNCE_TO_GRAM, 2);

      // 优先使用实盘上海金 Au99.99；若历史 AI 日报中的上海金与当前折算价偏差 >15%，不混用避免假跳变
      let shanghaiClose = row.shanghaiClose ?? null;
      if (shanghaiClose == null && ai?.shanghaiClose != null) {
        if (Math.abs(ai.shanghaiClose - convertedCny) / convertedCny <= 0.15) {
          shanghaiClose = ai.shanghaiClose;
        }
      }

      const cnyPerGram = shanghaiClose != null ? shanghaiClose : convertedCny;
      const cnySource = shanghaiClose != null ? 'shanghai' : 'converted';

      return {
        date: row.date,
        filename: ai ? ai.filename : null,
        hasAiReport: Boolean(ai),
        dataSource: ai ? 'ai_report_fused' : 'market_live_fused',
        priceSource: row.source || 'yahoo_gc',
        macroObsDate: row.macroObsDate || null,
        cftcObsDate: row.cftcObsDate || null,
        londonClose,
        shanghaiClose,
        cnyPerGram,
        cnySource,
        usdCnyRate,
        gldClose: row.gldClose ?? null,
        gldVol: row.gldVol ?? null,
        gld5dRet: obj.gld5dRet,
        gld20dRet: obj.gld20dRet,
        cftcNet: row.cftcNet ?? null,
        cftcPercentile: row.cftcPct ?? ai?.cftcPercentile ?? null,
        overallScore: ai ? ai.overallScore : null,
        quantScore: ai?.quantScore ?? obj.quantScore,
        midTermScore: ai?.midTermScore ?? obj.midTermScore,
        flowScore: ai?.flowScore ?? obj.flowScore,
        officialFlowScore: ai?.officialFlowScore ?? obj.flowScore,
        technicalScore: ai?.technicalScore ?? obj.technicalScore,
        technicalSummary: ai?.technicalSummary || obj.technicalSummary,
        fundamentalScore: ai?.fundamentalScore ?? obj.fundamentalScore,
        fundamentalSummary: ai?.fundamentalSummary || obj.fundamentalSummary,
        sentimentScore: ai?.sentimentScore ?? obj.sentimentScore,
        sentimentSummary: ai?.sentimentSummary || obj.sentimentSummary,
        tipsYield: row.tips ?? ai?.tipsYield ?? null,
        dxy: row.dxy ?? ai?.dxy ?? null,
        us10y: row.us10y ?? ai?.us10y ?? null,
        macroLabel: ai?.macroLabel || obj.macroLabel,
        macroTag: ai?.macroTag || obj.macroTag,
        dxyDevMa60: obj.dxyDevMa60 ?? ai?.dxyDevMa60 ?? null,
        tipsChange60dBp: obj.tipsChange60dBp ?? ai?.tipsChange60dBp ?? null,
        transmission: ai ? ai.transmission : null,
        gate: ai?.gate || obj.gate,
        position: ai ? ai.position : null,
        midTermDrivers: ai?.midTermDrivers || [],
        midTermWatchTriggers: ai?.midTermWatchTriggers || [],
        midTermSummary: ai?.midTermSummary || '',
      };
    });
  } else {
    // 回退路径：无 5 年快照时兼容纯 docs/*.md 历史模式
    const cleaned = [];
    for (let i = 0; i < aiRows.length; i++) {
      const cur = { ...aiRows[i] };
      if (cur.londonClose != null && cleaned.length > 0) {
        const prev = cleaned[cleaned.length - 1].londonClose;
        const jump = Math.abs(cur.londonClose - prev) / prev;
        if (jump > 0.18) {
          const nextValid = aiRows.slice(i + 1, i + 4).find(r => r.londonClose != null)?.londonClose;
          if (nextValid != null && Math.abs(nextValid - prev) / prev < 0.12) {
            cur.londonClose = prev;
            cur.cnyPerGram = round((prev * DEFAULT_USD_CNY) / TROY_OUNCE_TO_GRAM, 2);
          }
        }
      }
      if (cur.londonClose != null) {
        cleaned.push(cur);
      }
    }
    records = cleaned;
  }

  _cache = { dir, sig, records };
  return records;
}

module.exports = {
  TROY_OUNCE_TO_GRAM,
  DEFAULT_USD_CNY,
  isValidGoldPrice,
  invalidateForecastCache,
  loadDailyForecastDataset,
  loadMonthlyForecastDataset,
  extractLondonClose,
  extractDimensionDetails,
  extractMacroNumbers,
  extractTransmission,
};
