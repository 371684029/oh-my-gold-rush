'use strict';

const fs = require('node:fs');
const path = require('node:path');

function tryReadSvg(docsDir, rel) {
  if (!rel) return '';
  const fp = path.join(docsDir, rel);
  if (!fs.existsSync(fp)) return '';
  return fs.readFileSync(fp, 'utf-8');
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {import('./report-meta.cjs').ReportMetaShape|object|null|undefined} meta
 * @param {string} docsDir
 */
function renderProbPathPanel(meta, docsDir) {
  const pp = meta?.probPath;
  if (!pp) return '';

  const h5 = pp.horizons?.['5'];
  const last5 = h5?.points?.[h5.points.length - 1];
  const summary5 = last5 && h5.futureFan
    ? `5日 P50 ${last5.p50 >= 0 ? '+' : ''}${last5.p50}%（P10~P90 ${last5.p10}%～${last5.p90}%）`
    : '5日：样本不足，仅历史走势';

  const svg5 = tryReadSvg(docsDir, pp.svgRel?.path5d);
  const svg20 = tryReadSvg(docsDir, pp.svgRel?.path20d);

  const struct = (pp.structure || [])
    .map(s => `${s.label} ${s.pctFromSpot >= 0 ? '+' : ''}${s.pctFromSpot}%`)
    .join(' · ');

  const gate = pp.gateHint ? `<p class="prob-path-gate">${esc(pp.gateHint)}</p>` : '';
  const note = `<p class="prob-path-note">${esc(pp.inSampleNote || '')}</p>`;

  return `
<section class="prob-path-panel card">
  <header class="prob-path-head">
    <h2 class="prob-path-title">📈 概率路径（统计）</h2>
    <p class="prob-path-sub">分桶 ${esc(pp.condition?.bucket)} · n=${pp.sampleSize} · <code>${esc(pp.degraded)}</code></p>
    <p class="prob-path-summary">${esc(summary5)}</p>
    ${struct ? `<p class="prob-path-struct">结构：${esc(struct)}</p>` : ''}
  </header>
  <div class="prob-path-tabs">
    <details open class="prob-path-tab">
      <summary>5 交易日</summary>
      <div class="prob-path-chart">${svg5 || '<p class="muted">暂无 SVG（运行 analysis --md 或 goldrush path）</p>'}</div>
    </details>
    <details class="prob-path-tab">
      <summary>20 交易日</summary>
      <div class="prob-path-chart">${svg20 || '<p class="muted">暂无 SVG</p>'}</div>
    </details>
  </div>
  ${gate}
  ${note}
</section>`;
}

module.exports = { renderProbPathPanel };