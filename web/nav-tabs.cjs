'use strict';

/**
 * 顶部主功能 Tab 切换条（分析报告 | 走势预测）
 * 适配 GoldRush macOS Liquid Glass 浅色风格
 * @param {'reports'|'forecast'} activeTab
 * @param {string} [dateHint] 可选日期，用于从文章页直达当日预测图
 */
function renderAppTabs(activeTab, dateHint) {
  const forecastHref = dateHint ? `/forecast?date=${encodeURIComponent(dateHint)}` : '/forecast';
  return `<nav class="app-tabs" aria-label="主功能切换">
    <div class="app-tabs-inner">
      <a href="/" class="app-tab ${activeTab === 'reports' ? 'active' : ''}" ${activeTab === 'reports' ? 'aria-current="page"' : ''}>
        <span class="app-tab-ico" aria-hidden="true">📊</span>
        <span>分析报告</span>
      </a>
      <a href="${forecastHref}" class="app-tab ${activeTab === 'forecast' ? 'active' : ''}" ${activeTab === 'forecast' ? 'aria-current="page"' : ''}>
        <span class="app-tab-ico" aria-hidden="true">📈</span>
        <span>走势预测</span>
      </a>
    </div>
  </nav>`;
}

module.exports = { renderAppTabs };
