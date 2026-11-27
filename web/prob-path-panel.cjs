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
 * 兼容渲染 v1 与 v2 meta.probPath，并提供直达交互式走势预测 Tab 的入口
 * @param {import('./report-meta.cjs').ReportMetaShape|object|null|undefined} meta
 * @param {string} docsDir
 * @param {string} [dateHint]
 */
function renderProbPathPanel(meta, docsDir, dateHint) {
  const pp = meta?.probPath;
  const asOf = pp?.asOf || dateHint || '';
  const forecastHref = asOf ? `/forecast?date=${encodeURIComponent(asOf)}` : '/forecast';

  if (!pp) {
    if (!dateHint) return '';
    return `
<section class="prob-path-panel card">
  <header class="prob-path-head" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:0">
    <div>
      <h2 class="prob-path-title" style="margin-bottom:2px">📈 黄金走势预测图</h2>
      <p class="prob-path-sub" style="margin:0">依据基本面 · 信息面 · 技术面与 FHS 波动率，支持伦敦金/国内金一键切换与历史复盘</p>
    </div>
    <a class="prob-path-cta" style="margin-top:0" href="${forecastHref}">打开当日走势预测图 →</a>
  </header>
</section>`;
  }

  const h5 = pp.horizons?.['5'];
  const last5 = h5?.points?.[h5.points.length - 1];
  const core5 = last5 && typeof last5.p25 === 'number' && typeof last5.p75 === 'number'
    ? ` · 核心带 ${last5.p25}%～${last5.p75}%`
    : '';
  const summary5 = last5 && h5.futureFan
    ? `5日 P50 ${last5.p50 >= 0 ? '+' : ''}${last5.p50}%（P10~P90 ${last5.p10}%～${last5.p90}%${core5}）`
    : '5日：样本不足，仅历史走势';

  const svg5 = tryReadSvg(docsDir, pp.svgRel?.path5d);
  const svg20 = tryReadSvg(docsDir, pp.svgRel?.path20d);

  const struct = (pp.structure || [])
    .map(s => `${s.label} ${s.pctFromSpot >= 0 ? '+' : ''}${s.pctFromSpot}%`)
    .join(' · ');

  const subParts = [];
  if (pp.condition?.bucket) subParts.push(`分桶 ${pp.condition.bucket}`);
  if (typeof pp.sampleSize === 'number') subParts.push(`n=${pp.sampleSize}`);
  if (typeof h5?.effectiveSampleSize === 'number') subParts.push(`N_eff=${h5.effectiveSampleSize}`);
  if (typeof pp.vol20dPct === 'number') subParts.push(`σ₀=${pp.vol20dPct}%/日`);
  subParts.push(pp.degraded || 'full');

  const gate = pp.gateHint ? `<p class="prob-path-gate">${esc(pp.gateHint)}</p>` : '';
  const note = `<p class="prob-path-note">${esc(pp.inSampleNote || '')}</p>`;

  return `
<section class="prob-path-panel card">
  <header class="prob-path-head">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <h2 class="prob-path-title">📈 概率路径（统计）</h2>
      <a class="prob-path-cta" style="margin-top:0" href="${forecastHref}">在走势预测页交互查看 →</a>
    </div>
    <p class="prob-path-sub">${esc(subParts.join(' · '))}</p>
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