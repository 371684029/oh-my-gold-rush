/**
 * 首页历史日报列表：双打分条 + 较上日差分（含旧报告相邻推算）+ 预测对错
 * 纯函数，供 server.cjs 与单测共用。
 */

'use strict';

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function fmtSigned(n, digits = 0) {
  if (n == null || !Number.isFinite(n)) return null;
  const v = digits > 0 ? Number(n.toFixed(digits)) : Math.round(n);
  if (v > 0) return `+${v}`;
  if (v === 0) return '±0';
  return String(v);
}

function predLabel(pred) {
  if (pred === 'up') return '涨';
  if (pred === 'down') return '跌';
  return '中性';
}

/**
 * 从单日 fileInfo 取出列表用双分数
 */
function listDualScores(info) {
  if (!info) return null;
  const llm = numOrNull(info.dualScore?.llm) ?? numOrNull(info.score);
  const quant = numOrNull(info.dualScore?.quant)
    ?? numOrNull(info.quantInfo?.quantScore);
  if (llm == null && quant == null) return null;
  const delta = llm != null && quant != null ? llm - quant : null;
  const conflict = !!(info.dualScore?.conflict
    || (delta != null && Math.abs(delta) > 15));
  return { llm, quant, delta, conflict };
}

/**
 * 用相邻两份日报（curr 较新、prev 较旧）推算列表差分
 */
function synthesizeNeighborDelta(curr, prev) {
  if (!curr || !prev) return null;
  const currScore = numOrNull(curr.score) ?? numOrNull(curr.dualScore?.llm);
  const prevScore = numOrNull(prev.score) ?? numOrNull(prev.dualScore?.llm);
  const currQuant = numOrNull(curr.quantInfo?.quantScore) ?? numOrNull(curr.dualScore?.quant);
  const prevQuant = numOrNull(prev.quantInfo?.quantScore) ?? numOrNull(prev.dualScore?.quant);
  const currPos = numOrNull(curr.positionRec?.targetPct);
  const prevPos = numOrNull(prev.positionRec?.targetPct);

  const scoreDelta = currScore != null && prevScore != null ? currScore - prevScore : null;
  const quantDelta = currQuant != null && prevQuant != null ? currQuant - prevQuant : null;
  const positionDelta = currPos != null && prevPos != null ? currPos - prevPos : null;

  const scoreMoved = scoreDelta != null && Math.abs(scoreDelta) >= 3;
  const quantMoved = quantDelta != null && Math.abs(quantDelta) >= 3;
  const posMoved = positionDelta != null && Math.abs(positionDelta) >= 5;
  const skipFineRead = !scoreMoved && !quantMoved && !posMoved;

  const prevLabel = prev.dateLabel || '上日';
  let headline;
  if (skipFineRead) {
    headline = `与${prevLabel}基本持平`;
  } else {
    const bits = [];
    if (scoreDelta != null) bits.push(`分${fmtSigned(scoreDelta)}`);
    if (quantDelta != null) bits.push(`量化${fmtSigned(quantDelta)}`);
    if (positionDelta != null) bits.push(`仓${fmtSigned(positionDelta)}点`);
    headline = `较${prevLabel}：${bits.join(' · ')}`;
  }

  return {
    headline,
    skipFineRead,
    scoreDelta,
    quantDelta,
    positionDelta,
    prevScore,
    currScore,
    prevQuant,
    currQuant,
    prevPositionPct: prevPos,
    currPositionPct: currPos,
    driverSummary: '',
    trackHint: '',
    source: 'neighbor',
  };
}

/**
 * 为按日期新→旧排列的 analyses 挂上 listDelta：
 * 优先 MD 较昨日；否则用相邻日报推算（旧报告也能看出趋势）
 */
function attachNeighborDeltas(analyses) {
  if (!Array.isArray(analyses) || !analyses.length) return analyses || [];
  return analyses.map((curr, i) => {
    const prev = analyses[i + 1] || null;
    const fromMd = curr.dayDelta || null;
    const synth = synthesizeNeighborDelta(curr, prev);
    let listDelta = null;
    if (fromMd && (fromMd.scoreDelta != null || fromMd.positionDelta != null || fromMd.headline)) {
      listDelta = { ...fromMd, source: fromMd.source || 'md' };
    } else if (synth) {
      listDelta = synth;
    }
    return { ...curr, listDelta };
  });
}

/** stats.recent → 按日期索引 */
function indexOutcomesByDate(stats) {
  const map = Object.create(null);
  for (const r of (stats && stats.recent) || []) {
    if (r && r.date) map[r.date] = r;
  }
  return map;
}

/**
 * 把 goldrush-stats 的按日对错挂到列表项（dateLabel = YYYY-MM-DD）
 */
function attachPredictionOutcomes(analyses, stats) {
  if (!Array.isArray(analyses) || !analyses.length) return analyses || [];
  const byDate = indexOutcomesByDate(stats);
  return analyses.map(a => ({
    ...a,
    outcome: byDate[a.dateLabel] || null,
  }));
}

/**
 * 可读对错摘要（学会怎么看报告用）
 * 兼容旧版 stats JSON（无 alignPct / vsBucketPct 时现场补算）
 */
function enrichOutcome(o) {
  if (!o) return null;
  let alignPct = numOrNull(o.alignPct);
  const actual = numOrNull(o.actual5dPct);
  if (alignPct == null && actual != null) {
    if (o.pred === 'up') alignPct = actual;
    else if (o.pred === 'down') alignPct = -actual;
  }
  return { ...o, alignPct };
}

function describeOutcome(raw) {
  const o = enrichOutcome(raw);
  if (!o) return null;
  const predZh = predLabel(o.pred);
  if (o.status === 'pending') {
    return {
      tone: 'pending',
      mark: '⏳',
      short: '5日结果待回填',
      detail: `当日预测${predZh}；约 5 个交易日后才能对账（>55记涨、<45记跌）`,
    };
  }
  const ret = o.actual5dPct;
  const retStr = ret == null ? '—' : `${ret > 0 ? '+' : ''}${ret}%`;
  let alignStr = '';
  if (o.alignPct != null) {
    alignStr = o.alignPct >= 0
      ? `顺预测 +${o.alignPct}%`
      : `逆预测 ${Math.abs(o.alignPct)}%`;
  }
  let vsStr = '';
  if (o.vsBucketPct != null && o.bucketAvgReturn != null) {
    const avg = `${o.bucketAvgReturn > 0 ? '+' : ''}${o.bucketAvgReturn}%`;
    vsStr = `相对同档 ${o.vsBucketPct > 0 ? '+' : ''}${o.vsBucketPct}%（同档均 ${avg}）`;
  }

  let tone = 'flat';
  let mark = '➖';
  let short = `中性/持平不计 · 5日 ${retStr}`;
  if (o.status === 'hit') {
    tone = 'hit';
    mark = '✅';
    short = `方向命中 · 预测${predZh}→5日 ${retStr}`;
  } else if (o.status === 'miss') {
    tone = 'miss';
    mark = '❌';
    short = `方向打脸 · 预测${predZh}→5日 ${retStr}`;
  }

  const bits = [short];
  if (alignStr) bits.push(alignStr);
  if (vsStr) bits.push(vsStr);
  if (o.quantStatus === 'hit') bits.push('量化亦中');
  else if (o.quantStatus === 'miss') bits.push('量化打脸');

  return {
    tone,
    mark,
    short,
    detail: bits.join(' · '),
  };
}

/**
 * 分数 → 方向色档（与 scoreBadge 同口径：≥75 偏多 / ≥55 中性 / 其余偏空）
 */
function scoreTone(score) {
  if (score == null) return null;
  if (score >= 75) return 'bullish';
  if (score >= 55) return 'neutral';
  return 'bearish';
}

/**
 * 列表双打分行 HTML：Δ 摘要（数字由左列 LLM/量化徽章承载，不重复）
 * 口径：|Δ|≤8 一致；8<|Δ|≤15 轻度分歧；>15 或 conflict → 分歧·操作弃权
 */
function renderListDualHtml(dual, escFn) {
  const esc = typeof escFn === 'function' ? escFn : (s) => String(s);
  if (!dual || dual.delta == null) return '';
  const dStr = fmtSigned(dual.delta);
  const tone = dual.conflict ? 'conflict' : Math.abs(dual.delta) > 8 ? 'mild' : 'ok';
  const word = dual.conflict
    ? '分歧·操作弃权'
    : tone === 'mild' ? '轻度分歧' : '一致';
  const icon = dual.conflict ? '⛔' : '⚖️';
  const conflictMark = dual.conflict ? '<span class="rc-dual-flag">弃权</span>' : '';
  return `<div class="rc-dual" title="双打分并排；|Δ|>15 或方向相反 → 操作弃权、维持定投，不抬单侧权重">${icon} <span class="rc-dual-d rc-dual-${tone}">Δ${esc(dStr)}</span> <span class="rc-dual-word">${esc(word)}</span>${conflictMark}</div>`;
}

/**
 * 左列量化小徽章：与 LLM 徽章同色档口径，纵向并排直观对比
 */
function renderQuantBadgeHtml(dual, escFn) {
  const esc = typeof escFn === 'function' ? escFn : (s) => String(s);
  if (!dual || dual.quant == null) return '';
  const tone = scoreTone(dual.quant);
  return `<span class="rc-quant-badge rc-qb-${tone}" title="量化分（纯本地因子，零 LLM）"><span class="rc-qb-label">量化</span> ${esc(String(dual.quant))}</span>`;
}

/**
 * 列表较上日差分 HTML
 */
function renderListDeltaHtml(dd, escFn) {
  const esc = typeof escFn === 'function' ? escFn : (s) => String(s);
  if (!dd) return '';
  const chips = [];
  const push = (label, delta, unit = '') => {
    if (delta == null) return;
    const sign = fmtSigned(delta);
    const tone = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
    chips.push(`<span class="rc-dchip rc-d-${tone}">${label}${esc(sign)}${unit}</span>`);
  };
  push('分', dd.scoreDelta);
  push('量化', dd.quantDelta);
  push('仓', dd.positionDelta, '点');
  const skip = dd.skipFineRead ? ' skip' : '';
  const src = dd.source === 'neighbor' ? '<span class="rc-delta-src" title="由相邻日报推算">推算</span>' : '';
  const head = esc(dd.headline || (dd.skipFineRead ? '与上日持平' : '较上日有变化'));
  return `<div class="rc-delta${skip}">📅 ${head}${src}${chips.length ? `<span class="rc-dchips">${chips.join('')}</span>` : ''}</div>`;
}

/**
 * 列表预测对错 HTML（教用户怎么读报告）
 */
function renderListOutcomeHtml(outcome, escFn) {
  const esc = typeof escFn === 'function' ? escFn : (s) => String(s);
  const d = describeOutcome(outcome);
  if (!d) return '';
  const title = esc(
    '5日后金价涨跌对账：>55 预测涨、<45 预测跌；顺预测=朝预测方向走的幅度；相对同档=本日涨跌减同评分区间历史均值',
  );
  return `<div class="rc-outcome rc-out-${d.tone}" title="${title}">
    <span class="rc-out-mark">${d.mark}</span>
    <span class="rc-out-text">${esc(d.detail)}</span>
  </div>`;
}

/**
 * 仓位小标签
 */
function renderListPosHtml(pos, escFn) {
  const esc = typeof escFn === 'function' ? escFn : (s) => String(s);
  if (!pos || pos.targetPct == null) return '';
  return `<span class="rc-pos">仓 ${esc(String(pos.targetPct))}%</span>`;
}

function buildCardSearchBlob(info) {
  const dual = listDualScores(info);
  const dd = info.listDelta || info.dayDelta;
  const oc = describeOutcome(info.outcome);
  return [
    info.filename,
    info.dateLabel,
    info.score,
    dual?.llm,
    dual?.quant,
    dual?.conflict ? '分歧 弃权' : '',
    info.advice?.label,
    info.qualityGate?.label,
    dd?.headline,
    info.positionRec?.targetPct != null ? `仓位${info.positionRec.targetPct}` : '',
    oc?.short,
    oc?.tone === 'hit' ? '命中' : '',
    oc?.tone === 'miss' ? '打脸' : '',
  ].filter(Boolean).join(' ');
}

module.exports = {
  fmtSigned,
  predLabel,
  scoreTone,
  listDualScores,
  synthesizeNeighborDelta,
  attachNeighborDeltas,
  indexOutcomesByDate,
  attachPredictionOutcomes,
  enrichOutcome,
  describeOutcome,
  renderListDualHtml,
  renderQuantBadgeHtml,
  renderListDeltaHtml,
  renderListOutcomeHtml,
  renderListPosHtml,
  buildCardSearchBlob,
};
