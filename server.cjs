#!/usr/bin/env node
// GoldRush Docs Server — 展示 docs/ 下的分析报告，带评分可视化、搜索过滤

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { marked } = require('marked');
const { sanitizeMarkdownHtml } = require('./web/md-sanitize.cjs');
const { processArticleContent } = require('./web/article-collapse.cjs');
const { homeCss, articleCss } = require('./web/theme-css.cjs');
const {
  listDualScores,
  attachNeighborDeltas,
  attachPredictionOutcomes,
  renderListDualHtml,
  renderQuantBadgeHtml,
  renderListDeltaHtml,
  renderListOutcomeHtml,
  renderListPosHtml,
  buildCardSearchBlob,
} = require('./web/list-card-meta.cjs');
const {
  extractScore,
  extractQuantScore,
  extractQuantCoverage,
} = require('./web/report-extract.cjs');
const { renderHorizonStrip } = require('./web/horizon-strip.cjs');
const {
  loadReportMeta,
  scoreInfoFromMeta,
  quantInfoFromMeta,
  positionFromMeta,
  adviceFromMeta,
  gateFromMeta,
  dualFromMeta,
} = require('./web/report-meta.cjs');

/** macOS 风格窗口标题栏（装饰性 traffic lights） */
function macTitlebar(label = '') {
  const lab = label
    ? `<div class="mac-titlebar-label">${esc(label)}</div>`
    : '<div class="mac-titlebar-label" aria-hidden="true"></div>';
  return `<div class="mac-titlebar" aria-hidden="true">
    <div class="traffic"><span class="tl-close"></span><span class="tl-min"></span><span class="tl-max"></span></div>
    ${lab}
  </div>`;
}

const PORT = parseInt(process.env.PORT || '80', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DOCS_DIR = path.resolve(__dirname, 'docs');
const DOCS_ROOT = DOCS_DIR + path.sep;
/** 校准样本少于此数时醒目提示「样本不足」 */
const CALIBRATION_SAMPLE_WARN = 5;

// ===== 评分提取 =====

// extractScore / extractQuantScore 见 web/report-extract.cjs（兼容区间格式，有单测）

/** 提取四维度评分（仅匹配表格行，避免正文中误匹配） */
function extractDimensionScores(md) {
  const seen = new Set();
  const dims = [];
  // 仅匹配表格行：| 技术面 | 59/100 | ...
  const pattern = /^\| (技术面|基本面|情绪面|基金面) \| (\d+)\/100/mg;
  let m;
  while ((m = pattern.exec(md)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    dims.push({ name: m[1], score: parseInt(m[2], 10) });
  }
  return dims;
}

/** 提取评分构成表格（新格式 Markdown） */
function extractScoreBreakdown(md) {
  const idx = md.indexOf('## 📊 评分构成');
  if (idx < 0) return null;
  const slice = md.slice(idx, idx + 2000);
  const rows = [];
  for (const line of slice.split('\n')) {
    if (!line.startsWith('|') || line.includes('---') || line.includes('步骤')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    rows.push({
      step: cells[0].replace(/\*\*/g, ''),
      detail: cells[1],
      delta: cells[2].replace(/\*\*/g, ''),
      total: cells[3].replace(/\*\*/g, ''),
    });
  }
  return rows.length ? rows : null;
}

/** 提取速览信息（基准情景 + 短期操作） */
function extractQuickGlance(md) {
  const glance = { baseAction: '', shortAction: '', baseProb: '', macroLabel: '' };
  const macro = extractMacroRegime(md);
  if (macro) glance.macroLabel = macro.label;
  const baseRow = md.match(/\| 基准 \| ([^|]+) \| ([^|]+) \| ([^|]+)/);
  if (baseRow) {
    glance.baseProb = baseRow[1].trim();
    glance.baseAction = baseRow[3].trim().slice(0, 80);
  }
  const shortOp = md.match(/## ⏱️ 短期策略[\s\S]*?- 操作：([^\n]+)/);
  if (shortOp) glance.shortAction = shortOp[1].trim().slice(0, 60);
  return glance;
}

/** 提取宏观阶段 */
function extractMacroRegime(md) {
  const block = md.match(/## 🌐 宏观阶段[\s\S]*?(?=\n## |\n---|\Z)/);
  if (!block) return null;
  const label = block[0].match(/\*\*([^*]+)\*\*/);
  const tag = block[0].match(/`([^`]+)`/);
  const desc = block[0].match(/\n- ([^\n]+)\n- ([^\n]+)/);
  return {
    label: label ? label[1].trim() : '',
    tag: tag ? tag[1].trim() : '',
    description: desc ? desc[2].trim() : '',
  };
}

/** 提取裁决摘要首行 */
function extractJudgeVerdict(md) {
  const block = md.match(/## ⚖️ 裁决摘要[\s\S]*?(?=\n## |\n---|\Z)/);
  if (!block) return null;
  const line = block[0].match(/^- (.+)$/m);
  return line ? line[1].trim() : null;
}

/** 提取历史相似日（最多 3 条） */
function extractSimilarDays(md) {
  const idx = md.indexOf('## 📜 历史相似日');
  if (idx < 0) return null;
  const slice = md.slice(idx, idx + 1500);
  const rows = [];
  for (const line of slice.split('\n')) {
    if (!line.startsWith('|') || line.includes('---') || line.includes('日期')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    rows.push({ date: cells[0], similarity: cells[1], score: cells[2], ret: cells[3] });
  }
  return rows.length ? rows.slice(0, 3) : null;
}

/** 提取数据置信度 */
function extractDataConfidence(md) {
  const m = md.match(/数据置信度[：:]\s*(\d+)%/);
  return m ? parseInt(m[1], 10) : null;
}

/** 双打分：从 MD 解析 LLM/量化/策略 */
function extractDualScore(md) {
  const quant = extractQuantScore(md);
  const scoreInfo = extractScore(md);
  if (!scoreInfo) return null;
  const llm = scoreInfo.score;
  const q = quant?.quantScore ?? null;
  let policy = 'both';
  let conflict = false;
  if (/操作弃权|双体系不一致|双分分歧|hold_on_conflict|方向对立|阶段判断不完全一致|同向.*分差偏大/.test(md)) {
    policy = 'hold_on_conflict';
    conflict = true;
  } else if (q != null && Math.abs(llm - q) > 15) {
    policy = 'hold_on_conflict';
    conflict = true;
  } else if (q != null && Math.abs(llm - q) > 8) {
    policy = 'quant_preferred';
  }
  return {
    llm,
    quant: q,
    delta: q != null ? llm - q : null,
    policy,
    conflict,
  };
}

function renderDualScoreBanner(dual) {
  if (!dual || dual.quant == null) return '';
  const d = dual.delta;
  const dStr = d == null ? '—' : (d > 0 ? `+${d}` : String(d));
  const cls = dual.conflict ? 'dual-conflict' : Math.abs(d || 0) > 8 ? 'dual-mild' : 'dual-ok';
  const policyLabel = dual.conflict
    ? '双分分歧 · 仓位受限 · 定投为主'
    : dual.policy === 'quant_preferred'
      ? '同向微偏 · 叙事LLM / 结构向量化'
      : '双分一致';
  return `<div class="dual-banner ${cls}" role="status">
    <div class="dual-title">⚖️ 双打分 · LLM ${dual.llm} · 量化 ${dual.quant} · 偏差 ${esc(dStr)}</div>
    <div class="dual-policy">${esc(policyLabel)}</div>
    <div class="dual-note">两套分数独立校准；分歧时不抬某一侧权重，以仓位%为准</div>
  </div>`;
}

/** 从 MD「当前仓位推荐」小节提取 */
function extractPositionRecommend(md) {
  const sec = md.match(/##\s*[📦\s]*当前仓位推荐([\s\S]*?)(?=\n##\s|$)/);
  if (!sec) return null;
  const body = sec[1];
  const pctM = body.match(/相对计划仓\s*\*{0,2}(\d+)%/);
  const labelM = body.match(/(极轻|偏轻|标配|偏积极|积极)/);
  const coreM = body.match(/定投层\s*(\d+)%/);
  const satM = body.match(/波段层\s*(\d+)%/);
  const headlineM = body.match(/\*\*结论\*\*[：:]\s*(.+)/);
  const actionM = body.match(/\*\*操作\*\*[：:]\s*(.+)/);
  const tiltM = body.match(/\*\*倾向\*\*[：:]\s*(.+)/);
  const riskSummaryM = body.match(/\*\*风险摘要\*\*[：:]\s*(.+)/);
  const volM = body.match(/近20日波动[^：:]*[：:]\s*([\d.]+)%/);
  const ddM = body.match(/近60日自高点回撤[：:]\s*([\d.]+)%/);
  const prevM = body.match(/较昨日目标仓[：:]\s*(\d+)%\s*[→\-–]\s*(\d+)%/);
  const badges = [];
  for (const b of ['平稳', '偏高波动', '高波动', '近窗回撤', '日调受限']) {
    if (body.includes(b) || body.includes('`' + b + '`')) badges.push(b);
  }
  const targetPct = pctM ? parseInt(pctM[1], 10) : null;
  if (targetPct == null) return null;
  const label = labelM ? labelM[1] : '标配';
  let emoji = '🟡';
  if (label === '极轻') emoji = '🔴';
  else if (label === '偏轻') emoji = '🟠';
  else if (label === '偏积极') emoji = '🟢';
  else if (label === '积极') emoji = '🔵';
  let tilt = 'hold';
  if (tiltM) {
    if (/减|轻/.test(tiltM[1])) tilt = 'reduce';
    else if (/积极|加/.test(tiltM[1])) tilt = 'add';
  }
  return {
    targetPct,
    label,
    emoji,
    coreSharePct: coreM ? parseInt(coreM[1], 10) : null,
    satelliteSharePct: satM ? parseInt(satM[1], 10) : null,
    headline: headlineM ? headlineM[1].trim() : '',
    action: actionM ? actionM[1].trim() : '',
    tilt,
    riskSummary: riskSummaryM ? riskSummaryM[1].trim() : '',
    vol20AnnPct: volM ? parseFloat(volM[1]) : null,
    drawdown60Pct: ddM ? parseFloat(ddM[1]) : null,
    prevTargetPct: prevM ? parseInt(prevM[1], 10) : null,
    badges,
  };
}

/** 旧报告「双体系不一致」泛化标题 → 用双分数重写成有信息量的一句话 */
function enrichPositionHeadline(pos, dual) {
  if (!pos) return pos;
  if (pos.headline && !/双体系不一致|操作弃权/.test(pos.headline)) return pos;
  if (!dual || dual.llm == null) return pos;
  return { ...pos, headline: conflictHeadlineFromDual(dual, pos) };
}

/**
 * 从 MD「较昨日一览」提取差分摘要（首页/文章页首屏）
 */
function extractDayDelta(md) {
  const sec = md.match(/##\s*[📅\s]*较昨日一览([\s\S]*?)(?=\n##\s|$)/);
  if (!sec) return null;
  const body = sec[1];
  const headlineM = body.match(/>\s*\*{0,2}(.+?)\*{0,2}\s*$/m);
  const headline = headlineM ? headlineM[1].replace(/\*\*/g, '').trim() : '';
  const skipFineRead = /可跳过细读|基本持平/.test(headline) || /可跳过细读/.test(body);
  const scoreM = body.match(/\|\s*综合分\s*\|\s*([-\d.]+)\s*\|\s*([-\d.]+)\s*\|\s*([+\-±\d.]+)/);
  const quantM = body.match(/\|\s*量化分\s*\|\s*([-\d.]+)\s*\|\s*([-\d.]+)\s*\|\s*([+\-±\d.]+)/);
  const posM = body.match(/\|\s*建议仓位\s*\|\s*([-\d.]+)%?\s*\|\s*([-\d.]+)%?\s*\|\s*([+\-±\d.]+)/);
  const driverM = body.match(/\*\*驱动归因\*\*[：:]\s*(.+)/);
  const trackM = body.match(/\*\*校准叙事\*\*[：:]\s*(.+)/);
  const parseDelta = (s) => {
    if (s == null) return null;
    const t = String(s).replace(/[±点%]/g, '').trim();
    if (t === '' || t === '0') return 0;
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : null;
  };
  return {
    headline: headline || '较昨日一览',
    skipFineRead,
    scoreDelta: scoreM ? parseDelta(scoreM[3]) : null,
    quantDelta: quantM ? parseDelta(quantM[3]) : null,
    positionDelta: posM ? parseDelta(posM[3]) : null,
    prevScore: scoreM ? parseFloat(scoreM[1]) : null,
    currScore: scoreM ? parseFloat(scoreM[2]) : null,
    prevPositionPct: posM ? parseFloat(posM[1]) : null,
    currPositionPct: posM ? parseFloat(posM[2]) : null,
    driverSummary: driverM ? driverM[1].trim() : '',
    trackHint: trackM ? trackM[1].trim() : '',
  };
}

/** 较昨日差分面板 */
function renderDayDeltaPanel(dd) {
  if (!dd) return '';
  const skipClass = dd.skipFineRead ? ' dd-skip' : '';
  const chip = (label, delta, unit = '') => {
    if (delta == null) return '';
    const sign = delta > 0 ? '+' : delta === 0 ? '±' : '';
    const tone = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
    return `<span class="dd-chip dd-${tone}">${label} ${sign}${delta}${unit}</span>`;
  };
  const chips = [
    chip('综合分', dd.scoreDelta),
    chip('量化分', dd.quantDelta),
    chip('仓位', dd.positionDelta, '点'),
  ].filter(Boolean).join('');
  return `<div class="dd-panel${skipClass}" role="region" aria-label="较昨日一览">
    <div class="dd-head">
      <div>
        <div class="dd-title">📅 较昨日一览</div>
        <div class="dd-sub">${dd.skipFineRead ? '与昨日差异很小 · 可跳过细读' : '相对上一份日报的变化'}</div>
      </div>
      ${dd.skipFineRead ? '<div class="dd-badge">可跳过细读</div>' : '<div class="dd-badge dd-badge-move">有变化</div>'}
    </div>
    <div class="dd-headline">${esc(dd.headline)}</div>
    ${chips ? `<div class="dd-chips">${chips}</div>` : ''}
    ${dd.driverSummary ? `<div class="dd-driver">驱动：${esc(dd.driverSummary)}</div>` : ''}
    ${dd.trackHint ? `<div class="dd-track">${esc(dd.trackHint)}</div>` : ''}
  </div>`;
}

/** 从 MD「今日必看」提取 */
function extractReadingChecklist(md) {
  const sec = md.match(/##\s*[📖\s]*今日必看([\s\S]*?)(?=\n##\s|$)/);
  if (!sec) return null;
  const body = sec[1];
  const headlineM = body.match(/>\s*\*{0,2}(.+?)\*{0,2}\s*$/m);
  const items = [];
  for (const m of body.matchAll(/^\d+\.\s*\*\*(.+?)\*\*(?:`可跳过`)?[：:]\s*(.+)$/gm)) {
    items.push({ title: m[1].trim(), value: m[2].replace(/\*\*/g, '').trim() });
  }
  if (!items.length) return null;
  return {
    headline: headlineM ? headlineM[1].replace(/\*\*/g, '').trim() : '今日必看',
    items,
  };
}

/** 从 MD「事件→黄金传导」提取 */
function extractTransmission(md) {
  const sec = md.match(/##\s*[🛰️\s]*事件→黄金传导([\s\S]*?)(?=\n##\s|$)/);
  if (!sec) return null;
  const body = sec[1];
  const headlineM = body.match(/>\s*\*{0,2}(.+?)\*{0,2}\s*$/m);
  const headline = headlineM ? headlineM[1].replace(/\*\*/g, '').trim() : '';
  const actionable = !/可忽略|传导不清/.test(headline);
  return { headline: headline || '事件→黄金传导', actionable };
}

function renderReadingChecklistPanel(cl) {
  if (!cl || !cl.items?.length) return '';
  const rows = cl.items.slice(0, 5).map((it, i) =>
    `<div class="rc-check-row"><span class="rc-check-n">${i + 1}</span><div><div class="rc-check-t">${esc(it.title)}</div><div class="rc-check-v">${esc(it.value)}</div></div></div>`
  ).join('');
  return `<div class="read-panel" role="region" aria-label="今日必看">
    <div class="read-title">📖 今日必看</div>
    <div class="read-sub">${esc(cl.headline)}</div>
    ${rows}
  </div>`;
}

function renderTransmissionPanel(tr) {
  if (!tr) return '';
  const skip = tr.actionable ? '' : ' tr-skip';
  return `<div class="tr-panel${skip}" role="region" aria-label="事件到黄金传导">
    <div class="tr-title">🛰️ 事件→黄金传导</div>
    <div class="tr-headline">${esc(tr.headline)}</div>
    <div class="tr-hint">${tr.actionable ? '对照利率/美元/避险，勿单看战争标题' : '无有效传导：热点可跳过'}</div>
  </div>`;
}

/** 读取 docs/goldrush-stats-latest.json */
function loadPredictionStats() {
  try {
    const fp = path.join(DOCS_DIR, 'goldrush-stats-latest.json');
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 从 MD「可信度一览」提取；无小节时用门禁/双分/校准粗推（旧日报兼容）
 */
function extractReliabilityCard(md, opts = {}) {
  const sec = md.match(/##\s*[🛡️\s]*可信度一览([\s\S]*?)(?=\n##\s|$)/);
  if (sec) {
    const body = sec[1];
    const scoreM = body.match(/可信度[高低中等偏]*\s*\*{0,2}(\d{1,3})\/100/);
    const bandM = body.match(/区间\s*\*{0,2}(\d{1,3})[–\-−](\d{1,3})/);
    const centerM = body.match(/中心\s*(\d{1,3})/);
    const labelM = body.match(/(可信度较高|可信度中等|可信度偏低|数据不可操作)/);
    const tldr = [];
    const tldrBlock = body.match(/###\s*三行看懂([\s\S]*?)(?=\n###|\n\||\n##|$)/);
    if (tldrBlock) {
      for (const m of tldrBlock[1].matchAll(/^\d+\.\s*(.+)$/gm)) {
        tldr.push(m[1].replace(/\*\*/g, '').trim());
      }
    }
    let score = scoreM ? parseInt(scoreM[1], 10) : null;
    if (score == null && bandM) score = Math.round((parseInt(bandM[1], 10) + parseInt(bandM[2], 10)) / 2);
    if (score == null) return null;
    let tier = 'medium';
    const label = labelM ? labelM[1] : '可信度中等';
    if (label.includes('较高')) tier = 'high';
    else if (label.includes('偏低')) tier = 'low';
    else if (label.includes('不可操作')) tier = 'blocked';
    const low = bandM ? parseInt(bandM[1], 10) : Math.max(0, (opts.score ?? score) - 6);
    const high = bandM ? parseInt(bandM[2], 10) : Math.min(100, (opts.score ?? score) + 6);
    return {
      score,
      tier,
      label,
      emoji: tier === 'high' ? '🟢' : tier === 'blocked' ? '🔴' : tier === 'low' ? '🟠' : '🟡',
      scoreBand: { low, high, center: centerM ? parseInt(centerM[1], 10) : opts.score ?? Math.round((low + high) / 2) },
      tldr,
      approx: false,
    };
  }

  // 旧日报粗推
  const gate = opts.qualityGate;
  const dual = opts.dualScore;
  const cal = opts.calibration;
  const center = opts.score != null ? opts.score : 50;
  let pts = 50;
  if (gate) {
    if (!gate.actionable || gate.tier === 'red') pts = 25;
    else if (gate.tier === 'yellow') pts = 48;
    else pts = 68;
  }
  if (dual?.conflict) pts = Math.min(pts, 40);
  if (cal?.sample != null && cal.sample < 5) pts = Math.min(pts, 45);
  else if (cal?.sample != null && cal.sample >= 20) pts = Math.min(100, pts + 8);
  const half = pts < 40 ? 12 : pts < 55 ? 9 : pts < 70 ? 6 : 4;
  let tier = 'medium';
  if (gate && !gate.actionable) tier = 'blocked';
  else if (pts >= 72) tier = 'high';
  else if (pts < 50) tier = 'low';
  const label = tier === 'high' ? '可信度较高' : tier === 'blocked' ? '数据不可操作' : tier === 'low' ? '可信度偏低' : '可信度中等';
  return {
    score: pts,
    tier,
    label,
    emoji: tier === 'high' ? '🟢' : tier === 'blocked' ? '🔴' : tier === 'low' ? '🟠' : '🟡',
    scoreBand: {
      low: Math.max(0, center - half),
      high: Math.min(100, center + half),
      center,
    },
    tldr: [
      `研判 ${Math.max(0, center - half)}–${Math.min(100, center + half)}/100（中心 ${center}）· 旧报告粗推`,
      opts.positionLine || '仓位见下方面板',
      `${label} ${pts}/100（旧报告无完整可信度小节）`,
    ],
    approx: true,
  };
}

/** 可信度一览面板（三行看懂） */
function renderReliabilityPanel(rel) {
  if (!rel) return '';
  const tierClass = `rel-${rel.tier || 'medium'}`;
  const band = rel.scoreBand || { low: '—', high: '—', center: '—' };
  const tldrHtml = (rel.tldr || []).slice(0, 3).map((line, i) =>
    `<div class="rel-tldr-line"><span class="rel-n">${i + 1}</span><span>${esc(String(line).replace(/\*\*/g, ''))}</span></div>`
  ).join('');
  return `<div class="rel-panel ${tierClass}" role="region" aria-label="可信度一览">
    <div class="rel-head">
      <div>
        <div class="rel-title">🛡️ 可信度一览${rel.approx ? ' <span class="rel-approx">粗推</span>' : ''}</div>
        <div class="rel-sub">操作可信度 · 非涨跌准确率保证</div>
      </div>
      <div class="rel-score-block">
        <div class="rel-score">${rel.emoji} ${rel.score}<span class="rel-score-unit">/100</span></div>
        <div class="rel-label">${esc(rel.label)}</div>
      </div>
    </div>
    <div class="rel-band">
      <span class="rel-band-label">评分区间</span>
      <strong>${band.low}–${band.high}</strong>
      <span class="rel-band-center">中心 ${band.center}</span>
    </div>
    ${tldrHtml ? `<div class="rel-tldr">${tldrHtml}</div>` : ''}
  </div>`;
}

/** 仓位推荐面板（含 v2 风险角标） */
function renderPositionPanel(pos) {
  if (!pos) return '';
  const core = pos.coreSharePct != null ? pos.coreSharePct : '—';
  const sat = pos.satelliteSharePct != null ? pos.satelliteSharePct : '—';
  const tiltLabel = pos.tilt === 'reduce' ? '偏轻/减仓' : pos.tilt === 'add' ? '可小幅积极' : '维持';
  const barColor = pos.targetPct <= 40 ? '#ef4444' : pos.targetPct >= 70 ? '#22c55e' : '#f59e0b';
  const riskHot = (pos.badges || []).some(b => /高波动|偏高波动|近窗回撤/.test(b));
  const badgeHtml = (pos.badges || []).slice(0, 4).map(b => {
    const hot = /高波动|偏高波动|近窗回撤|日调受限/.test(b);
    return `<span class="pos-risk-badge${hot ? ' hot' : ''}">${esc(b)}</span>`;
  }).join('');
  const riskLine = pos.riskSummary
    ? `<div class="pos-risk-line${riskHot ? ' hot' : ''}">🛡️ ${esc(pos.riskSummary)}</div>`
    : (badgeHtml ? `<div class="pos-risk-line">🛡️ 风险约束 v2</div>` : '');
  return `<div class="pos-panel" role="region" aria-label="当前仓位推荐">
    <div class="pos-head">
      <span class="pos-emoji">${pos.emoji}</span>
      <div>
        <div class="pos-title">📦 当前仓位推荐</div>
        <div class="pos-sub">相对「黄金计划仓」=100% · 波动/日平滑自动收一收</div>
      </div>
      <div class="pos-pct" style="color:${barColor}">${pos.targetPct}<span class="pos-pct-unit">%</span></div>
    </div>
    <div class="pos-meter"><div class="pos-fill" style="width:${pos.targetPct}%;background:${barColor}"></div></div>
    <div class="pos-tags">
      <span class="pos-tag">${esc(pos.label)}</span>
      <span class="pos-tag">定投层 ${core}%</span>
      <span class="pos-tag">波段层 ${sat}%</span>
      <span class="pos-tag">${esc(tiltLabel)}</span>
      ${badgeHtml}
    </div>
    ${riskLine}
    ${pos.headline ? `<div class="pos-headline">${esc(pos.headline)}</div>` : ''}
    ${pos.action ? `<div class="pos-action">→ ${esc(pos.action)}</div>` : ''}
  </div>`;
}

/** 历史预测对错统计面板 */
function renderPredictionStatsPanel(stats) {
  if (!stats) return '';
  const llmRate = stats.llm?.hitRate != null ? `${stats.llm.hitRate}%` : 'N/A';
  const quantRate = stats.quant?.hitRate != null ? `${stats.quant.hitRate}%` : 'N/A';
  const highRate = stats.highScoreUpRate != null ? `${stats.highScoreUpRate}%` : 'N/A';
  const lowRate = stats.lowScoreUpRate != null ? `${stats.lowScoreUpRate}%` : 'N/A';
  const llmN = stats.llm?.total != null ? `${stats.llm.hits ?? 0}/${stats.llm.total}` : '—';
  const quantN = stats.quant?.total != null ? `${stats.quant.hits ?? 0}/${stats.quant.total}` : '—';

  const bucketRows = (stats.buckets || []).slice(0, 8).map(b => {
    const avg = b.avgReturn > 0 ? `+${b.avgReturn}%` : `${b.avgReturn}%`;
    return `<tr><td>${esc(b.range)}</td><td>${b.sample}</td><td>${b.upRate}%</td><td>${avg}</td></tr>`;
  }).join('');

  const recentRows = (stats.recent || []).slice(0, 10).map(r => {
    const mark = r.status === 'hit' ? '✅' : r.status === 'miss' ? '❌' : r.status === 'flat' ? '➖' : '⏳';
    const ret = r.actual5dPct != null ? `${r.actual5dPct > 0 ? '+' : ''}${r.actual5dPct}%` : '—';
    const q = r.quantScore != null ? r.quantScore : '—';
    const align = r.alignPct == null ? '—'
      : r.alignPct >= 0 ? `顺+${r.alignPct}%` : `逆${Math.abs(r.alignPct)}%`;
    return `<tr><td>${esc(r.date)}</td><td>${r.llmScore}</td><td>${q}</td><td>${esc(r.pred)}</td><td>${ret}</td><td>${mark}</td><td>${esc(align)}</td></tr>`;
  }).join('');

  return `<div class="pred-stats-panel" role="region" aria-label="历史预测对错">
    <div class="ps-head">
      <div class="ps-title">📊 历史预测对错</div>
      <div class="ps-sub">近 ${stats.windowDays ?? 90} 日 · 5 日标签 · 样本 ${stats.sampleEligible ?? '—'} · ${esc(stats.asOf || '')}</div>
    </div>
    ${stats.summary ? `<div class="ps-summary">${esc(stats.summary)}</div>` : ''}
    <!-- 默认只展示 3 个核心命中数；其余折叠 -->
    <div class="ps-grid ps-grid-core">
      <div class="ps-card"><div class="ps-num">${esc(llmRate)}</div><div class="ps-label">LLM 命中</div><div class="ps-meta">${esc(llmN)}</div></div>
      <div class="ps-card"><div class="ps-num">${esc(quantRate)}</div><div class="ps-label">量化命中</div><div class="ps-meta">${esc(quantN)}</div></div>
      <div class="ps-card"><div class="ps-num">${stats.conflictDays ?? 0}</div><div class="ps-label">双分冲突日</div><div class="ps-meta">跟Q ${stats.conflictFollowQuantHits ?? 0} / 跟L ${stats.conflictFollowLlmHits ?? 0}</div></div>
    </div>
    <details class="ps-details">
      <summary>更多统计（高低分涨概率 / 分桶 / 明细）</summary>
      <div class="ps-grid" style="margin-top:10px">
        <div class="ps-card"><div class="ps-num">${esc(highRate)}</div><div class="ps-label">高分(≥60) 5日涨</div><div class="ps-meta">n=${stats.highScoreN ?? 0}</div></div>
        <div class="ps-card"><div class="ps-num">${esc(lowRate)}</div><div class="ps-label">低分(≤40) 5日涨</div><div class="ps-meta">n=${stats.lowScoreN ?? 0}</div></div>
      </div>
      ${bucketRows ? `<div class="ps-subhead">评分区间 vs 实际 5 日</div>
        <table class="ps-table"><thead><tr><th>区间</th><th>样本</th><th>涨概率</th><th>均涨幅</th></tr></thead><tbody>${bucketRows}</tbody></table>` : ''}
      ${recentRows ? `<div class="ps-subhead">最近预测明细</div>
        <table class="ps-table"><thead><tr><th>日期</th><th>LLM</th><th>量化</th><th>预测</th><th>5日</th><th>对错</th><th>顺/逆</th></tr></thead><tbody>${recentRows}</tbody></table>` : ''}
    </details>
    <div class="ps-note">&gt;55 记涨、&lt;45 记跌，中间与持平不计命中；非业绩承诺</div>
  </div>`;
}

/**
 * 数据质量门禁（与 CLI data-quality-gate 对齐）
 * 优先解析 MD 中的「数据质量门禁」小节；旧报告按置信度推断。
 * 不再用 conf<55 一刀切。
 */
function extractDataQualityGate(md) {
  const confidence = extractDataConfidence(md);
  let tier = null;
  let actionable = true;
  const notes = [];

  const secMatch = md.match(/##\s*[📋\s]*数据质量门禁([\s\S]*?)(?=\n##\s|$)/);
  if (secMatch) {
    const body = secMatch[1];
    if (/操作结论已关闭|请勿据此|可否依据本报告操作[：:].{0,20}否|分档[：:].{0,20}不可用/.test(body)) {
      tier = 'red';
      actionable = false;
    } else if (/分档[：:].{0,30}高可信|高可信\s*✅/.test(body)) {
      tier = 'green';
      actionable = true;
    } else if (/降级可用|分档[：:].{0,30}降级/.test(body)) {
      tier = 'yellow';
      actionable = true;
    }
    for (const qm of body.matchAll(/^>\s*(.+)$/gm)) {
      notes.push(qm[1].trim());
    }
  }

  // 正文标记
  if (!tier && (/操作结论已关闭|数据不合格：本报告操作建议/.test(md))) {
    tier = 'red';
    actionable = false;
  }

  // 旧报告回退：硬拦 conf<35；绿 ≥70；其余黄
  if (!tier) {
    if (confidence != null && confidence < 35) {
      tier = 'red';
      actionable = false;
      notes.push(`综合置信度 ${confidence}% < 35%`);
    } else if (confidence != null && confidence >= 70) {
      tier = 'green';
      actionable = true;
    } else {
      tier = 'yellow';
      actionable = true;
      if (confidence != null) notes.push(`综合置信度 ${confidence}%（降级可用）`);
      else notes.push('未写入置信度，按降级可用展示');
    }
  }

  return {
    tier,
    actionable,
    confidence,
    notes,
    label: tier === 'green' ? '高可信' : tier === 'yellow' ? '降级可用' : '不可用',
    emoji: tier === 'green' ? '🟢' : tier === 'yellow' ? '🟡' : '🔴',
  };
}

/** 红档操作建议（Web） */
function nonActionableAdviceWeb() {
  return {
    label: '数据不可用',
    headline: '数据质量不足，暂停依据本报告操作',
    action: '维持既有定投纪律或观望；修复数据后重新 analysis',
    color: '#94a3b8',
    bg: '#33415544',
    emoji: '🔴',
  };
}

/**
 * 统一操作建议（对齐 plain-advice.resolveOperationalAdvice 优先级）
 * 1 门禁红 2 双分分歧（有仓位则用仓位%作主结论） 3 仓位 4 分数
 */
function conflictHeadlineFromDual(dual, positionRec) {
  const llm = dual?.llm;
  const q = dual?.quant;
  const pct = positionRec?.targetPct;
  if (llm == null || q == null) {
    return pct != null ? `双分分歧，建议仓位约 ${pct}%` : '双分分歧，维持纪律仓';
  }
  const llmDir = llm >= 58 ? '偏多' : llm <= 42 ? '偏空' : '中性';
  const qDir = q >= 58 ? '偏多' : q <= 42 ? '偏空' : '中性';
  const d = Math.round(llm - q);
  const dStr = `${d > 0 ? '+' : ''}${d}`;
  // 与 src/utils/dual-score.buildDualConflictOverride 标题口径一致
  if ((llmDir === '偏多' && qDir === '偏空') || (llmDir === '偏空' && qDir === '偏多')) {
    return `方向对立：LLM ${llmDir}${llm} vs 量化 ${qDir}${q}`;
  }
  if (llmDir !== qDir) {
    return `LLM ${llmDir}${llm} / 量化 ${qDir}${q}：阶段判断不完全一致`;
  }
  const extremeSide = Math.abs(llm - 50) > Math.abs(q - 50) ? 'LLM' : '量化';
  return `同向${llmDir}但分差偏大（Δ${dStr}）：${extremeSide}更极端`;
}

/** 建议来源 → 人话标签；dual_conflict 这类内部枚举不该直接摆到页面上 */
function adviceSourceLabel(source) {
  const map = {
    dual_conflict: '双分分歧决定',
    position: '按仓位模型',
    score: '按综合评分',
    gate: '数据门禁决定',
  };
  return map[source] || source;
}

function resolveAdvice(scoreInfo, gate, dualScore, positionRec) {
  if (gate && !gate.actionable) return nonActionableAdviceWeb();
  if (dualScore?.conflict && gate?.actionable !== false) {
    if (positionRec && positionRec.action) {
      const tilt = positionRec.tilt;
      const color = tilt === 'reduce' ? '#f97316' : tilt === 'add' ? '#22c55e' : '#f59e0b';
      let headline = positionRec.headline || '';
      // 旧报告泛化标题 → 用当日双分现算一句有信息量的
      if (!headline || /双体系不一致|操作弃权/.test(headline)) {
        headline = conflictHeadlineFromDual(dualScore, positionRec);
      }
      return {
        label: positionRec.label ? `${positionRec.label}·分歧` : '双分分歧',
        headline,
        action: positionRec.action,
        color,
        bg: color + '18',
        emoji: positionRec.emoji || '⚖️',
        source: 'dual_conflict',
      };
    }
    return {
      label: '双分分歧·克制',
      headline: conflictHeadlineFromDual(dualScore, null),
      action: '维持基础定投，按日历执行；待双分同向或校准明确后再加减仓',
      color: '#94a3b8',
      bg: '#33415544',
      emoji: '⚖️',
      source: 'dual_conflict',
    };
  }
  if (positionRec && positionRec.action) {
    const tilt = positionRec.tilt;
    const color = tilt === 'reduce' ? '#f97316' : tilt === 'add' ? '#22c55e' : '#f59e0b';
    return {
      label: positionRec.label || '仓位建议',
      headline: positionRec.headline || `建议仓位 ${positionRec.targetPct}%`,
      action: positionRec.action,
      color,
      bg: color + '18',
      emoji: positionRec.emoji || '📦',
      source: 'position',
    };
  }
  if (!scoreInfo) return null;
  const a = plainAdvice(scoreInfo.score, scoreInfo.direction);
  return { ...a, source: 'score' };
}

/** 门禁顶栏 HTML */
function renderQualityBanner(gate) {
  if (!gate) return '';
  const cls = gate.tier === 'green' ? 'dq-green' : gate.tier === 'yellow' ? 'dq-yellow' : 'dq-red';
  const conf = gate.confidence != null ? `${gate.confidence}%` : '—';
  const notes = Array.isArray(gate.notes) ? gate.notes : [];
  const extra = notes.length
    ? `<div class="dq-notes">${notes.slice(0, 4).map(n => `<div>· ${esc(n)}</div>`).join('')}</div>`
    : '';
  const actionLine = gate.actionable
    ? (gate.tier === 'green' ? '可参考本报告操作建议（仍须结合自身判断）' : '可阅读分析，建议结合量化分与主力数据')
    : '⛔ 请勿依据本报告加减仓';
  return `<div class="dq-banner ${cls}" role="status">
    <div class="dq-main">
      <span class="dq-emoji">${gate.emoji}</span>
      <span class="dq-title">数据质量 · ${gate.label}</span>
      <span class="dq-conf">置信度 ${esc(conf)}</span>
    </div>
    <div class="dq-action">${esc(actionLine)}</div>
    ${extra}
  </div>`;
}

/** 列表用小圆点 */
function qualityDot(gate) {
  if (!gate) return '';
  const title = `${gate.label} · 置信度 ${gate.confidence != null ? gate.confidence + '%' : '—'}`;
  return `<span class="dq-dot dq-dot-${gate.tier}" title="${esc(title)}"></span>`;
}

/** 提取校准参考 */
function extractCalibration(md) {
  const m = md.match(/校准参考[：:]\s*([^\n]+)/);
  if (!m) return null;
  const text = m[1];
  const range = text.match(/([\d]+-[\d]+)\s*区间/);
  const acc = text.match(/(?:准确率|涨概率)\s*(\d+)%/);
  const bias = text.match(/（([^，)]+)/);
  const sample = text.match(/样本\s*(\d+)/);
  return {
    range: range ? range[1] : '',
    accuracy: acc ? parseInt(acc[1], 10) : null,
    bias: bias ? bias[1].trim() : '',
    sample: sample ? parseInt(sample[1], 10) : null,
    raw: text.trim(),
  };
}

/** 提取三情景（概率 + 操作建议摘要） */
function extractScenarios(md) {
  const names = [
    { key: '基准', cls: 'base', icon: '⚖️' },
    { key: '上行', cls: 'up', icon: '📈' },
    { key: '下行', cls: 'down', icon: '📉' },
  ];
  const out = [];
  for (const { key, cls, icon } of names) {
    const row = md.match(new RegExp(`\\| ${key} \\| ([^|]+) \\| ([^|]+) \\| ([^|]+)`));
    if (!row) continue;
    const prob = parseInt(String(row[1]).replace(/[^\d]/g, ''), 10);
    out.push({
      name: key,
      cls,
      icon,
      probability: Number.isFinite(prob) ? prob : 0,
      summary: row[2].trim().slice(0, 100),
      action: row[3].trim().slice(0, 72),
    });
  }
  return out.length === 3 ? out : null;
}

/** 提取定投/操作策略（人话） */
function extractStrategies(md) {
  const shortOp = md.match(/## ⏱️ 短期策略[\s\S]*?- 操作：([^\n]+)/);
  const midDca = md.match(/定投建议：(\w+)/);
  const midPos = md.match(/仓位调整：(\w+)/);
  const dcaMap = { continue: '继续定投', increase: '加码定投', pause: '暂停定投' };
  const posMap = { add: '加仓', reduce: '减仓', hold: '维持仓位' };
  return {
    short: shortOp ? shortOp[1].trim().slice(0, 100) : '',
    dca: midDca ? (dcaMap[midDca[1]] || midDca[1]) : '',
    position: midPos ? (posMap[midPos[1]] || midPos[1]) : '',
  };
}

/** 分数 → 通俗结论（支付宝定投视角） */
function plainAdvice(score, direction) {
  const s = score ?? 50;
  const d = direction || (s >= 58 ? 'bullish' : s <= 42 ? 'bearish' : 'neutral');
  if (d === 'bullish' || s >= 58) {
    return {
      label: '偏多',
      headline: '黄金短期动能偏强',
      action: '维持定投；急跌可小幅加码，高位不追',
      color: '#1a7f37',
      bg: 'rgba(48, 209, 88, 0.12)',
      emoji: '📈',
    };
  }
  if (d === 'bearish' || s <= 42) {
    return {
      label: '偏空',
      headline: '下行风险大于反弹空间',
      action: '放慢定投或暂停加码，等评分/价格回落',
      color: '#c62828',
      bg: 'rgba(255, 69, 58, 0.12)',
      emoji: '📉',
    };
  }
  return {
    label: '中性',
    headline: '震荡整理，方向未明',
    action: '维持基础定投，按日历执行、少择时',
    color: '#9a6700',
    bg: 'rgba(255, 159, 10, 0.12)',
    emoji: '➡️',
  };
}

/** 30秒快速阅读卡片 — 首屏决策三件套 */
function renderQuickRead(meta) {
  const { scoreInfo, advice, dims, calibration, quantInfo, qualityGate } = meta;
  if (!scoreInfo) return '';

  const dimLabels = dims && dims.length
    ? dims.map(d => {
        const label = d.score >= 60 ? '偏多' : d.score <= 40 ? '偏空' : '中性';
        return `${d.name}${label}`;
      }).join(' · ')
    : '';

  const warnText = (calibration?.sample != null && calibration.sample < 20)
    ? `⚠️ 校准样本仅${calibration.sample}次，仅供参考`
    : '';

  // 量化评分小标签
  const quantBadge = quantInfo?.quantScore != null
    ? `<span class="qr-quant">🔢 量化 ${quantInfo.quantScore}</span>`
    : '';

  const gateBadge = qualityGate
    ? `<span class="qr-dq qr-dq-${qualityGate.tier}">${qualityGate.emoji} ${qualityGate.label}</span>`
    : '';

  return `<div class="quick-read-card ${qualityGate && !qualityGate.actionable ? 'qr-blocked' : ''}" style="border-left-color:${advice.color}">
    <div class="qr-left">
      <div class="qr-score">${scoreInfo.score}<span class="qr-total">/100</span></div>
      ${quantBadge}
      ${gateBadge}
      <div class="qr-dir">${advice.emoji} ${advice.label}</div>
    </div>
    <div class="qr-body">
      <div class="qr-action">💡 ${esc(advice.action)}</div>
      ${dimLabels ? `<div class="qr-why">${esc(dimLabels)}</div>` : ''}
      ${warnText ? `<div class="qr-warn">${esc(warnText)}</div>` : ''}
      ${qualityGate && !qualityGate.actionable ? '<div class="qr-warn">⛔ 数据门禁：操作结论已关闭</div>' : ''}
    </div>
  </div>`;
}

/** 主力流向专用仪表盘 */
function renderFlowDashboard(rawMarkdown) {
  // Extract scores from flow markdown structure
  const scoreMatch = rawMarkdown.match(/综合评分[：:]\s*\*{0,2}(\d+)\/100\*{0,2}/);
  const score = scoreMatch ? parseInt(scoreMatch[1], 10) : null;

  // Extract section scores: CFTC, ETF, 央行, GLD
  const sections = [];
  const sectionNames = [
    { key: 'CFTC', label: 'CFTC' },
    { key: 'GLD', label: '黄金ETF' },
    { key: '央行', label: '央行' },
    { key: '背离', label: '背离信号' },
  ];

  for (const { key, label } of sectionNames) {
    const pattern = new RegExp(`## .*${key}[\\s\\S]*?(\\d+)/100`);
    const m = rawMarkdown.match(pattern);
    if (m) {
      const val = parseInt(m[1], 10);
      let cls = 'neutral';
      if (val >= 60) cls = 'bullish';
      else if (val <= 40) cls = 'bearish';
      sections.push({ label, score: val, cls });
    }
  }

  if (!score) return '';

  const scoreColor = score >= 75 ? '#22c55e' : score >= 55 ? '#f59e0b' : '#ef4444';

  const gaugeHtml = sections.length
    ? sections.map(s => `
      <div class="flow-gauge ${s.cls}">
        <div class="fg-label">${esc(s.label)}</div>
        <div class="fg-score">${s.score}</div>
        <div class="fg-bar"><div class="fg-fill" style="width:${s.score}%"></div></div>
      </div>`).join('')
    : '';

  // Check for divergence warnings
  const divergenceMatch = rawMarkdown.match(/背离[^\n]*?(\d+)[^\n]*?(\d+)/);
  const hasDivergence = divergenceMatch && Math.abs(parseInt(divergenceMatch[1], 10) - parseInt(divergenceMatch[2], 10)) > 15;

  return `<div class="flow-dashboard">
    <div class="flow-hero">
      <div class="flow-main-score">
        <div class="flow-big-num" style="color:${scoreColor}">${score}</div>
        <div class="flow-big-label">主力综合评分</div>
      </div>
      <div class="flow-gauges">${gaugeHtml}</div>
    </div>
    ${hasDivergence ? '<div class="flow-warning">⚠️ 检测到背离信号，请结合多维度综合判断</div>' : ''}
  </div>`;
}

/** 历史相似日汇总（说服力） */
function summarizeSimilarDays(similar) {
  if (!similar || !similar.length) return null;
  const rets = similar.map(s => parseFloat(String(s.ret).replace(/[^\d.-]/g, ''))).filter(n => Number.isFinite(n));
  if (!rets.length) return null;
  const up = rets.filter(r => r > 0).length;
  const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
  return {
    up,
    total: rets.length,
    upRate: Math.round((up / rets.length) * 100),
    avgReturn: Math.round(avg * 100) / 100,
  };
}

/** 渲染 Markdown 前去掉已在仪表盘/侧栏展示的冗余块 */
function stripDashboardDuplicates(md) {
  // Helper: strip a Markdown section by its h2 title
  const stripSection = (title) => {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return md.replace(new RegExp(`## ${escaped}[\\s\\S]*?(?=\\n## |\\n---|\\s*$)`, ''), '');
  };
  md = stripSection('📊 评分构成');
  md = stripSection('综合研判');
  md = stripSection('📈 四维度摘要');
  // 顶部已有可视化面板，避免正文重复
  md = stripSection('📦 当前仓位推荐');
  md = stripSection('当前仓位推荐');
  md = stripSection('📊 历史预测对错');
  md = stripSection('历史预测对错');
  md = stripSection('🛡️ 可信度一览');
  md = stripSection('可信度一览');
  md = stripSection('📅 较昨日一览');
  md = stripSection('较昨日一览');
  md = stripSection('📖 今日必看');
  md = stripSection('今日必看');
  md = stripSection('🛰️ 事件→黄金传导');
  md = stripSection('事件→黄金传导');
  return md;
}

/** 校准样本不足横幅 */
function renderSampleWarn(calibration) {
  const sample = calibration?.sample;
  if (sample == null) {
    return `<div class="sample-warn" role="status">⚠️ 校准样本积累中，历史命中率仅供参考，请以定投纪律为主</div>`;
  }
  if (sample < CALIBRATION_SAMPLE_WARN) {
    return `<div class="sample-warn" role="status">⚠️ 同分段样本仅 <strong>${sample}</strong> 次（&lt;${CALIBRATION_SAMPLE_WARN}），准确率波动大，勿过度解读</div>`;
  }
  return '';
}

/** 预测仪表盘（文章页顶部）— 首屏只留决策三件套，信任条/短期 tip 可折叠 */
function renderPredictionDashboard(meta) {
  const { scoreInfo, advice, confidence, calibration, scenarios, strategies, similarSummary, macro, quantInfo, qualityGate } = meta;
  if (!scoreInfo) return '';

  const score = scoreInfo.score;
  const confPct = confidence != null ? confidence : '—';
  // 与门禁对齐：绿≥70 / 黄 / 红<35 或 red 档
  let confClass = 'mid';
  if (qualityGate?.tier === 'green' || (confidence != null && confidence >= 70)) confClass = 'good';
  if (qualityGate?.tier === 'red' || (confidence != null && confidence < 35)) confClass = 'low';

  // Calibration badge: show stats directly
  const calibParts = [];
  if (calibration?.sample != null) calibParts.push(`同分段 ${calibration.sample} 次`);
  if (calibration?.accuracy != null) calibParts.push(`5日涨 ${calibration.accuracy}%`);
  if (calibration?.bias) calibParts.push(`${calibration.bias}`);
  const calibBadge = calibParts.length
    ? `<div class="pred-calib-badge">${calibParts.join(' · ')}</div>`
    : '';
  // Macro inside calibration area if present
  const macroLine = macro ? `<div class="pred-macro-inline">🌐 ${esc(macro.label)}</div>` : '';

  // Action box — 红档灰化并改文案
  const actionLabel = qualityGate && !qualityGate.actionable ? '⛔ 操作结论已关闭' : '💡 定投建议';
  const actionBoxHtml = `
    <div class="pred-action-box ${qualityGate && !qualityGate.actionable ? 'pred-action-blocked' : ''}" style="background:${advice.bg};border-color:${advice.color}">
      <div class="pred-action-label">${actionLabel}</div>
      <div class="pred-action-text">${esc(advice.action)}</div>
    </div>`;

  const scenarioHtml = scenarios ? scenarios.map(s => `
    <div class="sc-card sc-${s.cls}">
      <div class="sc-head"><span>${s.icon} ${esc(s.name)}</span><span class="sc-pct">${s.probability}%</span></div>
      <div class="sc-bar"><div class="sc-fill" style="width:${s.probability}%"></div></div>
      <div class="sc-action">${esc(s.action || '')}</div>
    </div>`).join('') : '';

  const trustParts = [];
  if (calibration?.accuracy != null) {
    trustParts.push(`同分段历史 5 日上涨概率 <strong>${calibration.accuracy}%</strong>（${esc(calibration.range)}，样本 ${calibration.sample ?? '—'}）`);
  }
  if (similarSummary) {
    trustParts.push(`历史相似日 ${similarSummary.total} 次中 ${similarSummary.upRate}% 上涨，平均 ${similarSummary.avgReturn >= 0 ? '+' : ''}${similarSummary.avgReturn}%`);
  }
  const trustInner = trustParts.length
    ? trustParts.join('<br>')
    : '样本积累中，结论供参考，请结合定投纪律';

  // 量化评分参考线
  const quantLine = quantInfo?.quantScore != null ? (() => {
    const q = quantInfo.quantScore;
    const d = quantInfo.diff ?? (score - q);
    const absD = Math.abs(d);
    let label, color;
    if (d > 5) { label = `LLM 偏高 +${absD}`; color = '#ef4444'; }
    else if (d < -5) { label = `LLM 偏低 -${absD}`; color = '#22c55e'; }
    else if (d > 0) { label = `LLM 偏高 +${absD}`; color = '#f59e0b'; }
    else if (d < 0) { label = `LLM 偏低 -${absD}`; color = '#f59e0b'; }
    else { label = '一致'; color = '#94a3b8'; }
    const bigGap = absD > 15
      ? `<div class="pred-quant-hint">偏差&gt;15：建议以量化分 + CFTC 为底</div>`
      : '';
    return `<div class="pred-quant-bar">
      <span class="pred-quant-label">🔢 量化</span>
      <span class="pred-quant-value">${q}</span>
      <span class="pred-quant-diff" style="color:${color}">${label}</span>
    </div>${bigGap}`;
  })() : '';

  const gatePill = qualityGate
    ? `<div class="pred-pill conf-${qualityGate.tier === 'green' ? 'good' : qualityGate.tier === 'red' ? 'low' : 'mid'}">${qualityGate.emoji} ${qualityGate.label}</div>`
    : '';

  const rel = meta.reliability;
  const bandLine = rel?.scoreBand
    ? `<div class="pred-score-band">区间 ${rel.scoreBand.low}–${rel.scoreBand.high}</div>`
    : '';

  // 首屏：必看 · 较昨日 · 传导 · 可信度 · 分数/操作 · 仓位+命中
  return `<section class="pred-dashboard" aria-label="预测结论">
    ${renderReadingChecklistPanel(meta.readingChecklist)}
    ${renderDayDeltaPanel(meta.dayDelta)}
    ${renderTransmissionPanel(meta.transmission)}
    ${renderReliabilityPanel(rel)}
    ${renderSampleWarn(calibration)}
    <div class="pred-hero ${qualityGate && !qualityGate.actionable ? 'pred-hero-blocked' : ''}" style="--pred-color:${advice.color}">
      <div class="pred-score-col">
        <div class="pred-score-num">${score}</div>
        <div class="pred-score-sub">综合分 / 100</div>
        ${bandLine}
        <div class="pred-score-meter"><div class="pred-score-fill" style="width:${score}%;background:${advice.color}"></div></div>
        ${quantLine}
        ${calibBadge}
        ${macroLine}
      </div>
      <div class="pred-verdict-col">
        <div class="pred-dir-tag">${advice.emoji} ${advice.label}${advice.source ? `<span class="pred-src">${esc(adviceSourceLabel(advice.source))}</span>` : ''}</div>
        ${actionBoxHtml}
        <div class="pred-pills">
          <div class="pred-pill conf-${confClass}">数据置信 ${confPct}%</div>
          ${gatePill}
          ${rel ? `<div class="pred-pill">可信度 ${rel.score}</div>` : ''}
          ${strategies.dca && (qualityGate?.actionable !== false) ? `<div class="pred-pill">${esc(strategies.dca)}</div>` : ''}
          ${strategies.position && (qualityGate?.actionable !== false) ? `<div class="pred-pill">${esc(strategies.position)}</div>` : ''}
        </div>
      </div>
    </div>
    ${renderPositionPanel(meta.positionRec)}
    ${renderPredictionStatsPanel(meta.predictionStats)}
    <details class="pred-secondary">
      <summary>数据门禁 · 双打分 · 情景与佐证</summary>
      ${renderQualityBanner(qualityGate)}
      ${renderDualScoreBanner(meta.dualScore)}
      ${scenarioHtml ? `<div class="pred-scenarios"><div class="pred-section-title">三情景概率</div><div class="sc-grid">${scenarioHtml}</div></div>` : ''}
      <div class="pred-trust"><span class="pred-trust-icon">🎯</span><div class="pred-trust-body">${trustInner}</div></div>
      ${strategies.short ? `<div class="pred-short-tip"><span>⏱️ 短期</span>${esc(strategies.short)}</div>` : ''}
    </details>
  </section>`;
}

/** 列表页通俗结论条 */
function renderCardVerdict(score, direction) {
  const a = plainAdvice(score, direction);
  return `<span class="verdict-chip" style="color:${a.color};background:${a.bg};border-color:${a.color}33">${a.emoji} ${a.label} · ${esc(a.action.slice(0, 28))}${a.action.length > 28 ? '…' : ''}</span>`;
}

/** 渲染评分构成瀑布（侧边栏） */
function renderScoreWaterfall(breakdown) {
  if (!breakdown || !breakdown.length) return '';
  return breakdown.map(row => {
    const isFinal = row.step.includes('最终');
    const isSubtotal = row.step.includes('均分') || row.step.includes('反驳');
    let deltaClass = 'neutral';
    if (row.delta.startsWith('+')) deltaClass = 'up';
    else if (row.delta.startsWith('-') || row.delta.startsWith('−')) deltaClass = 'down';
    return `<div class="wf-row ${isFinal ? 'wf-final' : isSubtotal ? 'wf-sub' : ''}">
      <div class="wf-step">${esc(row.step)}</div>
      <div class="wf-detail">${esc(row.detail)}</div>
      <div class="wf-meta">
        ${row.delta !== '—' ? `<span class="wf-delta ${deltaClass}">${esc(row.delta)}</span>` : ''}
        ${row.total !== '—' ? `<span class="wf-total">${esc(row.total)}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

/** HTML 转义 */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== 文件信息封装 =====

/** 报告类型：analysis / digest / reflect / other */
function classifyDoc(filename) {
  if (filename.includes('flow')) return 'flow';
  if (filename.includes('reflect')) return 'reflect';
  if (filename.includes('digest')) return 'digest';
  if (filename.includes('analysis')) return 'analysis';
  if (filename.includes('calibration')) return 'calibration';
  return 'other';
}

function getFileInfos(files) {
  return files.map(f => {
    const fp = path.join(DOCS_DIR, f);
    const stats = fs.statSync(fp);
    const md = fs.readFileSync(fp, 'utf-8');
    const meta = kindIsAnalysis(f) ? loadReportMeta(fp) : null;
    const scoreInfo = scoreInfoFromMeta(meta) || extractScore(md);
    const quantInfo = quantInfoFromMeta(meta) || extractQuantScore(md);
    const dims = extractDimensionScores(md);
    const qualityGate = gateFromMeta(meta) || extractDataQualityGate(md);
    const dualScore = dualFromMeta(meta) || extractDualScore(md);
    const positionRec = enrichPositionHeadline(
      positionFromMeta(meta) || extractPositionRecommend(md),
      dualScore,
    );
    const kind = classifyDoc(f);
    let dateLabel = f.replace(/\.md$/, '');
    if (kind === 'analysis') dateLabel = f.replace('goldrush-analysis-', '').replace('.md', '');
    else if (kind === 'digest') {
      dateLabel = f.includes('latest')
        ? '周期摘要 · 最新'
        : f.replace('goldrush-digest-', '').replace('.md', '');
    } else if (kind === 'reflect') {
      dateLabel = f.includes('latest')
        ? '错因反思 · 最新'
        : f.replace('goldrush-reflect-', '').replace('.md', '');
    }
    const advice = adviceFromMeta(meta)
      || resolveAdvice(scoreInfo, qualityGate, dualScore, positionRec);
    return {
      filename: f,
      kind,
      dateLabel,
      mtime: stats.mtime,
      sizeKB: (stats.size / 1024).toFixed(1),
      score: scoreInfo?.score ?? null,
      direction: scoreInfo?.direction ?? null,
      dims,
      quantInfo,
      mdLength: md.length,
      glance: extractQuickGlance(md),
      breakdown: extractScoreBreakdown(md),
      macro: extractMacroRegime(md),
      judge: extractJudgeVerdict(md),
      similar: extractSimilarDays(md),
      similarSummary: summarizeSimilarDays(extractSimilarDays(md)),
      calibration: extractCalibration(md),
      confidence: extractDataConfidence(md),
      qualityGate,
      dualScore,
      positionRec,
      scenarios: extractScenarios(md),
      strategies: extractStrategies(md),
      advice,
      dayDelta: extractDayDelta(md),
      readingChecklist: extractReadingChecklist(md),
      transmission: extractTransmission(md),
      meta,
    };
  });
}

function kindIsAnalysis(filename) {
  return classifyDoc(filename) === 'analysis';
}

// ===== 评分徽章 =====

function scoreBadge(score) {
  if (score == null) return '';
  let color, label;
  if (score >= 75) { color = '#1a7f37'; label = '偏多'; }
  else if (score >= 55) { color = '#9a6700'; label = '中性'; }
  else { color = '#c62828'; label = '偏空'; }
  return `<span class="s-badge" style="background:${color}18;color:${color};border-color:${color}33">${score}<span class="s-label">${label}</span></span>`;
}

/** 从文件名提取日期字符串（YYYY-MM-DD），无法提取则返回空串（排在末尾） */
function extractFileDate(filename) {
  const m = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

// ===== 文件列表页（含搜索过滤排序） =====

function renderIndex(fileInfos) {
  const analysesRaw = fileInfos.filter(i => i.kind === 'analysis');
  const predictionStats = loadPredictionStats();
  const analyses = attachPredictionOutcomes(attachNeighborDeltas(analysesRaw), predictionStats);
  const digests = fileInfos.filter(i => i.kind === 'digest');
  const reflects = fileInfos.filter(i => i.kind === 'reflect');
  const others = fileInfos.filter(i => i.kind !== 'analysis' && i.kind !== 'digest' && i.kind !== 'reflect');

  const latest = analyses[0] ?? null;
  const rest = analyses.slice(1);

  const dualLine = (info) => renderListDualHtml(listDualScores(info), esc);
  const quantBadge = (info) => renderQuantBadgeHtml(listDualScores(info), esc);
  const deltaLine = (info) => renderListDeltaHtml(info.listDelta || info.dayDelta, esc);
  const outcomeLine = (info) => renderListOutcomeHtml(info.outcome, esc);
  const posChip = (info) => renderListPosHtml(info.positionRec, esc);

  const heroHtml = latest ? `<a href="/${latest.filename}" class="hero-card dir-${latest.direction || 'neutral'} ${latest.qualityGate && !latest.qualityGate.actionable ? 'hero-blocked' : ''} ${(latest.listDelta || latest.dayDelta)?.skipFineRead ? 'hero-skip' : ''}">
    <div class="hero-badge">最新研判 ${qualityDot(latest.qualityGate)}</div>
    <div class="hero-left">${scoreBadge(latest.score)}${quantBadge(latest)}</div>
    <div class="hero-body">
      <div class="hero-date">${esc(latest.dateLabel)} ${latest.qualityGate ? `<span class="hero-dq">${latest.qualityGate.emoji} ${latest.qualityGate.label}${latest.confidence != null ? ' · ' + latest.confidence + '%' : ''}</span>` : ''} ${posChip(latest)}</div>
      ${dualLine(latest)}
      ${deltaLine(latest)}
      ${outcomeLine(latest)}
      ${latest.advice ? `<div class="hero-verdict">${latest.advice.emoji} ${esc(latest.advice.headline)}</div>` : '<div class="hero-title">黄金投资日报</div>'}
      ${latest.advice ? `<div class="hero-action">💡 ${esc(latest.advice.action)}</div>` : ''}
      ${latest.scenarios ? `<div class="hero-scenarios">${latest.scenarios.map(s => `<span class="sc-mini sc-${s.cls}">${s.icon}${s.probability}%</span>`).join('')}</div>` : ''}
      ${latest.calibration && (latest.calibration.sample == null || latest.calibration.sample < CALIBRATION_SAMPLE_WARN)
        ? `<div class="hero-sample-warn">⚠️ 校准样本不足${latest.calibration.sample != null ? `（${latest.calibration.sample}）` : ''}</div>` : ''}
      <div class="hero-dims">${latest.dims.map(d => `<span class="dim-tag">${d.name.slice(0, 2)} ${d.score}</span>`).join('')}</div>
    </div>
    <div class="hero-arrow">→</div>
  </a>` : '';

  const cardRows = rest.map(info => {
    const mtimeStr = info.mtime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const verdictHtml = info.qualityGate && !info.qualityGate.actionable
      ? `<div class="rc-verdict"><span class="verdict-chip" style="color:#6b7280;background:rgba(0,0,0,0.04);border-color:rgba(0,0,0,0.1)">🔴 数据不可用 · 勿据此加减仓</span></div>`
      : (info.advice ? `<div class="rc-verdict">${renderCardVerdict(info.score, info.direction)}</div>` : `<div class="rc-snippet muted">${esc(info.filename)}</div>`);
    const search = buildCardSearchBlob(info);
    return `<a href="/${info.filename}" class="report-card dir-${info.direction || 'neutral'}" data-search="${esc(search)}" data-score="${info.score ?? ''}" data-quant="${listDualScores(info)?.quant ?? ''}">
      <div class="rc-score"><span class="rc-score-top">${scoreBadge(info.score)}${qualityDot(info.qualityGate)}</span>${quantBadge(info)}</div>
      <div class="rc-body">
        <div class="rc-date">${info.dateLabel} ${info.confidence != null ? `<span class="rc-conf">置信 ${info.confidence}%</span>` : ''} ${posChip(info)}</div>
        ${dualLine(info)}
        ${deltaLine(info)}
        ${outcomeLine(info)}
        ${verdictHtml}
        <div class="rc-meta">${mtimeStr}</div>
      </div>
    </a>`;
  }).join('\n');

  const digestRows = digests.map(info => {
    const mtimeStr = info.mtime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<a href="/${info.filename}" class="report-card kind-digest" data-search="${esc(info.filename + ' ' + info.dateLabel + ' digest 摘要')}">
      <div class="rc-kind">摘要</div>
      <div class="rc-body">
        <div class="rc-date">${esc(info.dateLabel)}</div>
        <div class="rc-snippet">周期摘要 · 均分与跳变一览</div>
        <div class="rc-meta">${mtimeStr}</div>
      </div>
    </a>`;
  }).join('\n');

  const reflectRows = reflects.map(info => {
    const mtimeStr = info.mtime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<a href="/${info.filename}" class="report-card kind-reflect" data-search="${esc(info.filename + ' ' + info.dateLabel + ' reflect 反思 错因')}">
      <div class="rc-kind">反思</div>
      <div class="rc-body">
        <div class="rc-date">${esc(info.dateLabel)}</div>
        <div class="rc-snippet">预测错因归纳 · 下周阅读清单</div>
        <div class="rc-meta">${mtimeStr}</div>
      </div>
    </a>`;
  }).join('\n');

  const otherRows = others.map(info => {
    return `<a href="/${info.filename}" class="report-card kind-other" data-search="${esc(info.filename)}">
      <div class="rc-kind">其它</div>
      <div class="rc-body">
        <div class="rc-date">${esc(info.dateLabel)}</div>
        <div class="rc-snippet muted">${esc(info.filename)}</div>
      </div>
    </a>`;
  }).join('\n');

  // 统计（仅日度分析）
  const total = analyses.length;
  const bullish = analyses.filter(i => i.direction === 'bullish').length;
  const bearish = analyses.filter(i => i.direction === 'bearish').length;
  const neutral = analyses.filter(i => i.direction === 'neutral' || (i.direction === null && i.score != null)).length;
  const avgScore = total > 0 ? Math.round(analyses.reduce((s, i) => s + (i.score ?? 50), 0) / total) : '—';

  // 最新报告仓位 + 全局预测对错 JSON
  let latestPos = null;
  if (latest) {
    try {
      const latestMd = fs.readFileSync(path.join(DOCS_DIR, latest.filename), 'utf-8');
      latestPos = enrichPositionHeadline(extractPositionRecommend(latestMd), latest.dualScore);
    } catch { /* ignore */ }
    // 旧日报无仓位小节时：用分数粗推（与 position-recommend 同档）
    if (!latestPos && latest.score != null) {
      const s = latest.score;
      let target = s <= 25 ? 25 : s <= 35 ? 35 : s <= 45 ? 45 : s <= 55 ? 55 : s <= 65 ? 65 : s <= 75 ? 75 : 85;
      if (latest.qualityGate && !latest.qualityGate.actionable) target = Math.min(target, 35);
      const label = target <= 30 ? '极轻' : target <= 45 ? '偏轻' : target <= 60 ? '标配' : target <= 75 ? '偏积极' : '积极';
      const emoji = label === '极轻' ? '🔴' : label === '偏轻' ? '🟠' : label === '标配' ? '🟡' : label === '偏积极' ? '🟢' : '🔵';
      latestPos = {
        targetPct: target,
        label,
        emoji,
        coreSharePct: target <= 40 ? 85 : 70,
        satelliteSharePct: target <= 40 ? 15 : 30,
        headline: '（旧报告推算）相对计划仓建议',
        action: `建议相对计划仓约 ${target}%（${label}）；完整规则请重新 analysis --md`,
        tilt: target <= 40 ? 'reduce' : target >= 70 ? 'add' : 'hold',
      };
    }
  }
  let latestRel = null;
  if (latest) {
    try {
      const latestMd = fs.readFileSync(path.join(DOCS_DIR, latest.filename), 'utf-8');
      latestRel = extractReliabilityCard(latestMd, {
        score: latest.score,
        qualityGate: latest.qualityGate,
        dualScore: latest.dualScore,
        calibration: latest.calibration,
        positionLine: latestPos ? `建议仓位 ${latestPos.targetPct}%（${latestPos.label}）` : null,
      });
    } catch { /* ignore */ }
  }
  const homePanels = `${renderReadingChecklistPanel(latest?.readingChecklist)}${renderDayDeltaPanel(latest?.listDelta || latest?.dayDelta)}${renderTransmissionPanel(latest?.transmission)}${renderReliabilityPanel(latestRel)}${renderPositionPanel(latestPos)}${renderPredictionStatsPanel(predictionStats)}`;

  // 首页也先给三期决策条：不点进文章就知道短/中/长分别怎么说
  let latestHorizonHtml = '';
  if (latest?.filename) {
    try {
      const latestMd = fs.readFileSync(path.join(DOCS_DIR, latest.filename), 'utf-8');
      latestHorizonHtml = renderHorizonStrip(latestMd, latest.meta || loadReportMeta(path.join(DOCS_DIR, latest.filename)));
    } catch { /* 读不到就不显示，不影响首页其余内容 */ }
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GoldRush 分析报告</title>
  <style>${homeCss}</style>
</head>
<body>
  <div class="container">
    <header class="home-hero">
      <div class="brand-mark" aria-hidden="true">🥇</div>
      <h1>GoldRush</h1>
      <p class="subtitle">一眼看懂 · 分数 · 概率 · 定投建议</p>
    </header>

    <div class="stats">
      <div class="stat-card"><div class="num gold">${total}</div><div class="label">报告</div></div>
      ${total > 0 ? `
      <div class="stat-card"><div class="num green">${bullish}</div><div class="label">偏多</div></div>
      <div class="stat-card"><div class="num yellow">${neutral}</div><div class="label">中性</div></div>
      <div class="stat-card"><div class="num red">${bearish}</div><div class="label">偏空</div></div>
      <div class="stat-card"><div class="num gold">${avgScore}</div><div class="label">均分</div></div>
      ${predictionStats?.llm?.hitRate != null ? `<div class="stat-card"><div class="num green">${predictionStats.llm.hitRate}%</div><div class="label">LLM命中</div></div>` : ''}
      ${predictionStats?.quant?.hitRate != null ? `<div class="stat-card"><div class="num gold">${predictionStats.quant.hitRate}%</div><div class="label">量化命中</div></div>` : ''}
      ${latestPos ? `<div class="stat-card"><div class="num yellow">${latestPos.targetPct}%</div><div class="label">建议仓位</div></div>` : ''}
      ` : ''}
    </div>

    ${total > 0 ? `
    <div class="toolbar">
      <input type="text" class="search-box" id="search" placeholder="搜索日期、评分、操作…" oninput="filterCards()">
      <button class="sort-btn active" id="sort-date" onclick="setSort('date')">日期</button>
      <button class="sort-btn" id="sort-score" onclick="setSort('score')">评分</button>
    </div>
    ${latestHorizonHtml}
    ${heroHtml}
    ${homePanels ? `<div class="home-panels mac-window glass-strong">${macTitlebar('今日一览')}${homePanels}</div>` : ''}
    ${rest.length ? `<div class="section-label">历史日报</div><div class="card-grid" id="card-grid">${cardRows}</div>` : ''}
    ${digests.length ? `<div class="section-label" style="margin-top:28px">周期摘要</div><div class="card-grid" id="digest-grid">${digestRows}</div>` : ''}
    ${reflects.length ? `<div class="section-label" style="margin-top:28px">错因反思</div><div class="card-grid" id="reflect-grid">${reflectRows}</div>` : ''}
    ${others.length ? `<div class="section-label" style="margin-top:28px">其它文档</div><div class="card-grid">${otherRows}</div>` : ''}
    ` : `<div class="empty">
      <div class="icon">📭</div>
      <p>暂无分析报告<br>运行 <code>node dist/index.js analysis --md</code> 生成第一份</p>
    </div>`}

    <footer>
      <p>报告由 <a href="/">GoldRush</a> 自动生成 · 仅供研究参考，不构成投资建议</p>
      <p style="margin-top:8px"><a href="/#digest-grid">📰 周期摘要</a>${digests[0] ? ` · <a href="/${digests[0].filename}">打开最新摘要</a>` : ''}${reflects[0] ? ` · <a href="/#reflect-grid">🪞 错因反思</a> · <a href="/${reflects[0].filename}">最新反思</a>` : ''}</p>
    </footer>
  </div>

  <script>
    function filterCards() {
      const q = document.getElementById('search').value.toLowerCase();
      document.querySelectorAll('.report-card').forEach(card => {
        const text = (card.getAttribute('data-search') || card.textContent || '').toLowerCase();
        card.classList.toggle('hidden', q && !text.includes(q));
      });
    }

    let sortMode = 'date';
    function setSort(mode) {
      sortMode = mode;
      document.getElementById('sort-date').classList.toggle('active', mode === 'date');
      document.getElementById('sort-score').classList.toggle('active', mode === 'score');
      doSort();
    }

    function doSort() {
      const grid = document.getElementById('card-grid');
      if (!grid) return;
      const cards = Array.from(grid.querySelectorAll('.report-card'));
      cards.sort((a, b) => {
        if (sortMode === 'date') {
          const da = a.querySelector('.rc-date')?.textContent || '';
          const db = b.querySelector('.rc-date')?.textContent || '';
          return db.localeCompare(da);
        }
        const sa = parseInt(a.querySelector('.s-badge')?.textContent) || 0;
        const sb = parseInt(b.querySelector('.s-badge')?.textContent) || 0;
        return sb - sa;
      });
      for (const c of cards) grid.appendChild(c);
    }
  </script>
</body>
</html>`;
}

// ===== Markdown 文章页模板（加入评分卡片） =====

function renderArticle(mdFilename, rawMarkdown) {
  const kind = classifyDoc(mdFilename);
  const dateLabel = kind === 'analysis'
    ? mdFilename.replace('goldrush-analysis-', '').replace('.md', '')
    : mdFilename.replace(/\.md$/, '');
  const meta = kind === 'analysis'
    ? loadReportMeta(path.join(DOCS_DIR, mdFilename))
    : null;
  const scoreInfo = scoreInfoFromMeta(meta) || extractScore(rawMarkdown);
  const dims = extractDimensionScores(rawMarkdown);
  const breakdown = extractScoreBreakdown(rawMarkdown);
  const macro = extractMacroRegime(rawMarkdown);
  const judge = extractJudgeVerdict(rawMarkdown);
  const similar = extractSimilarDays(rawMarkdown);
  const similarSummary = summarizeSimilarDays(similar);
  const calibration = extractCalibration(rawMarkdown);
  const confidence = extractDataConfidence(rawMarkdown);
  const qualityGate = gateFromMeta(meta) || extractDataQualityGate(rawMarkdown);
  const dualScore = dualFromMeta(meta) || extractDualScore(rawMarkdown);
  const scenarios = extractScenarios(rawMarkdown);
  const strategies = extractStrategies(rawMarkdown);
  const quantInfo = quantInfoFromMeta(meta) || extractQuantScore(rawMarkdown);
  const positionRec = enrichPositionHeadline(
    positionFromMeta(meta) || extractPositionRecommend(rawMarkdown),
    dualScore,
  );
  const predictionStats = loadPredictionStats();
  const dayDelta = extractDayDelta(rawMarkdown);
  const readingChecklist = extractReadingChecklist(rawMarkdown);
  const transmission = extractTransmission(rawMarkdown);
  const reliability = extractReliabilityCard(rawMarkdown, {
    score: scoreInfo?.score,
    qualityGate,
    dualScore,
    calibration,
    positionLine: positionRec ? `建议仓位 ${positionRec.targetPct}%（${positionRec.label}）` : null,
  });
  const advice = adviceFromMeta(meta)
    || resolveAdvice(scoreInfo, qualityGate, dualScore, positionRec);

  // 三期决策条置于文章最顶部：短/中/长一屏看完再决定要不要细读
  const horizonStripHtml = kind === 'analysis' ? renderHorizonStrip(rawMarkdown, meta) : '';

  // Quick-read card only for analysis
  const quickReadHtml = kind === 'analysis' ? renderQuickRead({
    scoreInfo, advice, dims, calibration, quantInfo, qualityGate,
  }) : '';

  // Flow reports get specialized dashboard
  const flowDashboardHtml = kind === 'flow' ? renderFlowDashboard(rawMarkdown) : '';

  const dashboardHtml = kind === 'analysis' ? renderPredictionDashboard({
    scoreInfo, advice, confidence, calibration, scenarios, strategies, similarSummary, macro, quantInfo, qualityGate, dualScore,
    positionRec, predictionStats, reliability, dayDelta, readingChecklist, transmission,
  }) : '';

  const displayMd = kind === 'analysis' ? stripDashboardDuplicates(rawMarkdown) : rawMarkdown;

  const dimRows = dims.map(d => {
    const pct = d.score;
    let c = '#22c55e';
    if (pct < 55) c = '#ef4444';
    else if (pct < 75) c = '#f59e0b';
    return `<div class="dim-bar-row"><span class="dim-name">${d.name}</span><div class="dim-bar-bg"><div class="dim-bar-fill" style="width:${pct}%;background:${c}"></div></div><span class="dim-val">${d.score}</span></div>`;
  }).join('');

  const tocItems = [];
  for (const m of displayMd.matchAll(/^## (.+)$/gm)) {
    const title = m[1].trim();
    if (title.startsWith('📊 评分构成') || title === '综合研判') continue;
    const id = 'sec-' + tocItems.length;
    tocItems.push({ title, id });
  }
  const tocHtml = tocItems.length > 1 ? `<nav class="sidebar-block toc">
    <div class="sb-title">目录</div>
    ${tocItems.map(t => `<a href="#${t.id}" class="toc-link" data-sec="${t.id}">${esc(t.title)}</a>`).join('')}
  </nav>` : '';

  // 侧栏：默认只留目录 + 四维条；其余全部折叠
  const sidebarScoreMeter = scoreInfo ? `
    <div class="sidebar-score-meter">
      <div class="ssm-label">综合 ${scoreInfo.score}</div>
      <div class="ssm-bar"><div class="ssm-fill" style="width:${scoreInfo.score}%;background:${scoreInfo.score >= 75 ? '#22c55e' : scoreInfo.score >= 55 ? '#f59e0b' : '#ef4444'}"></div></div>
      <div class="ssm-dir">${scoreInfo.direction === 'bullish' ? '📈 偏多' : scoreInfo.direction === 'bearish' ? '📉 偏空' : '➡️ 中性'}</div>
    </div>` : '';

  const sidebarExtras = [];
  if (macro) {
    sidebarExtras.push(`<div class="sidebar-block macro-chip"><div class="sb-title">宏观阶段</div><div class="macro-label">${esc(macro.label)}</div><div class="macro-desc">${esc(macro.description)}</div></div>`);
  }
  if (breakdown) {
    sidebarExtras.push(`<div class="sidebar-block"><div class="sb-title">评分构成</div><div class="waterfall">${renderScoreWaterfall(breakdown)}</div></div>`);
  }
  if (judge) {
    sidebarExtras.push(`<div class="sidebar-block judge-box"><div class="sb-title">裁决摘要</div><p class="judge-text">${esc(judge.slice(0, 200))}${judge.length > 200 ? '…' : ''}</p></div>`);
  }
  if (similar && similar.length) {
    sidebarExtras.push(`<div class="sidebar-block"><div class="sb-title">历史佐证</div><div class="sim-summary">${similarSummary ? `相似日 ${similarSummary.upRate}% 上涨 · 均 ${similarSummary.avgReturn >= 0 ? '+' : ''}${similarSummary.avgReturn}%` : ''}</div>${similar.map(s => `<div class="sim-row"><span>${esc(s.date)}</span><span>${esc(s.similarity)}</span><span class="${parseFloat(s.ret) >= 0 ? 'up' : 'down'}">${esc(s.ret)}</span></div>`).join('')}</div>`);
  }

  const sidebarHtml = `
      ${sidebarScoreMeter}
      ${dims.length ? `<div class="sidebar-block"><div class="sb-title">四维度</div>${dimRows}</div>` : ''}
      ${tocHtml}
      ${sidebarExtras.length ? `<details class="sidebar-more"><summary>更多侧栏</summary>${sidebarExtras.join('')}</details>` : ''}
  `;

  // 服务端渲染 Markdown → 折叠分节 → 净化
  let contentHtml = marked.parse(displayMd, { breaks: true, gfm: true });
  if (kind === 'analysis' && tocItems.length) {
    contentHtml = processArticleContent(contentHtml, tocItems);
  }
  contentHtml = sanitizeMarkdownHtml(contentHtml);

  const pageTitle = kind === 'flow' ? `${esc(dateLabel)} — 主力流向`
    : kind === 'digest' ? `${esc(dateLabel)} — 周期摘要`
    : kind === 'reflect' ? `${esc(dateLabel)} — 错因反思`
    : `${esc(dateLabel)} — GoldRush 分析报告`;
  const headerTitle = kind === 'flow' ? '主力流向'
    : kind === 'digest' ? '周期摘要'
    : kind === 'reflect' ? '错因反思'
    : '详细分析';
  const headerMeta = kind === 'flow'
    ? `${esc(dateLabel)} · CFTC · ETF · 央行`
    : kind === 'digest'
    ? `${esc(dateLabel)} · 均分与跳变一览`
    : kind === 'reflect'
    ? `${esc(dateLabel)} · 打脸分桶与下周清单`
    : `${esc(dateLabel)} · 策略默认展开，长文可折叠`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageTitle}</title>
  <style>${articleCss}</style>
</head>
<body>
  <nav class="topbar">
    <div class="topbar-left">
      <span class="logo-dot" aria-hidden="true"></span>
      <a href="/"><span class="logo">GoldRush</span></a>
      <span class="sep">/</span>
      <span class="report-date">${esc(dateLabel)}${kind === 'flow' ? ' 主力流向' : kind === 'digest' ? ' 周期摘要' : kind === 'reflect' ? ' 错因反思' : ' 分析报告'}</span>
    </div>
    <a class="topbar-back" href="/">← 返回列表</a>
  </nav>

  <div class="article-layout">
    <aside class="sidebar">
      ${sidebarHtml}
    </aside>
    <div class="article-main">
      ${flowDashboardHtml}
      ${horizonStripHtml}
      ${quickReadHtml}
      ${dashboardHtml}
      <div class="article-shell mac-window">
      ${macTitlebar(headerTitle)}
      <div class="article-header">
        <h1>${headerTitle}</h1>
        <div class="meta">${headerMeta}</div>
      </div>
      ${kind === 'analysis' && tocItems.length ? `<div class="collapse-toolbar">
        <button type="button" class="collapse-btn" id="btn-expand-all">全部展开</button>
        <button type="button" class="collapse-btn" id="btn-collapse-all">全部收起</button>
        <button type="button" class="collapse-btn" id="btn-reset-collapse">恢复默认</button>
      </div>` : ''}
      <div id="content">${contentHtml}</div>
      <div class="footer-meta">
        报告由 GoldRush 自动生成 · 仅供研究参考，不构成投资建议
      </div>
      </div>
    </div>
  </div>

  <script>
    (function () {
      const KEY = 'goldrush-collapse-pref';
      const sections = () => Array.from(document.querySelectorAll('#content details.md-section'));

      function setAll(open) {
        for (const d of sections()) d.open = open;
        try { localStorage.setItem(KEY, open ? 'all-open' : 'all-closed'); } catch (_) {}
      }

      function resetDefault() {
        for (const d of sections()) {
          const kind = d.getAttribute('data-sec-kind') || '';
          d.open = ['short-strategy', 'mid-strategy', 'scenarios'].includes(kind);
        }
        try { localStorage.removeItem(KEY); } catch (_) {}
      }

      function applyPref() {
        let pref = null;
        try { pref = localStorage.getItem(KEY); } catch (_) {}
        if (pref === 'all-open') setAll(true);
        else if (pref === 'all-closed') setAll(false);
      }

      document.getElementById('btn-expand-all')?.addEventListener('click', () => setAll(true));
      document.getElementById('btn-collapse-all')?.addEventListener('click', () => setAll(false));
      document.getElementById('btn-reset-collapse')?.addEventListener('click', resetDefault);

      // TOC：打开对应章节并滚动
      document.querySelectorAll('.toc-link').forEach(a => {
        a.addEventListener('click', (e) => {
          const id = a.getAttribute('data-sec') || (a.getAttribute('href') || '').slice(1);
          const el = id ? document.getElementById(id) : null;
          if (!el) return;
          e.preventDefault();
          if (el.tagName === 'DETAILS') el.open = true;
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          document.querySelectorAll('.toc-link').forEach(x => x.classList.remove('active'));
          a.classList.add('active');
          history.replaceState(null, '', '#' + id);
        });
      });

      // 深链进入时展开目标节
      if (location.hash) {
        const el = document.getElementById(location.hash.slice(1));
        if (el && el.tagName === 'DETAILS') el.open = true;
      }

      applyPref();
    })();
  </script>
</body>
</html>`;
}

// ===== HTTP 服务 =====

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const relPath = url.pathname === '/' ? '' : decodeURIComponent(url.pathname);
  const filePath = path.resolve(DOCS_DIR, relPath.replace(/^\//, ''));

  // 安全校验：禁止路径穿越
  if (filePath !== DOCS_DIR && !filePath.startsWith(DOCS_ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  // 目录请求 → 文件列表
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readdir(DOCS_DIR, (err, allFiles) => {
      if (err) {
        res.writeHead(500);
        return res.end('Server error');
      }
      const mdFiles = allFiles
        .filter(f => f.endsWith('.md'))
        .sort((a, b) => {
          const da = extractFileDate(a);
          const db = extractFileDate(b);
          // 最新在前，无日期的排最后
          if (da && !db) return -1;
          if (!da && db) return 1;
          if (da && db && da !== db) return db.localeCompare(da);
          return b.localeCompare(a);
        });
      const fileInfos = getFileInfos(mdFiles);
      const html = renderIndex(fileInfos);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    return;
  }

  // .md 文件 → 渲染为文章页
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md') {
    fs.readFile(filePath, 'utf-8', (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not Found');
      }
      const filename = path.basename(filePath);
      const html = renderArticle(filename, data);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    return;
  }

  // 其他静态文件
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`🥇 GoldRush Docs Server running on http://${HOST}:${PORT}`);
});
