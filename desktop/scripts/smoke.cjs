#!/usr/bin/env node
// 用 Electron 内置的 Node 运行时加载 bundle/server.cjs 并真实请求首页与最新日报。
// 必须跑在 Electron 的 Node 上（见 smoke-electron.cjs）：系统 Node 能过不代表 Electron 能过，
// 例如 marked 18 是纯 ESM，只有 Node >= 22.12 才能被 require。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const BUNDLE = path.resolve(__dirname, '..', 'bundle');
const DOCS = path.join(BUNDLE, 'docs');

if (!fs.existsSync(path.join(BUNDLE, 'server.cjs'))) {
  console.error('❌ 缺少 bundle/server.cjs，请先运行 npm run stage');
  process.exit(1);
}

process.env.GOLDRUSH_EMBEDDED = '1';
process.env.GOLDRUSH_DOCS_DIR = DOCS;

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

async function main() {
  console.log(`runtime: node ${process.versions.node}${process.versions.electron ? ` / electron ${process.versions.electron}` : ''}`);
  const { server } = require(path.join(BUNDLE, 'server.cjs'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const home = await get(`${base}/`);
    if (home.status !== 200) throw new Error(`首页 HTTP ${home.status}`);
    console.log(`✅ 首页 200（${home.body.length} 字节）`);

    const latest = fs
      .readdirSync(DOCS)
      .filter((f) => /^goldrush-analysis-.*\.md$/.test(f))
      .sort()
      .pop();
    if (latest) {
      const art = await get(`${base}/${encodeURIComponent(latest)}`);
      if (art.status !== 200) throw new Error(`${latest} HTTP ${art.status}`);
      if (!/<h[12][\s>]/.test(art.body)) throw new Error(`${latest} 未渲染出标题，Markdown 渲染链可能坏了`);
      console.log(`✅ ${latest} 200（${art.body.length} 字节）`);
    } else {
      console.log('⚠️ 内置 docs 里没有 goldrush-analysis-*.md，跳过文章页检查');
    }
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(`❌ 冒烟失败：${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
