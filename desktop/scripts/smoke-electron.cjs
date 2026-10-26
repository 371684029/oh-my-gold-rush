#!/usr/bin/env node
// 以 ELECTRON_RUN_AS_NODE 方式用 Electron 二进制执行 smoke.cjs（跨平台，无需显示器）

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const electronBin = require('electron');
const r = spawnSync(electronBin, [path.join(__dirname, 'smoke.cjs')], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
if (r.error) {
  console.error(`❌ 无法启动 Electron：${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
