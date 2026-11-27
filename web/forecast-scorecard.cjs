'use strict';

/**
 * GoldRush v2.6 — `/forecast` 历史实盘校准成绩单引擎与渲染模块（严格零前视泄漏）
 *
 * 在近 90 个交易日回放窗口内，对过去已走完 5D / 20D 实盘的决策日执行严格因果评估：
 *   - P10–P90 区间实盘覆盖率（目标 75%–85%）
 *   - CRPS 概率扇面评分与相对无条件基准的 CRPSS 提升
 *   - 中位数方向胜率（带 HAC 修正 Wilson 95% 置信区间）
 *   - v2.5/v2.6 消息面防钓鱼拦截与噪音滤除计数
 */

const { evaluateProbFanCalibration } = require('./prob-calibration.cjs');
const { auditDailyTransmissionVeracity } = require('./news-veracity.cjs');

let _scorecardCacheKey = null;
let _scorecardCacheVal = null;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 计算近 lookbackTradingDays 交易日内的严格零前视实盘校准成绩单（带内存缓存）。
 * 为控制 CPU 开销，5D 最多抽样最近 36 个已走完交易日（步长 2），20D 最多抽样 24 个已走完交易日（步长 3）。
 */
function buildForecastScorecard(records, buildDailyGoldForecastFn, options = {}) {
  if (!Array.isArray(records) || records.length < 30) return null;

  const lookback = options.lookbackTradingDays ?? 90;
  const latestDate = records[records.length - 1]?.date || '';
  const cacheKey = `${records.length}|${latestDate}|${lookback}`;
  if (!options.noCache && _scorecardCacheKey === cacheKey && _scorecardCacheVal) {
    return _scorecardCacheVal;
  }

  const n = records.length;
  const startIdx = Math.max(25, n - lookback);
  const samples5d = [];
  const samples20d = [];

  // 统计近 lookback 日内消息面防钓鱼与噪音拦截情况
  const newsAuditCounts = {
    totalAiDays: 0,
    confirmed: 0,
    baitSuspected: 0,
    noiseFiltered: 0,
    quiet: 0,
  };
  for (let i = startIdx; i < n; i++) {
    const rec = records[i];
    if (rec.hasAiReport) newsAuditCounts.totalAiDays++;
    const prev = i > 0 ? records[i - 1] : null;
    const audit = auditDailyTransmissionVeracity(rec, null, prev);
    if (audit.status === 'confirmed') newsAuditCounts.confirmed++;
    else if (audit.status === 'bait_suspected') newsAuditCounts.baitSuspected++;
    else if (audit.status === 'noise_filtered') newsAuditCounts.noiseFiltered++;
    else newsAuditCounts.quiet++;
  }

  // 5D 已验证样本（间隔步长 2，既保证统计量充足又控制在 <60ms 完成）
  const maxIdx5 = n - 6;
  for (let i = startIdx; i <= maxIdx5; i += 2) {
    const date = records[i].date;
    const fc = buildDailyGoldForecastFn(records, date, []);
    const h5 = fc?.horizons?.[5];
    const replay = h5?.actualReplay;
    if (!h5?.summary || !Array.isArray(replay) || replay.length < 5) continue;
    const actualPct = replay[4].pct;
    const bq = h5.summary.baselineQuantiles || null;
    samples5d.push({
      date,
      p10: h5.summary.endP10Pct,
      p25: h5.summary.endP25Pct,
      p50: h5.summary.endP50Pct,
      p75: h5.summary.endP75Pct,
      p90: h5.summary.endP90Pct,
      baselineP10: bq?.p10 ?? null,
      baselineP25: bq?.p25 ?? null,
      baselineP50: bq?.p50 ?? null,
      baselineP75: bq?.p75 ?? null,
      baselineP90: bq?.p90 ?? null,
      actualPct,
    });
  }

  // 20D 已验证样本（步长 3）
  const maxIdx20 = n - 21;
  for (let i = Math.max(25, n - Math.max(lookback, 110)); i <= maxIdx20; i += 3) {
    const date = records[i].date;
    const fc = buildDailyGoldForecastFn(records, date, []);
    const h20 = fc?.horizons?.[20];
    const replay = h20?.actualReplay;
    if (!h20?.summary || !Array.isArray(replay) || replay.length < 20) continue;
    const actualPct = replay[19].pct;
    const bq = h20.summary.baselineQuantiles || null;
    samples20d.push({
      date,
      p10: h20.summary.endP10Pct,
      p25: h20.summary.endP25Pct,
      p50: h20.summary.endP50Pct,
      p75: h20.summary.endP75Pct,
      p90: h20.summary.endP90Pct,
      baselineP10: bq?.p10 ?? null,
      baselineP25: bq?.p25 ?? null,
      baselineP50: bq?.p50 ?? null,
      baselineP75: bq?.p75 ?? null,
      baselineP90: bq?.p90 ?? null,
      actualPct,
    });
  }

  const report5d = evaluateProbFanCalibration(samples5d, 5);
  const report20d = evaluateProbFanCalibration(samples20d, 20);

  const result = {
    windowTradingDays: lookback,
    asOfLatestDate: latestDate,
    horizon5d: report5d,
    horizon20d: report20d,
    newsAuditCounts,
  };

  if (!options.noCache) {
    _scorecardCacheKey = cacheKey;
    _scorecardCacheVal = result;
  }
  return result;
}

function clearScorecardCache() {
  _scorecardCacheKey = null;
  _scorecardCacheVal = null;
}

/** 渲染 `/forecast` 页面的历史实盘校准成绩单 HTML */
function renderForecastScorecardHtml(scorecard, sourceHealth = []) {
  if (!scorecard) return '';

  const renderTile = (title, rep) => {
    const covCls = rep.calibrationVerdict === 'well_calibrated'
      ? 'good'
      : rep.calibrationVerdict === 'insufficient'
        ? 'neutral'
        : 'warn';
    const covStr = rep.coverage80Pct != null ? `${rep.coverage80Pct}%` : '—';
    const crpsStr = rep.meanCrps != null ? `${rep.meanCrps.toFixed(2)}%` : '—';
    const crpssStr = rep.crpss != null
      ? `${rep.crpss >= 0 ? '+' : ''}${(rep.crpss * 100).toFixed(1)}%`
      : '—';
    const dirStr = rep.directionHitRatePct != null
      ? `${rep.directionHitRatePct}% (${rep.directionHits}/${rep.directionTotal})`
      : '—';
    const ciStr = rep.directionWilson95
      ? `95%CI ${rep.directionWilson95.lowPct}%–${rep.directionWilson95.highPct}%`
      : '样本积累中';

    return `<div class="fc-cal-card">
      <div class="fc-cal-head">
        <span class="fc-cal-title">${esc(title)}</span>
        <span class="fc-cal-badge ${covCls}">${esc(rep.calibrationLabel)}</span>
      </div>
      <div class="fc-cal-metrics">
        <div class="fc-cal-m">
          <div class="fc-cal-k">P10–P90 区间覆盖</div>
          <div class="fc-cal-v">${esc(covStr)}</div>
          <div class="fc-cal-s">目标 75%–85% · 样本 ${rep.sampleCount}</div>
        </div>
        <div class="fc-cal-m">
          <div class="fc-cal-k">CRPS 扇面误差</div>
          <div class="fc-cal-v">${esc(crpsStr)}</div>
          <div class="fc-cal-s">较基准 CRPSS ${esc(crpssStr)}</div>
        </div>
        <div class="fc-cal-m">
          <div class="fc-cal-k">中位数方向胜率</div>
          <div class="fc-cal-v">${esc(dirStr)}</div>
          <div class="fc-cal-s">${esc(ciStr)}</div>
        </div>
      </div>
    </div>`;
  };

  const na = scorecard.newsAuditCounts || {};
  const openSources = (sourceHealth || []).filter(s => s.state === 'open');
  const healthBadge = openSources.length > 0
    ? `<span class="fc-cal-health warn">⚡ 熔断保护中: ${esc(openSources.map(s => `${s.source}(${s.cooldownRemainingSec}s)`).join(', '))}</span>`
    : `<span class="fc-cal-health ok">● 外部数据源熔断器正常</span>`;

  return `<section class="fc-scorecard-panel glass-strong" id="fc-scorecard-panel" aria-label="历史实盘校准成绩单">
    <div class="fc-cal-topbar">
      <div>
        <h3 class="fc-cal-main-title">🏅 历史实盘校准成绩单 <small>近 ${scorecard.windowTradingDays} 交易日 · 严格零前视回放</small></h3>
      </div>
      <div class="fc-cal-right-meta">
        <span class="fc-cal-news-pill">🛡️ 防钓鱼审计：实证 ${na.confirmed || 0} 天 · 拦截钓鱼 ${na.baitSuspected || 0} 天 · 滤除噪音 ${na.noiseFiltered || 0} 天</span>
        ${healthBadge}
      </div>
    </div>
    <div class="fc-cal-grid">
      ${renderTile('5 交易日预测校准', scorecard.horizon5d)}
      ${renderTile('20 交易日预测校准', scorecard.horizon20d)}
    </div>
  </section>`;
}

module.exports = {
  buildForecastScorecard,
  clearScorecardCache,
  renderForecastScorecardHtml,
};
