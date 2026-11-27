'use strict';

// GoldRush 黄金走势预测 Tab 页（/forecast）
// 一键切换：伦敦金($/oz) / 国内金(¥/克) / 涨跌幅(%) · 5/20/60交易日 · 每日一图切换与历史复盘对照

const { renderAppTabs } = require('./nav-tabs.cjs');

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeJsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function renderForecastPage({ forecast, allDates, archive, syncMeta, baseCss }) {
  if (!forecast) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>黄金走势预测 — GoldRush</title>
  <style>${baseCss}</style>
</head>
<body>
  <div class="container">
    ${renderAppTabs('forecast')}
    <div class="empty glass-strong" style="margin-top:24px">
      <div class="icon">📉</div>
      <p>暂无足够的历史金价数据（至少需要 10 个有效交易日）</p>
    </div>
  </div>
</body>
</html>`;
  }

  const dateOptions = allDates
    .slice()
    .reverse()
    .map(d => `<option value="${esc(d)}" ${d === forecast.asOf ? 'selected' : ''}>${esc(d)}</option>`)
    .join('');

  const archiveHtml = (archive || []).map(item => {
    const isActive = item.date === forecast.asOf;
    const p50Color = item.p50_5d > 0.3 ? 'up' : item.p50_5d < -0.3 ? 'down' : 'flat';
    const replayBadge = item.actual5dPct != null
      ? `<span class="fc-arch-replay ${item.inBand5 ? 'hit' : 'miss'}">5日实盘 ${item.actual5dPct >= 0 ? '+' : ''}${item.actual5dPct}% ${item.inBand5 ? '· 区间内 ✓' : '· 越界'}</span>`
      : `<span class="fc-arch-replay pending">待 5 日验证</span>`;
    const srcTag = item.hasAiReport
      ? `<span class="fc-arch-src ai">AI</span>`
      : `<span class="fc-arch-src live">实盘</span>`;
    return `<button type="button" class="fc-arch-card ${isActive ? 'active' : ''}" data-date="${esc(item.date)}" onclick="loadForecastDate(this.dataset.date)">
      <div class="fc-arch-top">
        <span class="fc-arch-date">${esc(item.date)} ${srcTag}</span>
        <span class="fc-arch-verdict dir-${esc(item.verdict5.code)}">${esc(item.verdict5.label)}</span>
      </div>
      <div class="fc-arch-price" data-usd="${item.spotUsd}" data-cny="${item.spotCny}">$${item.spotUsd.toFixed(1)}/oz</div>
      <div class="fc-arch-metrics">
        <span class="${p50Color}">5日 ${item.p50_5d >= 0 ? '+' : ''}${item.p50_5d}%</span>
        <span>20日 ${item.p50_20d >= 0 ? '+' : ''}${item.p50_20d}%</span>
      </div>
      <div class="fc-arch-foot">${replayBadge}</div>
    </button>`;
  }).join('');

  const pageCss = `
${baseCss}

/* —— 走势预测 Tab 专属样式 —— */
.fc-wrap {
  max-width: 1120px;
  margin: 0 auto;
  padding: 20px 20px 56px;
}
.fc-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 18px;
}
.fc-title-group h1 {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.025em;
  color: var(--text);
}
.fc-title-group p {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-2);
}
.fc-date-nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  background: var(--glass-strong);
  border: 0.5px solid var(--hairline-light);
  padding: 6px 8px;
  border-radius: 12px;
  box-shadow: var(--shadow-card);
}
.fc-date-btn {
  border: 0;
  background: rgba(0, 0, 0, 0.04);
  color: var(--text);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background 0.15s var(--ease);
}
.fc-date-btn:hover:not(:disabled) { background: rgba(0, 122, 255, 0.12); color: var(--accent); }
.fc-date-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.fc-date-select {
  border: 0.5px solid var(--hairline);
  background: rgba(255, 255, 255, 0.8);
  color: var(--text);
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 600;
  padding: 5px 10px;
  border-radius: 8px;
  cursor: pointer;
}
.fc-report-link {
  font-size: 12px;
  font-weight: 600;
  padding: 6px 11px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
  white-space: nowrap;
}
.fc-report-link:hover { text-decoration: none; background: rgba(0, 122, 255, 0.2); }
.fc-report-link.disabled {
  background: rgba(0, 0, 0, 0.045);
  color: var(--text-3);
  pointer-events: none;
  cursor: default;
}

/* 数据新鲜度与一键刷新条 */
.fc-fresh-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 14px;
  border-radius: 12px;
  margin-bottom: 14px;
  font-size: 12px;
  color: var(--text-2);
}
.fc-fresh-left {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.fc-source-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 7px;
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
}
.fc-source-badge.ai {
  background: rgba(26, 127, 55, 0.12);
  color: var(--green-text);
}
.fc-source-badge.live {
  background: rgba(0, 122, 255, 0.12);
  color: var(--accent);
}
.fc-fresh-meta {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text-2);
}
.fc-fresh-right {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}
.fc-refresh-toast {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--green-text);
  display: none;
}
.fc-refresh-toast.warn { color: var(--yellow-text); }
.fc-refresh-toast.err { color: var(--red-text); }
.fc-refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 0.5px solid rgba(0, 122, 255, 0.28);
  background: rgba(0, 122, 255, 0.1);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  padding: 6px 12px;
  border-radius: 9px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s var(--ease);
}
.fc-refresh-btn:hover:not(:disabled) {
  background: rgba(0, 122, 255, 0.18);
}
.fc-refresh-btn:disabled {
  opacity: 0.6;
  cursor: wait;
}
.fc-arch-src {
  display: inline-block;
  font-family: var(--font);
  font-size: 9.5px;
  font-weight: 700;
  padding: 1px 4px;
  border-radius: 4px;
  vertical-align: middle;
  margin-left: 3px;
}
.fc-arch-src.ai { background: rgba(26, 127, 55, 0.12); color: var(--green-text); }
.fc-arch-src.live { background: rgba(0, 122, 255, 0.1); color: var(--accent); }

/* 主图玻璃窗口 */
.fc-main-card {
  border-radius: var(--radius-lg);
  padding: 18px 20px 20px;
  margin-bottom: 18px;
}
.fc-controls-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 14px;
  border-bottom: 0.5px solid var(--hairline);
  margin-bottom: 14px;
}
.fc-seg-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.fc-seg-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.fc-segmented {
  display: inline-flex;
  background: rgba(0, 0, 0, 0.055);
  border-radius: 10px;
  padding: 3px;
  gap: 2px;
}
.fc-seg-btn {
  border: 0;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 600;
  padding: 6px 12px;
  border-radius: 7.5px;
  cursor: pointer;
  transition: all 0.16s var(--ease);
  white-space: nowrap;
}
.fc-seg-btn:hover { color: var(--text); }
.fc-seg-btn.active {
  background: #fff;
  color: var(--text);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
}
.fc-seg-divider {
  width: 1px;
  align-self: stretch;
  margin: 4px 3px;
  background: rgba(15, 23, 42, 0.14);
}
.fc-seg-btn.lt-btn {
  color: #8a6200;
}
.fc-seg-btn.lt-btn.active {
  background: linear-gradient(180deg, #fffdf7 0%, #fff7e0 100%);
  color: #7a5200;
  box-shadow: 0 1px 4px rgba(184, 134, 11, 0.22);
}
.fc-toggle-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0.5px solid var(--hairline);
  background: rgba(255, 255, 255, 0.65);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  padding: 6px 11px;
  border-radius: 9px;
  cursor: pointer;
  transition: all 0.16s var(--ease);
}
.fc-toggle-chip.active {
  background: rgba(26, 127, 55, 0.12);
  border-color: rgba(26, 127, 55, 0.35);
  color: var(--green-text);
}
.fc-toggle-chip:disabled { opacity: 0.4; cursor: not-allowed; }

/* KPI 摘要条 */
.fc-kpi-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
.fc-kpi {
  background: rgba(255, 255, 255, 0.64);
  border: 0.5px solid var(--hairline);
  border-radius: 12px;
  padding: 11px 13px;
}
.fc-kpi-label {
  font-size: 11px;
  color: var(--text-2);
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  white-space: nowrap;
}
.fc-kpi-label span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
}
.fc-kpi-label span:last-child {
  flex-shrink: 0;
  font-size: 10.5px;
  opacity: 0.9;
}
.fc-kpi-val {
  font-size: 18px;
  font-weight: 700;
  font-family: var(--mono);
  letter-spacing: -0.02em;
  color: var(--text);
}
.fc-kpi-sub {
  font-size: 11.5px;
  color: var(--text-2);
  margin-top: 2px;
  font-family: var(--mono);
}
.tone-bull { color: var(--green-text) !important; }
.tone-bear { color: var(--red-text) !important; }
.tone-gold { color: var(--gold) !important; }

/* 门禁警示条 */
.fc-gate-banner {
  background: rgba(255, 69, 58, 0.1);
  border: 0.5px solid rgba(255, 69, 58, 0.3);
  color: var(--red-text);
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 12.5px;
  font-weight: 500;
  margin-bottom: 12px;
}
.fc-gate-banner.yellow {
  background: rgba(255, 159, 10, 0.12);
  border-color: rgba(255, 159, 10, 0.35);
  color: var(--yellow-text);
}

/* 交互式预测图表容器 */
.fc-chart-stage {
  position: relative;
  background: rgba(255, 255, 255, 0.78);
  border: 0.5px solid var(--hairline);
  border-radius: 14px;
  padding: 12px 10px 8px;
  overflow: hidden;
}
.fc-chart-svg {
  width: 100%;
  height: auto;
  display: block;
  user-select: none;
  touch-action: pan-y;
}
.fc-legend-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 6px 2px;
  font-size: 11.5px;
  color: var(--text-2);
}
.fc-legend-items {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
}
.fc-leg {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.fc-swatch {
  width: 14px;
  height: 3px;
  border-radius: 2px;
  display: inline-block;
}
.fc-swatch.band {
  height: 10px;
  border-radius: 3px;
}
.fc-tooltip {
  position: absolute;
  pointer-events: none;
  z-index: 20;
  min-width: 196px;
  background: rgba(255, 255, 255, 0.94);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 0.5px solid rgba(0, 0, 0, 0.12);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.14);
  border-radius: 11px;
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text);
  display: none;
}
.fc-tooltip-head {
  font-weight: 700;
  font-family: var(--mono);
  margin-bottom: 6px;
  padding-bottom: 5px;
  border-bottom: 0.5px solid var(--hairline);
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.fc-tooltip-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 3px;
  font-family: var(--mono);
  font-size: 11.5px;
}
.fc-tooltip-row span:first-child { color: var(--text-2); font-family: var(--font); }

/* 三面依据区 */
.fc-sec-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin: 22px 0 10px;
}
.fc-sec-head h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
}
.fc-sec-head span {
  font-size: 12px;
  color: var(--text-2);
}
.fc-pillars-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}
.fc-pillar-card {
  border-radius: var(--radius-md);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.fc-pillar-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.fc-pillar-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}
.fc-pillar-sub {
  font-size: 11.5px;
  color: var(--text-2);
  margin-top: 2px;
}
.fc-pillar-score-box {
  text-align: right;
  flex-shrink: 0;
}
.fc-pillar-score {
  font-size: 20px;
  font-weight: 700;
  font-family: var(--mono);
  line-height: 1.1;
}
.fc-pillar-weight {
  font-size: 11px;
  color: var(--text-2);
  margin-top: 2px;
}
.fc-pillar-bar {
  height: 5px;
  border-radius: 99px;
  background: rgba(0, 0, 0, 0.07);
  overflow: hidden;
}
.fc-pillar-bar-fill {
  height: 100%;
  border-radius: 99px;
  transition: width 0.25s var(--ease);
}
.fc-pillar-metrics {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.fc-pm-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.56);
}
.fc-pm-k { color: var(--text-2); }
.fc-pm-v { font-weight: 600; font-family: var(--mono); text-align: right; }
.fc-pillar-summary {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-2);
  border-top: 0.5px solid var(--hairline);
  padding-top: 8px;
}

/* 关键位与历史相似日双栏 */
.fc-detail-grid {
  display: grid;
  grid-template-columns: 1fr 1.15fr;
  gap: 14px;
  margin-top: 14px;
}
.fc-panel {
  border-radius: var(--radius-md);
  padding: 16px;
}
.fc-panel h3 {
  margin: 0 0 10px;
  font-size: 14.5px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.fc-panel h3 small {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-2);
}
.fc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.fc-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  padding: 6px 8px;
  border-bottom: 0.5px solid var(--hairline);
  white-space: nowrap;
}
.fc-table td {
  padding: 7px 8px;
  border-bottom: 0.5px solid rgba(0, 0, 0, 0.045);
  font-family: var(--mono);
}
.fc-table td.txt { font-family: var(--font); }
.fc-tag {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  font-family: var(--font);
  white-space: nowrap;
}
.fc-tag.res { background: rgba(249, 115, 22, 0.14); color: #c2410c; }
.fc-tag.sup { background: rgba(26, 127, 55, 0.14); color: var(--green-text); }
.fc-fhs-meta {
  margin-top: 10px;
  padding-top: 9px;
  border-top: 0.5px solid var(--hairline);
  font-size: 11.5px;
  color: var(--text-2);
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

/* 结论溯源与可查证据链 */
.fc-evidence-stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.fc-audit-wrap {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.fc-audit-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.fc-audit-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  padding: 7px 9px;
  border-bottom: 0.5px solid var(--hairline);
  white-space: nowrap;
}
.fc-audit-table td {
  padding: 9px 9px;
  border-bottom: 0.5px solid rgba(0, 0, 0, 0.05);
  vertical-align: top;
  line-height: 1.48;
}
.fc-audit-factor {
  font-weight: 700;
  color: var(--text);
  white-space: nowrap;
}
.fc-audit-mech {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
  max-width: 240px;
}
.fc-audit-val {
  font-family: var(--mono);
  font-weight: 700;
  color: var(--text);
  white-space: nowrap;
}
.fc-audit-src {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-2);
  white-space: nowrap;
}
.fc-audit-pct {
  font-family: var(--mono);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}
.fc-audit-emp {
  font-size: 11.5px;
  color: var(--text-2);
  min-width: 220px;
}
.fc-imp-badge {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.fc-imp-badge.bull { background: rgba(26, 127, 55, 0.13); color: var(--green-text); }
.fc-imp-badge.bear { background: rgba(198, 40, 40, 0.12); color: var(--red-text); }
.fc-imp-badge.neutral { background: rgba(154, 103, 0, 0.11); color: var(--yellow-text); }

/* 长期三情景推演卡 */
.fc-scenarios-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.fc-sc-card {
  border-radius: var(--radius-md);
  padding: 15px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 3px solid var(--hairline);
}
.fc-sc-card.bull { border-top-color: #16a34a; }
.fc-sc-card.base { border-top-color: #b8860b; }
.fc-sc-card.bear { border-top-color: #dc2626; }
.fc-sc-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}
.fc-sc-title {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text);
  line-height: 1.35;
}
.fc-sc-prob {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.055);
  color: var(--text-2);
  white-space: nowrap;
}
.fc-sc-target {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.fc-sc-price {
  font-family: var(--mono);
  font-size: 20px;
  font-weight: 700;
}
.fc-sc-cagr {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.fc-sc-trigger {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-2);
}
.fc-sc-stance {
  margin-top: auto;
  padding-top: 8px;
  border-top: 0.5px solid var(--hairline);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.45;
}

/* 推翻条件与方法论说明 */
.fc-triggers-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.fc-trig-item {
  background: rgba(255, 255, 255, 0.58);
  border: 0.5px solid var(--hairline);
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 12px;
}
.fc-trig-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.fc-trig-metric { font-weight: 700; color: var(--text); }
.fc-trig-cur { font-family: var(--mono); font-size: 11.5px; color: var(--text-2); }
.fc-trig-cond { font-weight: 600; color: #b45309; margin-bottom: 3px; }
.fc-trig-mean { font-size: 11.5px; color: var(--text-2); line-height: 1.45; }
.fc-method-note {
  margin-top: 10px;
  padding: 9px 12px;
  border-radius: 9px;
  background: rgba(15, 23, 42, 0.035);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-2);
}
.fc-analog-era {
  font-family: var(--font);
  font-size: 11px;
  color: var(--text-2);
  margin-top: 2px;
}
.fc-analog-snap {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-3);
  margin-top: 2px;
}

/* 每日预测存档网格 */
.fc-archive-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(195px, 1fr));
  gap: 10px;
}
.fc-arch-card {
  text-align: left;
  border: 0.5px solid var(--hairline-light);
  background: var(--glass);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border-radius: 12px;
  padding: 11px 13px;
  cursor: pointer;
  transition: transform 0.15s var(--ease), box-shadow 0.15s var(--ease), border-color 0.15s var(--ease);
  box-shadow: var(--shadow-card);
  font-family: var(--font);
}
.fc-arch-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lift);
}
.fc-arch-card.active {
  background: rgba(255, 255, 255, 0.92);
  border: 1.5px solid var(--accent);
}
.fc-arch-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
}
.fc-arch-date {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
}
.fc-arch-verdict {
  font-size: 10.5px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 6px;
}
.fc-arch-verdict.dir-bullish { background: rgba(26, 127, 55, 0.12); color: var(--green-text); }
.fc-arch-verdict.dir-bearish { background: rgba(198, 40, 40, 0.12); color: var(--red-text); }
.fc-arch-verdict.dir-neutral { background: rgba(154, 103, 0, 0.12); color: var(--yellow-text); }
.fc-arch-price {
  font-family: var(--mono);
  font-size: 15px;
  font-weight: 700;
  color: var(--gold);
  margin-bottom: 4px;
}
.fc-arch-metrics {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-2);
  margin-bottom: 5px;
  white-space: nowrap;
}
.fc-arch-metrics .up { color: var(--green-text); font-weight: 600; }
.fc-arch-metrics .down { color: var(--red-text); font-weight: 600; }
.fc-arch-foot { font-size: 11px; }
.fc-arch-replay { font-weight: 600; font-family: var(--mono); }
.fc-arch-replay.hit { color: var(--green-text); }
.fc-arch-replay.miss { color: #c2410c; }
.fc-arch-replay.pending { color: var(--text-3); font-family: var(--font); font-weight: 500; }

.fc-disclaimer {
  margin-top: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--text-2);
  padding: 12px 16px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.48);
}

@media (max-width: 900px) {
  .fc-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fc-pillars-grid { grid-template-columns: 1fr; }
  .fc-detail-grid { grid-template-columns: 1fr; }
  .fc-scenarios-grid { grid-template-columns: 1fr; }
  .fc-triggers-grid { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .fc-kpi-card { padding: 10px 11px; }
  .fc-kpi-label { flex-wrap: wrap; white-space: normal; row-gap: 2px; }
  .fc-kpi-label span:first-child { overflow: visible; text-overflow: clip; }
  .fc-kpi-val { font-size: 15.5px; line-height: 1.25; }
  .fc-kpi-sub { font-size: 11px; }
}
`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>黄金走势预测 (${esc(forecast.asOf)}) — GoldRush</title>
  <style>${pageCss}</style>
</head>
<body>
  <div class="fc-wrap">
    ${renderAppTabs('forecast', forecast.asOf)}

    <header class="fc-header">
      <div class="fc-title-group">
        <h1>📈 黄金走势预测图</h1>
        <p id="fc-subtitle">依据基本面 · 信息面 · 技术面与 FHS 波动率归一化，每日生成一张可审计的走势预测图</p>
      </div>
      <div class="fc-date-nav">
        <button type="button" class="fc-date-btn" id="btn-prev-date" onclick="stepDate(-1)" aria-label="上一交易日">◀ 上一日</button>
        <select class="fc-date-select" id="date-select" aria-label="选择预测日期" onchange="loadForecastDate(this.value)">
          ${dateOptions}
        </select>
        <button type="button" class="fc-date-btn" id="btn-next-date" onclick="stepDate(1)" aria-label="下一交易日">下一日 ▶</button>
        <button type="button" class="fc-date-btn" id="btn-latest-date" onclick="loadLatestDate()">最新</button>
        <a class="fc-report-link ${forecast.filename ? '' : 'disabled'}" id="link-daily-report" href="${forecast.filename ? '/' + esc(forecast.filename) : 'javascript:void(0)'}">${forecast.filename ? '当日日报 →' : '无当日 AI 日报'}</a>
      </div>
    </header>

    <section class="fc-fresh-bar glass-strong" aria-label="数据来源与实时同步">
      <div class="fc-fresh-left">
        <span class="fc-source-badge ${forecast.hasAiReport ? 'ai' : 'live'}" id="fc-source-badge">${forecast.hasAiReport ? 'AI 日报 + 实时行情' : '实时行情融合（无AI日报）'}</span>
        <span class="fc-fresh-meta" id="fc-fresh-meta"></span>
      </div>
      <div class="fc-fresh-right">
        <span class="fc-refresh-toast" id="fc-refresh-toast" role="status"></span>
        <button type="button" class="fc-refresh-btn" id="btn-refresh-data" onclick="refreshMarketData()">🔄 刷新最新数据</button>
      </div>
    </section>

    <section class="fc-main-card glass-strong" aria-label="黄金走势预测主图">
      <div class="fc-controls-bar">
        <div class="fc-seg-group">
          <span class="fc-seg-label">计价单位</span>
          <div class="fc-segmented" role="tablist" aria-label="计价单位一键切换">
            <button type="button" class="fc-seg-btn active" data-unit="usd" onclick="setUnit('usd')">伦敦金 $/oz</button>
            <button type="button" class="fc-seg-btn" data-unit="cny" onclick="setUnit('cny')">国内金 ¥/克</button>
            <button type="button" class="fc-seg-btn" data-unit="pct" onclick="setUnit('pct')">涨跌幅 %</button>
          </div>
        </div>

        <div class="fc-seg-group">
          <span class="fc-seg-label">预测周期</span>
          <div class="fc-segmented" role="tablist" aria-label="预测周期一键切换">
            <button type="button" class="fc-seg-btn active" data-horizon="5" onclick="setHorizon('5')">5日</button>
            <button type="button" class="fc-seg-btn" data-horizon="20" onclick="setHorizon('20')">20日</button>
            <button type="button" class="fc-seg-btn" data-horizon="60" onclick="setHorizon('60')">60日</button>
            <span class="fc-seg-divider" aria-hidden="true"></span>
            <button type="button" class="fc-seg-btn lt-btn" data-horizon="1y" onclick="setHorizon('1y')">1年</button>
            <button type="button" class="fc-seg-btn lt-btn" data-horizon="2y" onclick="setHorizon('2y')">2年</button>
            <button type="button" class="fc-seg-btn lt-btn" data-horizon="5y" onclick="setHorizon('5y')">5年</button>
          </div>
        </div>

        <div class="fc-seg-group">
          <button type="button" class="fc-toggle-chip active" id="btn-toggle-ma" onclick="toggleMa20()">MA20 均线</button>
          <button type="button" class="fc-toggle-chip" id="btn-toggle-replay" onclick="toggleReplay()">叠加实盘复盘</button>
        </div>
      </div>

      <div id="fc-gate-slot"></div>
      <div class="fc-kpi-grid" id="fc-kpi-grid"></div>

      <div class="fc-chart-stage" id="fc-chart-stage">
        <svg class="fc-chart-svg" id="fc-chart-svg" viewBox="0 0 1040 400" role="img" aria-label="黄金历史与未来走势预测图"></svg>
        <div class="fc-tooltip" id="fc-tooltip"></div>
        <div class="fc-legend-row">
          <div class="fc-legend-items">
            <span class="fc-leg"><span class="fc-swatch" style="background:#334155"></span>历史真实金价</span>
            <span class="fc-leg"><span class="fc-swatch" style="background:#b8860b;height:3.5px"></span>主预测趋势 (P50)</span>
            <span class="fc-leg"><span class="fc-swatch band" style="background:rgba(184,134,11,0.28)"></span>核心概率带 (P25–P75)</span>
            <span class="fc-leg"><span class="fc-swatch band" style="background:rgba(184,134,11,0.12);border:0.5px solid rgba(184,134,11,0.35)"></span>极端波动带 (P10–P90)</span>
            <span class="fc-leg"><span class="fc-swatch" style="border-top:2px dashed #64748b;background:none;height:0"></span><span id="leg-baseline-txt">无条件波动基准</span></span>
            <span class="fc-leg" id="leg-replay" style="display:none"><span class="fc-swatch" style="background:#16a34a;height:3px"></span>事后真实走势</span>
          </div>
          <div id="fc-chart-meta-inline"></div>
        </div>
      </div>
    </section>

    <div class="fc-sec-head">
      <h2>🧭 预测依据：基本面 · 信息面 · 技术面</h2>
      <span id="fc-track-caption"></span>
    </div>
    <section class="fc-pillars-grid" id="fc-pillars-grid" aria-label="三面预测依据"></section>

    <div class="fc-sec-head">
      <h2>🔬 结论溯源与可查证据链</h2>
      <span id="fc-evidence-caption">每一项因子均标注官方数据源、真实观测日、历史分位与同类历史实证</span>
    </div>
    <section class="fc-evidence-stack" id="fc-evidence-stack" aria-label="结论溯源与可查证据链">
      <div class="fc-panel glass-strong">
        <h3>核心驱动因子审计表 <small id="fc-audit-sub">有据可查 · 严格因果统计</small></h3>
        <div class="fc-audit-wrap">
          <table class="fc-audit-table">
            <thead>
              <tr>
                <th>驱动因子</th>
                <th>当前读数</th>
                <th>官方数据源与观测日</th>
                <th>历史分位</th>
                <th>方向影响</th>
                <th>同类状态历史实证</th>
              </tr>
            </thead>
            <tbody id="fc-audit-tbody"></tbody>
          </table>
        </div>
      </div>

      <div id="fc-scenarios-wrap" style="display:none">
        <div class="fc-scenarios-grid" id="fc-scenarios-grid"></div>
      </div>

      <div class="fc-panel glass-strong">
        <h3>⚠️ 推翻条件与透明边界 <small>明确什么信号发生时需要修正上述结论</small></h3>
        <div class="fc-triggers-grid" id="fc-triggers-grid"></div>
        <div class="fc-method-note" id="fc-method-note"></div>
      </div>
    </section>

    <section class="fc-detail-grid" aria-label="关键价位与历史相似样本">
      <div class="fc-panel glass-strong">
        <h3 id="fc-levels-title">关键压力位 &amp; 支撑位 <small id="fc-levels-sub">随计价单位自动换算</small></h3>
        <table class="fc-table">
          <thead>
            <tr><th>价格结构</th><th>属性</th><th>参考价位</th><th>距现价</th><th>期内触达概率</th></tr>
          </thead>
          <tbody id="fc-levels-tbody"></tbody>
        </table>
      </div>

      <div class="fc-panel glass-strong">
        <h3 id="fc-analogs-title">历史最相似样本（可审计依据） <small id="fc-analogs-sub">严格零前视泄漏</small></h3>
        <table class="fc-table">
          <thead id="fc-analogs-thead">
            <tr><th>历史日期</th><th>相似度</th><th>当时走势</th><th>FHS 波动缩放后</th></tr>
          </thead>
          <tbody id="fc-analogs-tbody"></tbody>
        </table>
        <div class="fc-fhs-meta" id="fc-fhs-meta"></div>
      </div>
    </section>

    <div class="fc-sec-head">
      <h2>📅 每日走势预测存档（点击任意日期回放与复盘）</h2>
      <span>每日自动生成 · 历史日支持叠加事后真实走势检验</span>
    </div>
    <section class="fc-archive-grid" id="fc-archive-grid" aria-label="每日预测存档">
      ${archiveHtml}
    </section>

    <div class="fc-disclaimer" id="fc-disclaimer">${esc(forecast.disclaimer)}</div>
  </div>

  <script>
    let currentData = ${safeJsonForScript(forecast)};
    let currentSyncMeta = ${safeJsonForScript(syncMeta || null)};
    let latestAvailableDate = ${safeJsonForScript(allDates[allDates.length - 1] || forecast.asOf)};
    let currentUnit = 'usd';      // 'usd' | 'cny' | 'pct'
    let currentHorizon = '5';     // '5' | '20' | '60'
    let showMa20 = true;
    let showReplay = false;
    let hoverPoints = [];

    function fmtVal(usd, cny, pct, compact) {
      if (currentUnit === 'usd') return '$' + Number(usd).toFixed(compact ? 0 : 1);
      if (currentUnit === 'cny') return '¥' + Number(cny).toFixed(compact ? 1 : 2) + (compact ? '' : '/g');
      return (pct >= 0 ? '+' : '') + Number(pct).toFixed(2) + '%';
    }

    function fmtPct(p) {
      const n = Number(p || 0);
      return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
    }

    function pickSeriesVal(pt, field) {
      if (currentUnit === 'usd') return pt.usd[field];
      if (currentUnit === 'cny') return pt.cny[field];
      return pt[field];
    }

    function pickHistVal(h) {
      if (currentUnit === 'usd') return h.usd;
      if (currentUnit === 'cny') return h.cny;
      return h.pct;
    }

    function pickMaVal(h) {
      if (currentUnit === 'usd') return h.ma20Usd;
      if (currentUnit === 'cny') return h.ma20Cny;
      return h.ma20Pct;
    }

    function pickReplayVal(r) {
      if (currentUnit === 'usd') return r.usd;
      if (currentUnit === 'cny') return r.cny;
      return r.pct;
    }

    function setUnit(u) {
      currentUnit = u;
      document.querySelectorAll('[data-unit]').forEach(b => b.classList.toggle('active', b.getAttribute('data-unit') === u));
      updateArchiveUnitPrices();
      renderAll();
    }

    function setHorizon(h) {
      currentHorizon = String(h);
      document.querySelectorAll('[data-horizon]').forEach(b => b.classList.toggle('active', b.getAttribute('data-horizon') === currentHorizon));
      renderAll();
    }

    function toggleMa20() {
      showMa20 = !showMa20;
      document.getElementById('btn-toggle-ma').classList.toggle('active', showMa20);
      renderChart();
    }

    function toggleReplay() {
      const hData = currentData.horizons[currentHorizon];
      if (!hData || !hData.actualReplay || !hData.actualReplay.length) return;
      showReplay = !showReplay;
      document.getElementById('btn-toggle-replay').classList.toggle('active', showReplay);
      renderChart();
    }

    function stepDate(delta) {
      const target = delta < 0 ? currentData.prevDate : currentData.nextDate;
      if (target) loadForecastDate(target);
    }

    async function loadForecastDate(date) {
      if (!date) return;
      try {
        const res = await fetch('/api/forecast?date=' + encodeURIComponent(date));
        if (!res.ok) return;
        const json = await res.json();
        if (!json || !json.asOf) return;
        currentData = json;
        // 历史日若已有后续实盘数据，默认保留当前开关；若无后续实盘，关闭复盘叠加
        const hData = currentData.horizons[currentHorizon];
        if (!hData?.actualReplay?.length) showReplay = false;
        document.getElementById('date-select').value = currentData.asOf;
        document.querySelectorAll('.fc-arch-card').forEach(el => {
          el.classList.toggle('active', el.getAttribute('data-date') === currentData.asOf);
        });
        document.title = '黄金走势预测 (' + currentData.asOf + ') — GoldRush';
        history.replaceState(null, '', '/forecast?date=' + encodeURIComponent(currentData.asOf));
        renderAll();
      } catch (err) {
        console.error('Failed to load forecast date', err);
      }
    }

    function updateArchiveUnitPrices() {
      document.querySelectorAll('.fc-arch-price').forEach(el => {
        const usd = parseFloat(el.getAttribute('data-usd'));
        const cny = parseFloat(el.getAttribute('data-cny'));
        if (currentUnit === 'cny') el.textContent = '¥' + cny.toFixed(1) + '/克';
        else el.textContent = '$' + usd.toFixed(1) + '/oz';
      });
    }

    function loadLatestDate() {
      if (latestAvailableDate) loadForecastDate(latestAvailableDate);
    }

    function showToast(msg, tone) {
      const el = document.getElementById('fc-refresh-toast');
      if (!el) return;
      el.textContent = msg;
      el.className = 'fc-refresh-toast' + (tone ? ' ' + tone : '');
      el.style.display = 'inline';
      clearTimeout(el._timer);
      el._timer = setTimeout(() => { el.style.display = 'none'; }, 5000);
    }

    function rebuildArchiveGrid(archiveList) {
      const grid = document.getElementById('fc-archive-grid');
      if (!grid || !Array.isArray(archiveList)) return;
      grid.innerHTML = archiveList.map(item => {
        const isActive = item.date === currentData.asOf;
        const p50Color = item.p50_5d > 0.3 ? 'up' : item.p50_5d < -0.3 ? 'down' : 'flat';
        const replayBadge = item.actual5dPct != null
          ? '<span class="fc-arch-replay ' + (item.inBand5 ? 'hit' : 'miss') + '">5日实盘 ' + (item.actual5dPct >= 0 ? '+' : '') + item.actual5dPct + '% ' + (item.inBand5 ? '· 区间内 ✓' : '· 越界') + '</span>'
          : '<span class="fc-arch-replay pending">待 5 日验证</span>';
        const srcTag = item.hasAiReport
          ? '<span class="fc-arch-src ai">AI</span>'
          : '<span class="fc-arch-src live">实盘</span>';
        const priceStr = currentUnit === 'cny' ? '¥' + item.spotCny.toFixed(1) + '/克' : '$' + item.spotUsd.toFixed(1) + '/oz';
        return '<button type="button" class="fc-arch-card ' + (isActive ? 'active' : '') + '" data-date="' + escHtml(item.date) + '" onclick="loadForecastDate(this.dataset.date)">' +
          '<div class="fc-arch-top">' +
            '<span class="fc-arch-date">' + escHtml(item.date) + ' ' + srcTag + '</span>' +
            '<span class="fc-arch-verdict dir-' + escHtml(item.verdict5.code) + '">' + escHtml(item.verdict5.label) + '</span>' +
          '</div>' +
          '<div class="fc-arch-price" data-usd="' + item.spotUsd + '" data-cny="' + item.spotCny + '">' + priceStr + '</div>' +
          '<div class="fc-arch-metrics">' +
            '<span class="' + p50Color + '">5日 ' + (item.p50_5d >= 0 ? '+' : '') + item.p50_5d + '%</span>' +
            '<span>20日 ' + (item.p50_20d >= 0 ? '+' : '') + item.p50_20d + '%</span>' +
          '</div>' +
          '<div class="fc-arch-foot">' + replayBadge + '</div>' +
        '</button>';
      }).join('');
    }

    async function refreshMarketData() {
      const btn = document.getElementById('btn-refresh-data');
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '⏳ 正在同步最新实盘...';
      try {
        const res = await fetch('/api/forecast/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const json = await res.json();
        if (!res.ok || !json.ok) {
          showToast(json?.message || '同步失败，请稍后重试', 'err');
          return;
        }
        if (json.meta) currentSyncMeta = json.meta;
        if (Array.isArray(json.allDates) && json.allDates.length) {
          latestAvailableDate = json.allDates[json.allDates.length - 1];
          const sel = document.getElementById('date-select');
          sel.innerHTML = json.allDates.slice().reverse().map(d =>
            '<option value="' + escHtml(d) + '">' + escHtml(d) + '</option>'
          ).join('');
        }
        if (json.forecast && json.forecast.asOf) {
          currentData = json.forecast;
          document.getElementById('date-select').value = currentData.asOf;
          document.title = '黄金走势预测 (' + currentData.asOf + ') — GoldRush';
          history.replaceState(null, '', '/forecast?date=' + encodeURIComponent(currentData.asOf));
        }
        if (Array.isArray(json.archive)) {
          rebuildArchiveGrid(json.archive);
        }
        renderAll();
        showToast(json.message || '已同步最新数据', json.cooldown ? 'warn' : '');
      } catch (err) {
        showToast('网络异常，未能刷新最新行情', 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = '🔄 刷新最新数据';
      }
    }

    function renderFreshnessBar() {
      const badge = document.getElementById('fc-source-badge');
      const metaEl = document.getElementById('fc-fresh-meta');
      if (badge) {
        if (currentData.hasAiReport) {
          badge.className = 'fc-source-badge ai';
          badge.textContent = 'AI 日报 + 实时行情';
        } else {
          badge.className = 'fc-source-badge live';
          badge.textContent = '实时行情融合（无AI日报）';
        }
      }
      if (metaEl) {
        const parts = [];
        const total = currentData.totalTradingDays || currentSyncMeta?.tradingDays;
        if (total) parts.push(total + ' 日线');
        const mBars = currentData.monthlyStats?.bars || currentSyncMeta?.monthlyBars;
        const mFrom = currentData.monthlyStats?.from || currentSyncMeta?.monthlyDateRange?.from;
        const mTo = currentData.monthlyStats?.to || currentSyncMeta?.monthlyDateRange?.to;
        if (mBars) parts.push(mBars + ' 月线 (' + (mFrom ? mFrom.slice(0, 4) + '~' + (mTo || '').slice(0, 4) : '25年') + ')');
        const mObs = currentData.macroObsDate || (currentData.isLatest ? currentSyncMeta?.obsDates?.tips : null);
        if (mObs) parts.push('TIPS ' + mObs);
        const cpiObs = currentData.monthlyStats?.cpiObsDate || (currentData.isLatest ? currentSyncMeta?.obsDates?.cpi : null);
        if (cpiObs) parts.push('CPI ' + cpiObs.slice(0, 7));
        const cObs = currentData.cftcObsDate || (currentData.isLatest ? currentSyncMeta?.obsDates?.cftc : null);
        if (cObs) parts.push('CFTC ' + cObs);
        metaEl.textContent = parts.join(' · ');
      }
    }

    function renderAll() {
      // 如果所选历史日期暂不支持当前长期周期，自动回退到 5日
      if (!currentData.horizons[currentHorizon]) {
        currentHorizon = '5';
        document.querySelectorAll('[data-horizon]').forEach(b => b.classList.toggle('active', b.getAttribute('data-horizon') === currentHorizon));
      }
      const hData = currentData.horizons[currentHorizon];
      const pillars = currentData.pillarsByHorizon[currentHorizon];
      if (!hData) return;
      const isLT = Boolean(hData.isLongTerm);

      // 禁用无数据的长期按钮（极早期日期回放保护）
      document.querySelectorAll('[data-horizon]').forEach(b => {
        const hk = b.getAttribute('data-horizon');
        b.disabled = !currentData.horizons[hk];
      });

      // 更新顶部导航按钮状态与数据源条
      document.getElementById('btn-prev-date').disabled = !currentData.prevDate;
      document.getElementById('btn-next-date').disabled = !currentData.nextDate;
      const reportLink = document.getElementById('link-daily-report');
      if (currentData.filename) {
        reportLink.href = '/' + currentData.filename;
        reportLink.textContent = '当日日报 →';
        reportLink.classList.remove('disabled');
        reportLink.removeAttribute('aria-disabled');
      } else {
        reportLink.href = 'javascript:void(0)';
        reportLink.textContent = '无当日 AI 日报';
        reportLink.classList.add('disabled');
        reportLink.setAttribute('aria-disabled', 'true');
      }
      renderFreshnessBar();

      // 均线按钮与图例文字随短/长期自动切换
      const maBtn = document.getElementById('btn-toggle-ma');
      if (maBtn) maBtn.textContent = isLT ? 'MA12 年均线' : 'MA20 均线';
      const baseLeg = document.getElementById('leg-baseline-txt');
      if (baseLeg) baseLeg.textContent = isLT ? '25年无条件基准' : '无条件波动基准';

      const hasReplay = hData.actualReplay && hData.actualReplay.length > 0;
      const replayBtn = document.getElementById('btn-toggle-replay');
      replayBtn.disabled = !hasReplay;
      if (!hasReplay) {
        showReplay = false;
        replayBtn.textContent = '最新日（暂无事后实盘）';
      } else {
        replayBtn.textContent = '叠加实盘复盘 (' + hData.actualReplay.length + (isLT ? '月)' : '日)');
      }
      replayBtn.classList.toggle('active', showReplay && hasReplay);

      // 门禁提示
      const gateSlot = document.getElementById('fc-gate-slot');
      if (currentData.gateHint) {
        const cls = currentData.gate?.tier === 'yellow' ? 'yellow' : '';
        gateSlot.innerHTML = '<div class="fc-gate-banner ' + cls + '">⚠️ ' + escHtml(currentData.gateHint) + '</div>';
      } else {
        gateSlot.innerHTML = '';
      }

      // KPI 条（长期模式自动展示 CAGR 年化、25年无条件基线与跑赢通胀概率）
      const s = hData.summary;
      const spotStr = currentUnit === 'usd'
        ? '$' + currentData.spot.usd.toFixed(1)
        : currentUnit === 'cny'
          ? '¥' + currentData.spot.cny.toFixed(2)
          : '0.00%';
      const spotSub = currentUnit === 'cny'
        ? (currentData.spot.cnySource === 'shanghai' ? '上海金 Au99.99 (元/克)' : '按汇率 ' + currentData.spot.usdCnyRate + ' 折算人民币/克')
        : currentUnit === 'usd'
          ? '伦敦金现货 (美元/盎司) · ' + currentData.asOf
          : '锚定 ' + currentData.asOf + ' 收盘价 $' + currentData.spot.usd.toFixed(1);

      const p50Tone = s.endP50Pct > 0.3 ? 'tone-bull' : s.endP50Pct < -0.3 ? 'tone-bear' : 'tone-gold';
      const endP50Main = fmtVal(s.endUsd.p50, s.endCny.p50, s.endP50Pct, false);
      const coreLo = fmtVal(s.endUsd.p25, s.endCny.p25, s.endP25Pct, true);
      const coreHi = fmtVal(s.endUsd.p75, s.endCny.p75, s.endP75Pct, true);
      const extLo = fmtVal(s.endUsd.p10, s.endCny.p10, s.endP10Pct, true);
      const extHi = fmtVal(s.endUsd.p90, s.endCny.p90, s.endP90Pct, true);

      const kpi2Title = isLT ? (hData.shortLabel + '主预测 (P50)') : (hData.horizon + '日主预测 (P50)');
      const kpi2Sub = isLT && s.cagr
        ? ('累计 ' + fmtPct(s.endP50Pct) + ' · 年化 ' + fmtPct(s.cagr.p50) + ' (基线 ' + fmtPct(s.cagr.baselineP50) + ')')
        : ('预期中位 ' + fmtPct(s.endP50Pct) + ' · 综合分 ' + hData.compositeScore);
      const kpi4Sub = isLT
        ? ('中位回撤 ' + fmtPct(s.maxDdP50) + ' · 月波 ' + hData.sampleStats.currentVolPct + '%/月')
        : ('中位回撤 ' + fmtPct(s.maxDdP50) + ' · 日波 ' + hData.sampleStats.currentVolPct + '%/日');
      const kpi5Title = isLT ? (hData.shortLabel + '实证收涨概率') : '期末收涨概率';
      const kpi5Sub = isLT && s.beatCpiProb != null
        ? ('跑赢美国 CPI ' + s.beatCpiProb + '% · ' + hData.sampleStats.rawSampleSize + ' 历史窗口')
        : ('收缩向无条件基准 ' + Math.round(hData.sampleStats.shrinkageWeight * 100) + '%');

      document.getElementById('fc-kpi-grid').innerHTML =
        '<div class="fc-kpi">' +
          '<div class="fc-kpi-label"><span>基准现价</span><span>' + escHtml(currentData.macroLabel || '现货') + '</span></div>' +
          '<div class="fc-kpi-val tone-gold">' + spotStr + '</div>' +
          '<div class="fc-kpi-sub">' + escHtml(spotSub) + '</div>' +
        '</div>' +
        '<div class="fc-kpi">' +
          '<div class="fc-kpi-label"><span>' + escHtml(kpi2Title) + '</span><span>' + escHtml(hData.verdict.label) + '</span></div>' +
          '<div class="fc-kpi-val ' + p50Tone + '">' + endP50Main + '</div>' +
          '<div class="fc-kpi-sub">' + escHtml(kpi2Sub) + '</div>' +
        '</div>' +
        '<div class="fc-kpi">' +
          '<div class="fc-kpi-label"><span>核心区间 P25–P75</span><span>50%落入</span></div>' +
          '<div class="fc-kpi-val" style="font-size:15.5px">' + coreLo + ' ～ ' + coreHi + '</div>' +
          '<div class="fc-kpi-sub">极端带(P10–P90): ' + extLo + ' ～ ' + extHi + '</div>' +
        '</div>' +
        '<div class="fc-kpi">' +
          '<div class="fc-kpi-label"><span>最大回撤风险</span><span>P90不利</span></div>' +
          '<div class="fc-kpi-val tone-bear">' + fmtPct(s.maxDdP90) + '</div>' +
          '<div class="fc-kpi-sub">' + escHtml(kpi4Sub) + '</div>' +
        '</div>' +
        '<div class="fc-kpi">' +
          '<div class="fc-kpi-label"><span>' + escHtml(kpi5Title) + '</span><span>N_eff ' + hData.sampleStats.effectiveSampleSize + '</span></div>' +
          '<div class="fc-kpi-val ' + (s.upEndProb >= 55 ? 'tone-bull' : s.upEndProb <= 45 ? 'tone-bear' : '') + '">' + s.upEndProb + '%</div>' +
          '<div class="fc-kpi-sub">' + escHtml(kpi5Sub) + '</div>' +
        '</div>';

      // 三面依据卡片
      document.getElementById('fc-track-caption').textContent =
        hData.label + ' 权重分配：' + hData.trackName;
      const pList = [pillars.fundamental, pillars.information, pillars.technical];
      document.getElementById('fc-pillars-grid').innerHTML = pList.map(p => {
        const barColor = p.code === 'bullish' ? '#1a7f37' : p.code === 'bearish' ? '#c62828' : '#b8860b';
        const scoreCls = p.code === 'bullish' ? 'tone-bull' : p.code === 'bearish' ? 'tone-bear' : 'tone-gold';
        const mRows = (p.metrics || []).map(m =>
          '<div class="fc-pm-row"><span class="fc-pm-k">' + escHtml(m.k) + '</span><span class="fc-pm-v ' +
          (m.tone === 'bull' ? 'tone-bull' : m.tone === 'bear' ? 'tone-bear' : '') + '">' + escHtml(m.v) + '</span></div>'
        ).join('');
        return '<article class="fc-pillar-card glass-strong">' +
          '<div class="fc-pillar-top">' +
            '<div><div class="fc-pillar-title">' + escHtml(p.title) + '</div><div class="fc-pillar-sub">' + escHtml(p.subtitle) + '</div></div>' +
            '<div class="fc-pillar-score-box">' +
              '<div class="fc-pillar-score ' + scoreCls + '">' + p.score + '<span style="font-size:12px;font-weight:500">/100</span></div>' +
              '<div class="fc-pillar-weight">' + escHtml(p.label) + ' · 权重 ' + p.weightPct + '%</div>' +
            '</div>' +
          '</div>' +
          '<div class="fc-pillar-bar"><div class="fc-pillar-bar-fill" style="width:' + p.score + '%;background:' + barColor + '"></div></div>' +
          '<div class="fc-pillar-metrics">' + mRows + '</div>' +
          '<p class="fc-pillar-summary">' + escHtml(p.summary) + '</p>' +
        '</article>';
      }).join('');

      // 结论溯源与可查证据链（因子审计表 + 长期三情景 + 推翻条件）
      const ev = hData.evidence || null;
      const auditSub = document.getElementById('fc-audit-sub');
      if (auditSub) {
        auditSub.textContent = isLT
          ? ('26年真实月线回测 (' + (hData.sampleStats.monthlySpan || '2000~2026') + ')')
          : ('5年连续日线回测 (' + (currentData.datasetDateRange?.from || '') + ' ～ ' + currentData.asOf + ')');
      }
      const auditTbody = document.getElementById('fc-audit-tbody');
      if (auditTbody && ev?.factorAudit?.length) {
        auditTbody.innerHTML = ev.factorAudit.map(row =>
          '<tr>' +
            '<td><div class="fc-audit-factor">' + escHtml(row.factor) + '</div><div class="fc-audit-mech">' + escHtml(row.mechanism) + '</div></td>' +
            '<td class="fc-audit-val">' + escHtml(row.currentValue) + '</td>' +
            '<td class="fc-audit-src">' + escHtml(row.sourceDate) + '</td>' +
            '<td class="fc-audit-pct">' + escHtml(row.percentile25y) + '</td>' +
            '<td><span class="fc-imp-badge ' + escHtml(row.impact) + '">' + escHtml(row.impactLabel) + '</span></td>' +
            '<td class="fc-audit-emp">' + escHtml(row.empiricalStat) + '</td>' +
          '</tr>'
        ).join('');
      }

      const scWrap = document.getElementById('fc-scenarios-wrap');
      const scGrid = document.getElementById('fc-scenarios-grid');
      if (scWrap && scGrid) {
        if (ev?.scenarios?.length) {
          scWrap.style.display = '';
          scGrid.innerHTML = ev.scenarios.map(sc => {
            const pText = fmtVal(sc.targetUsd, sc.targetCny, sc.targetPct, false);
            const tone = sc.key === 'bull' ? 'tone-bull' : sc.key === 'bear' ? 'tone-bear' : 'tone-gold';
            return '<article class="fc-sc-card glass-strong ' + escHtml(sc.key) + '">' +
              '<div class="fc-sc-head">' +
                '<div class="fc-sc-title">' + escHtml(sc.title) + '</div>' +
                '<span class="fc-sc-prob">概率 ~' + sc.probPct + '%</span>' +
              '</div>' +
              '<div class="fc-sc-target">' +
                '<span class="fc-sc-price ' + tone + '">' + escHtml(pText) + '</span>' +
                '<span class="fc-sc-cagr">累计 ' + fmtPct(sc.targetPct) + ' · 年化 ' + fmtPct(sc.cagrPct) + '</span>' +
              '</div>' +
              '<div class="fc-sc-trigger"><strong>触发条件：</strong>' + escHtml(sc.trigger) + '</div>' +
              '<div class="fc-sc-stance">💡 配置纪律：' + escHtml(sc.stance) + '</div>' +
            '</article>';
          }).join('');
        } else {
          scWrap.style.display = 'none';
          scGrid.innerHTML = '';
        }
      }

      const trigGrid = document.getElementById('fc-triggers-grid');
      if (trigGrid && ev?.invalidationTriggers?.length) {
        trigGrid.innerHTML = ev.invalidationTriggers.map(tr =>
          '<div class="fc-trig-item">' +
            '<div class="fc-trig-top">' +
              '<span class="fc-trig-metric">' + escHtml(tr.metric) + '</span>' +
              '<span class="fc-trig-cur">当前 ' + escHtml(tr.current) + '</span>' +
            '</div>' +
            '<div class="fc-trig-cond">触发线：' + escHtml(tr.trigger) + '</div>' +
            '<div class="fc-trig-mean">' + escHtml(tr.meaning) + '</div>' +
          '</div>'
        ).join('');
      }
      const methodEl = document.getElementById('fc-method-note');
      if (methodEl) {
        methodEl.textContent = ev?.methodologyNote || '';
      }

      // 关键支撑/压力位表
      document.getElementById('fc-levels-sub').textContent = isLT
        ? ('未来 ' + hData.shortLabel + ' (' + hData.months + '个月) 历史触达频率')
        : ('未来 ' + hData.horizon + ' 个交易日历史触达频率');
      document.getElementById('fc-levels-tbody').innerHTML = (hData.structure || []).map(l => {
        const pStr = currentUnit === 'usd'
          ? '$' + l.priceUsd.toFixed(1)
          : currentUnit === 'cny'
            ? '¥' + l.priceCny.toFixed(2)
            : fmtPct(l.pctFromSpot);
        const badge = l.kind === 'resistance'
          ? '<span class="fc-tag res">压力位</span>'
          : '<span class="fc-tag sup">支撑位</span>';
        return '<tr>' +
          '<td class="txt">' + escHtml(l.label) + '</td>' +
          '<td>' + badge + '</td>' +
          '<td>' + pStr + '</td>' +
          '<td class="' + (l.pctFromSpot >= 0 ? 'tone-bull' : 'tone-bear') + '">' + fmtPct(l.pctFromSpot) + '</td>' +
          '<td>' + (l.touchProb != null ? l.touchProb + '%' : '—') + '</td>' +
        '</tr>';
      }).join('') || '<tr><td colspan="5" class="txt" style="color:var(--text-2)">历史数据积累中</td></tr>';

      // 历史最相似样本表（长期模式展示独立周期起点、宏观快照、真实涨幅/年化/最大回撤）
      const analogs = hData.topAnalogs || [];
      const analogsTitle = document.getElementById('fc-analogs-title');
      const analogsThead = document.getElementById('fc-analogs-thead');
      if (isLT) {
        if (analogsTitle) analogsTitle.innerHTML = '历史最相似宏观周期起点（独立周期实证） <small id="fc-analogs-sub">严格间隔 ≥12个月 · 零前视</small>';
        if (analogsThead) analogsThead.innerHTML = '<tr><th>起点月份与宏观背景</th><th>相似度</th><th>事后 ' + escHtml(hData.shortLabel) + ' 实盘</th><th>最大回撤</th></tr>';
        document.getElementById('fc-analogs-tbody').innerHTML = analogs.length
          ? analogs.map(a =>
              '<tr>' +
                '<td class="txt">' +
                  '<div style="font-family:var(--mono);font-weight:700">' + escHtml(a.date) + ' → ' + escHtml(a.endDate || '') + '</div>' +
                  '<div class="fc-analog-era">' + escHtml(a.eraLabel || '') + '</div>' +
                  '<div class="fc-analog-snap">' + escHtml(a.macroSnap || '') + '</div>' +
                '</td>' +
                '<td>' + a.similarity + '%</td>' +
                '<td class="' + (a.rawEndPct >= 0 ? 'tone-bull' : 'tone-bear') + '">' +
                  '<div>' + fmtPct(a.rawEndPct) + '</div>' +
                  '<div style="font-size:10.5px;color:var(--text-2)">年化 ' + fmtPct(a.cagrPct) + '</div>' +
                '</td>' +
                '<td class="tone-bear">' + fmtPct(a.maxDdPct) + '</td>' +
              '</tr>'
            ).join('')
          : '<tr><td colspan="4" class="txt" style="color:var(--text-2)">暂无足够历史周期样本</td></tr>';
      } else {
        if (analogsTitle) analogsTitle.innerHTML = '历史最相似交易日（可审计样本） <small id="fc-analogs-sub">严格零前视泄漏</small>';
        if (analogsThead) analogsThead.innerHTML = '<tr><th>历史日期</th><th>相似度</th><th>当时走势</th><th>FHS 波动缩放后</th></tr>';
        document.getElementById('fc-analogs-tbody').innerHTML = analogs.length
          ? analogs.map(a =>
              '<tr>' +
                '<td>' + (a.filename ? '<a href="/' + escHtml(a.filename) + '">' + escHtml(a.date) + '</a>' : escHtml(a.date)) + '</td>' +
                '<td>' + a.similarity + '%</td>' +
                '<td class="' + (a.rawEndPct >= 0 ? 'tone-bull' : 'tone-bear') + '">' + fmtPct(a.rawEndPct) + '</td>' +
                '<td class="' + (a.scaledEndPct >= 0 ? 'tone-bull' : 'tone-bear') + '">' + fmtPct(a.scaledEndPct) + ' <span style="color:var(--text-3);font-size:10px">(×' + a.volScale + ')</span></td>' +
              '</tr>'
            ).join('')
          : '<tr><td colspan="4" class="txt" style="color:var(--text-2)">采用严格因果 FHS 分块波动模拟</td></tr>';
      }

      document.getElementById('fc-fhs-meta').innerHTML = isLT
        ? ('<span>24月实现月波动率 σ_m = <strong>' + hData.sampleStats.currentVolPct + '%/月</strong>（年化 ' + hData.sampleStats.annualizedVolPct + '%）</span>' +
           '<span>独立有效样本 N_eff = <strong>' + hData.sampleStats.effectiveSampleSize + '</strong>（完整窗口 ' + hData.sampleStats.rawSampleSize + ' 月）</span>' +
           '<span>向25年基准收缩 λ = <strong>' + Math.round(hData.sampleStats.shrinkageWeight * 100) + '%</strong></span>')
        : ('<span>FHS 日波动率 σ₀ = <strong>' + hData.sampleStats.currentVolPct + '%</strong>（年化 ' + hData.sampleStats.annualizedVolPct + '%）</span>' +
           '<span>有效独立样本 N_eff = <strong>' + hData.sampleStats.effectiveSampleSize + '</strong>（原始 ' + hData.sampleStats.rawSampleSize + '）</span>' +
           '<span>贝叶斯收缩 λ = <strong>' + Math.round(hData.sampleStats.shrinkageWeight * 100) + '%</strong></span>');

      renderChart();
    }

    function renderChart() {
      const svg = document.getElementById('fc-chart-svg');
      const hData = currentData.horizons[currentHorizon];
      const isLT = Boolean(hData.isLongTerm);
      let hist;
      if (isLT && currentData.historyByHorizon && currentData.historyByHorizon[currentHorizon]) {
        hist = currentData.historyByHorizon[currentHorizon];
      } else {
        const histAll = currentData.history || [];
        const histWindow = currentHorizon === '5' ? 35 : currentHorizon === '20' ? 50 : 60;
        hist = histAll.slice(-histWindow);
      }
      const pts = hData.points || [];
      const replay = (showReplay && hData.actualReplay) ? hData.actualReplay : [];
      document.getElementById('leg-replay').style.display = replay.length ? 'inline-flex' : 'none';

      const W = 1040, H = 400;
      const padL = 74, padR = 160, padT = 28, padB = 38;
      const innerW = W - padL - padR;
      const innerH = H - padT - padB;

      const histVals = hist.map(pickHistVal);
      const maVals = showMa20 ? hist.map(pickMaVal).filter(v => v != null) : [];
      const futVals = [];
      for (const p of pts) {
        futVals.push(pickSeriesVal(p, 'p10'), pickSeriesVal(p, 'p90'), pickSeriesVal(p, 'p50'), pickSeriesVal(p, 'baselineP50'));
      }
      for (const r of replay) futVals.push(pickReplayVal(r));
      for (const lv of (hData.structure || [])) {
        futVals.push(currentUnit === 'usd' ? lv.priceUsd : currentUnit === 'cny' ? lv.priceCny : lv.pctFromSpot);
      }

      const allY = histVals.concat(maVals, futVals).filter(v => Number.isFinite(v));
      let minY = Math.min.apply(null, allY);
      let maxY = Math.max.apply(null, allY);
      const span = (maxY - minY) || 1;
      minY -= span * 0.08;
      maxY += span * 0.08;
      const rangeY = maxY - minY || 1;

      const histN = hist.length;
      const futN = pts.length;
      const totalSteps = Math.max(1, (histN - 1) + futN);
      const pivotIdx = histN - 1;

      const toX = (i) => padL + (i / totalSteps) * innerW;
      const toY = (v) => padT + innerH - ((v - minY) / rangeY) * innerH;

      const fmtAxis = (v) => {
        if (currentUnit === 'usd') return '$' + Math.round(v);
        if (currentUnit === 'cny') return '¥' + v.toFixed(0);
        return (v >= 0 ? '+' : '') + v.toFixed(isLT ? 0 : 1) + '%';
      };

      // 网格与 Y 轴
      let out = '<defs>' +
        '<linearGradient id="fanOuterGrad" x1="0" y1="0" x2="1" y2="0">' +
          '<stop offset="0%" stop-color="#b8860b" stop-opacity="0.16"/>' +
          '<stop offset="100%" stop-color="#b8860b" stop-opacity="0.09"/>' +
        '</linearGradient>' +
        '<linearGradient id="fanCoreGrad" x1="0" y1="0" x2="1" y2="0">' +
          '<stop offset="0%" stop-color="#b8860b" stop-opacity="0.34"/>' +
          '<stop offset="100%" stop-color="#b8860b" stop-opacity="0.20"/>' +
        '</linearGradient>' +
        '<linearGradient id="histAreaGrad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="#334155" stop-opacity="0.12"/>' +
          '<stop offset="100%" stop-color="#334155" stop-opacity="0.0"/>' +
        '</linearGradient>' +
      '</defs>';

      // 未来区域淡底色，视觉一眼区分「历史 vs 未来预测」
      const pivotX = toX(pivotIdx);
      out += '<rect x="' + pivotX.toFixed(1) + '" y="' + padT + '" width="' + (W - padR - pivotX).toFixed(1) + '" height="' + innerH + '" fill="rgba(184,134,11,0.035)"/>';

      // 水平网格线
      const yTicks = 5;
      for (let t = 0; t <= yTicks; t++) {
        const val = minY + (rangeY * t) / yTicks;
        const y = toY(val);
        out += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" stroke="rgba(15,23,42,0.08)" stroke-width="1"/>';
        out += '<text x="' + (padL - 10) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" fill="#64748b" font-size="11" font-family="var(--mono)">' + fmtAxis(val) + '</text>';
      }

      // 动态支撑/压力水平线（右侧标签独立留白，防重叠微调）
      const placedLabelY = [];
      for (const lv of (hData.structure || [])) {
        const lvVal = currentUnit === 'usd' ? lv.priceUsd : currentUnit === 'cny' ? lv.priceCny : lv.pctFromSpot;
        const y = toY(lvVal);
        if (y < padT - 4 || y > H - padB + 4) continue;
        const col = lv.kind === 'resistance' ? '#ea580c' : '#16a34a';
        out += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" stroke="' + col + '" stroke-width="1" stroke-dasharray="5 4" opacity="0.55"/>';
        let ly = y;
        for (const py of placedLabelY) {
          if (Math.abs(ly - py) < 15) ly = py + 15;
        }
        placedLabelY.push(ly);
        const shortName = lv.label.split(' (')[0];
        const tagText = shortName + ' ' + fmtAxis(lvVal);
        out += '<text x="' + (W - padR + 8) + '" y="' + (ly + 3.5).toFixed(1) + '" fill="' + col + '" font-size="10.5" font-weight="600" font-family="var(--mono)">' + escHtml(tagText) + '</text>';
      }

      // 历史面积 + 折线
      if (hist.length >= 2) {
        const hCoords = hist.map((h, i) => toX(i).toFixed(1) + ',' + toY(pickHistVal(h)).toFixed(1));
        const areaPts = hCoords.concat([
          toX(pivotIdx).toFixed(1) + ',' + (padT + innerH).toFixed(1),
          toX(0).toFixed(1) + ',' + (padT + innerH).toFixed(1),
        ]).join(' ');
        out += '<polygon points="' + areaPts + '" fill="url(#histAreaGrad)"/>';
        out += '<polyline fill="none" stroke="#334155" stroke-width="2.2" stroke-linejoin="round" points="' + hCoords.join(' ') + '"/>';
      }

      // MA20 / MA12 虚线
      if (showMa20) {
        const maCoords = [];
        for (let i = 0; i < hist.length; i++) {
          const mv = pickMaVal(hist[i]);
          if (mv != null) maCoords.push(toX(i).toFixed(1) + ',' + toY(mv).toFixed(1));
        }
        if (maCoords.length >= 2) {
          out += '<polyline fill="none" stroke="#007aff" stroke-width="1.3" stroke-dasharray="4 3" opacity="0.7" points="' + maCoords.join(' ') + '"/>';
        }
      }

      // 今日锚点（无缝衔接未来扇形）
      const spotYVal = pickHistVal(hist[pivotIdx]);
      const buildFanPoly = (hiKey, loKey) => {
        const top = [[pivotX, toY(spotYVal)]].concat(pts.map((p, i) => [toX(pivotIdx + 1 + i), toY(pickSeriesVal(p, hiKey))]));
        const bot = pts.slice().reverse().map((p, i) => [toX(pivotIdx + pts.length - i), toY(pickSeriesVal(p, loKey))]).concat([[pivotX, toY(spotYVal)]]);
        return top.concat(bot).map(xy => xy[0].toFixed(1) + ',' + xy[1].toFixed(1)).join(' ');
      };

      if (pts.length > 0) {
        out += '<polygon points="' + buildFanPoly('p90', 'p10') + '" fill="url(#fanOuterGrad)"/>';
        out += '<polygon points="' + buildFanPoly('p75', 'p25') + '" fill="url(#fanCoreGrad)"/>';

        const linePts = (key) => [[pivotX, toY(spotYVal)]]
          .concat(pts.map((p, i) => [toX(pivotIdx + 1 + i), toY(pickSeriesVal(p, key))]))
          .map(xy => xy[0].toFixed(1) + ',' + xy[1].toFixed(1)).join(' ');

        out += '<polyline fill="none" stroke="rgba(184,134,11,0.45)" stroke-width="1" stroke-dasharray="3 3" points="' + linePts('p90') + '"/>';
        out += '<polyline fill="none" stroke="rgba(184,134,11,0.45)" stroke-width="1" stroke-dasharray="3 3" points="' + linePts('p10') + '"/>';
        out += '<polyline fill="none" stroke="#64748b" stroke-width="1.3" stroke-dasharray="5 4" opacity="0.8" points="' + linePts('baselineP50') + '"/>';
        out += '<polyline fill="none" stroke="#b8860b" stroke-width="2.8" stroke-linejoin="round" points="' + linePts('p50') + '"/>';

        const lastP = pts[pts.length - 1];
        const endX = toX(pivotIdx + pts.length);
        const endY = toY(pickSeriesVal(lastP, 'p50'));
        out += '<circle cx="' + endX.toFixed(1) + '" cy="' + endY.toFixed(1) + '" r="4.5" fill="#b8860b" stroke="#fff" stroke-width="1.5"/>';
      }

      // 可选：叠加事后真实走势（历史日复盘）
      if (replay.length > 0) {
        const repPts = [[pivotX, toY(spotYVal)]]
          .concat(replay.map(r => [toX(pivotIdx + r.h), toY(pickReplayVal(r))]))
          .map(xy => xy[0].toFixed(1) + ',' + xy[1].toFixed(1)).join(' ');
        out += '<polyline data-series="replay" fill="none" stroke="#16a34a" stroke-width="2.4" stroke-linejoin="round" points="' + repPts + '"/>';
        const lastR = replay[replay.length - 1];
        out += '<circle cx="' + toX(pivotIdx + lastR.h).toFixed(1) + '" cy="' + toY(pickReplayVal(lastR)).toFixed(1) + '" r="4" fill="#16a34a" stroke="#fff" stroke-width="1.5"/>';
      }

      // 今日垂直分割线 & 基准圆点
      out += '<line x1="' + pivotX.toFixed(1) + '" y1="' + padT + '" x2="' + pivotX.toFixed(1) + '" y2="' + (H - padB) + '" stroke="#0f172a" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.5"/>';
      out += '<circle cx="' + pivotX.toFixed(1) + '" cy="' + toY(spotYVal).toFixed(1) + '" r="4.5" fill="#0f172a" stroke="#fff" stroke-width="1.8"/>';
      out += '<text x="' + pivotX.toFixed(1) + '" y="' + (padT - 9) + '" text-anchor="middle" fill="#0f172a" font-size="11" font-weight="700">' + (isLT ? ('当前 ' + escHtml(currentData.asOf.slice(0, 7))) : ('今天 ' + escHtml(currentData.asOf.slice(5)))) + '</text>';

      // X 轴时间刻度（长期模式显示真实 YYYY-MM，日线模式显示 MM-DD 与 T+N日）
      const midFutIdx = Math.ceil(futN / 2);
      const xLabels = isLT
        ? [
            { i: 0, text: hist[0].date },
            { i: Math.floor(pivotIdx / 2), text: hist[Math.floor(pivotIdx / 2)].date },
            { i: pivotIdx, text: currentData.asOf.slice(0, 7) },
            { i: pivotIdx + midFutIdx, text: pts[midFutIdx - 1]?.ym || ('+' + midFutIdx + '月') },
            { i: pivotIdx + futN, text: pts[futN - 1]?.ym || ('+' + futN + '月') },
          ]
        : [
            { i: 0, text: hist[0].date.slice(5) },
            { i: Math.floor(pivotIdx / 2), text: hist[Math.floor(pivotIdx / 2)].date.slice(5) },
            { i: pivotIdx, text: 'T+0' },
            { i: pivotIdx + midFutIdx, text: 'T+' + midFutIdx + '日' },
            { i: pivotIdx + futN, text: 'T+' + futN + '日' },
          ];
      for (const xl of xLabels) {
        out += '<text x="' + toX(xl.i).toFixed(1) + '" y="' + (H - 12) + '" text-anchor="middle" fill="#64748b" font-size="11" font-family="var(--mono)">' + escHtml(xl.text) + '</text>';
      }

      // 交互准星占位层
      out += '<g id="fc-crosshair" style="display:none">' +
        '<line id="fc-ch-line" x1="0" y1="' + padT + '" x2="0" y2="' + (H - padB) + '" stroke="#007aff" stroke-width="1" stroke-dasharray="3 3" opacity="0.75"/>' +
        '<circle id="fc-ch-dot" cx="0" cy="0" r="5" fill="#007aff" stroke="#fff" stroke-width="2"/>' +
      '</g>';
      out += '<rect id="fc-hit-layer" x="' + padL + '" y="' + padT + '" width="' + innerW + '" height="' + innerH + '" fill="transparent" style="cursor:crosshair"/>';

      svg.innerHTML = out;

      // 构造悬停采样点
      hoverPoints = [];
      for (let i = 0; i < hist.length; i++) {
        hoverPoints.push({
          kind: 'history',
          isLT,
          x: toX(i),
          y: toY(pickHistVal(hist[i])),
          data: hist[i],
        });
      }
      const replayByH = new Map(replay.map(r => [r.h, r]));
      for (let i = 0; i < pts.length; i++) {
        hoverPoints.push({
          kind: 'forecast',
          isLT,
          x: toX(pivotIdx + 1 + i),
          y: toY(pickSeriesVal(pts[i], 'p50')),
          data: pts[i],
          replay: replayByH.get(pts[i].h) || null,
        });
      }

      document.getElementById('fc-chart-meta-inline').textContent = isLT
        ? '悬停图表查看各未来月份目标区间与隐含年化 (CAGR)'
        : '悬停图表查看每日预期价位与区间';

      bindChartHover(W);
    }

    function bindChartHover(svgW) {
      const hit = document.getElementById('fc-hit-layer');
      const svg = document.getElementById('fc-chart-svg');
      const stage = document.getElementById('fc-chart-stage');
      const tip = document.getElementById('fc-tooltip');
      const ch = document.getElementById('fc-crosshair');
      const chLine = document.getElementById('fc-ch-line');
      const chDot = document.getElementById('fc-ch-dot');
      if (!hit || !svg) return;

      const onMove = (evt) => {
        const rect = svg.getBoundingClientRect();
        const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
        const svgX = ((clientX - rect.left) / rect.width) * svgW;
        let best = null;
        let bestDist = Infinity;
        for (const p of hoverPoints) {
          const d = Math.abs(p.x - svgX);
          if (d < bestDist) { bestDist = d; best = p; }
        }
        if (!best) return;

        ch.style.display = '';
        chLine.setAttribute('x1', best.x.toFixed(1));
        chLine.setAttribute('x2', best.x.toFixed(1));
        chDot.setAttribute('cx', best.x.toFixed(1));
        chDot.setAttribute('cy', best.y.toFixed(1));

        if (best.kind === 'history') {
          const h = best.data;
          tip.innerHTML =
            '<div class="fc-tooltip-head"><span>' + escHtml(h.date) + '</span><span>' + (best.isLT ? '历史月末' : '历史收盘') + '</span></div>' +
            '<div class="fc-tooltip-row"><span>伦敦金</span><strong>$' + h.usd.toFixed(1) + '/oz</strong></div>' +
            '<div class="fc-tooltip-row"><span>国内折算</span><strong>¥' + h.cny.toFixed(2) + '/g</strong></div>' +
            '<div class="fc-tooltip-row"><span>相对今日</span><strong>' + fmtPct(h.pct) + '</strong></div>';
        } else {
          const p = best.data;
          const headTitle = best.isLT
            ? ((p.ym || ('+' + p.h + '月')) + ' (第' + p.h + '月)')
            : ('未来第 ' + p.h + ' 交易日');
          let html =
            '<div class="fc-tooltip-head"><span>' + escHtml(headTitle) + '</span><span>预测分布</span></div>' +
            '<div class="fc-tooltip-row"><span>主预测 (P50)</span><strong class="' + (p.p50 >= 0 ? 'tone-bull' : 'tone-bear') + '">' + fmtVal(p.usd.p50, p.cny.p50, p.p50, false) + ' (' + fmtPct(p.p50) + ')</strong></div>';
          if (best.isLT && p.cagrP50 != null && p.h >= 6) {
            html += '<div class="fc-tooltip-row"><span>隐含年化 (CAGR)</span><strong>' + fmtPct(p.cagrP50) + '</strong></div>';
          }
          html +=
            '<div class="fc-tooltip-row"><span>核心区间 (P25–P75)</span><strong>' + fmtVal(p.usd.p25, p.cny.p25, p.p25, true) + ' ～ ' + fmtVal(p.usd.p75, p.cny.p75, p.p75, true) + '</strong></div>' +
            '<div class="fc-tooltip-row"><span>极端区间 (P10–P90)</span><strong>' + fmtVal(p.usd.p10, p.cny.p10, p.p10, true) + ' ～ ' + fmtVal(p.usd.p90, p.cny.p90, p.p90, true) + '</strong></div>';
          if (best.replay) {
            const r = best.replay;
            html += '<div class="fc-tooltip-row" style="border-top:0.5px solid var(--hairline);padding-top:4px;margin-top:5px"><span>事后实盘 (' + escHtml(best.isLT ? r.date : r.date.slice(5)) + ')</span><strong class="tone-bull">' + fmtVal(r.usd, r.cny, r.pct, false) + ' (' + fmtPct(r.pct) + ')</strong></div>';
          }
          tip.innerHTML = html;
        }

        tip.style.display = 'block';
        const stageRect = stage.getBoundingClientRect();
        const relX = clientX - stageRect.left;
        const tipW = tip.offsetWidth || 220;
        const left = relX + 18 + tipW > stageRect.width ? Math.max(10, relX - tipW - 18) : relX + 18;
        tip.style.left = left + 'px';
        tip.style.top = '18px';
      };

      const onLeave = () => {
        ch.style.display = 'none';
        tip.style.display = 'none';
      };

      hit.addEventListener('mousemove', onMove);
      hit.addEventListener('touchmove', onMove, { passive: true });
      hit.addEventListener('mouseleave', onLeave);
      hit.addEventListener('touchend', onLeave);
    }

    function escHtml(s) {
      return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    renderAll();
  </script>
</body>
</html>`;
}

module.exports = { renderForecastPage };
