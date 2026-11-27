'use strict';

/**
 * GoldRush v2.6 — Web 报告站目录索引缓存与按月分组模块（从 server.cjs 拆分）
 *
 * 解决随着 docs/ 日报突破百篇后，每次访问首页都同步扫描并读取全量 Markdown 文件的性能瓶颈。
 * 通过对目录 mtime + 全部 .md/.meta.json 文件数与最大 mtime 构造轻量指纹，
 * 命中缓存时直接返回内存索引；任一文件新增/修改/删除时自动失效重建。
 */

const fs = require('node:fs');
const path = require('node:path');

function extractFileDate(filename) {
  const m = String(filename || '').match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function extractFileMonth(filename) {
  const d = extractFileDate(filename);
  return d ? d.slice(0, 7) : '';
}

function sortMarkdownFiles(files) {
  return files
    .filter(f => f.endsWith('.md'))
    .sort((a, b) => {
      const da = extractFileDate(a);
      const db = extractFileDate(b);
      if (da && !db) return -1;
      if (!da && db) return 1;
      if (da && db && da !== db) return db.localeCompare(da);
      return b.localeCompare(a);
    });
}

/** 计算 docs 目录轻量签名（目录 mtime + md/meta 文件计数与最新 mtime） */
function computeDocsSignature(docsDir) {
  const dirStat = fs.statSync(docsDir);
  const allFiles = fs.readdirSync(docsDir);
  const mdFiles = sortMarkdownFiles(allFiles);
  let maxMtimeMs = dirStat.mtimeMs;
  let metaCount = 0;

  for (const f of allFiles) {
    if (!f.endsWith('.md') && !f.endsWith('.meta.json') && f !== 'goldrush-stats-latest.json') continue;
    if (f.endsWith('.meta.json')) metaCount++;
    try {
      const st = fs.statSync(path.join(docsDir, f));
      if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
    } catch { /* 并发删改忽略 */ }
  }

  return {
    signature: `${dirStat.mtimeMs}|${mdFiles.length}|${metaCount}|${maxMtimeMs}`,
    mdFiles,
  };
}

/** 创建带 mtime 指纹自动失效的报告索引缓存 */
function createDocsIndexCache(docsDir, buildFileInfosFn) {
  let cachedSignature = null;
  let cachedInfos = null;
  let hits = 0;
  let misses = 0;

  return {
    getAll() {
      const { signature, mdFiles } = computeDocsSignature(docsDir);
      if (cachedSignature === signature && cachedInfos) {
        hits += 1;
        return cachedInfos;
      }
      misses += 1;
      cachedInfos = buildFileInfosFn(mdFiles);
      cachedSignature = signature;
      return cachedInfos;
    },
    invalidate() {
      cachedSignature = null;
      cachedInfos = null;
    },
    getStats() {
      return { hits, misses, cachedCount: cachedInfos ? cachedInfos.length : 0 };
    },
  };
}

/** 从分析报告列表提取降序唯一月份数组 ['2026-11', '2026-10', ...] */
function extractAvailableMonths(analyses) {
  const counts = new Map();
  for (const item of (analyses || [])) {
    const ym = extractFileMonth(item?.filename || item?.dateLabel || '');
    if (!ym) continue;
    counts.set(ym, (counts.get(ym) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, count]) => ({ month, count }));
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 渲染首页按月筛选工具条（原生 button，支持无障碍 aria-pressed） */
function renderMonthFilterBar(months, totalHistoryCount) {
  if (!months || months.length === 0) return '';
  const buttons = [
    `<button type="button" class="month-btn active" data-month="all" aria-pressed="true" onclick="setMonthFilter('all')">全部 (${totalHistoryCount})</button>`,
    ...months.map(m =>
      `<button type="button" class="month-btn" data-month="${escHtml(m.month)}" aria-pressed="false" onclick="setMonthFilter('${escHtml(m.month)}')">${escHtml(m.month)} <span class="month-cnt">${m.count}</span></button>`,
    ),
  ].join('');
  return `<div class="month-filter-bar" role="group" aria-label="按月份筛选历史日报">
    <span class="month-filter-label">月份筛选</span>
    <div class="month-filter-chips">${buttons}</div>
    <span class="month-visible-count" id="month-visible-count">显示 ${totalHistoryCount} 篇</span>
  </div>`;
}

module.exports = {
  extractFileDate,
  extractFileMonth,
  sortMarkdownFiles,
  computeDocsSignature,
  createDocsIndexCache,
  extractAvailableMonths,
  renderMonthFilterBar,
};
