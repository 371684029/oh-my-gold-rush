#!/usr/bin/env node
// 把日报站（server.cjs + web/ + docs/）复制到 desktop/bundle，并在打包前做依赖体检。
// 体检失败直接退出非 0，让问题在 stage 阶段暴露，而不是装好后白屏。

const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const DESKTOP = path.resolve(__dirname, '..');
const ROOT = path.resolve(DESKTOP, '..');
const BUNDLE = path.join(DESKTOP, 'bundle');

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const desktopPkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf-8'));

const errors = [];

function fail(msg) {
  errors.push(msg);
}

/** server.cjs 与 web/*.cjs 里所有 require('包名') 的第三方包 */
function collectThirdPartyRequires(files) {
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
  const found = new Map();
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf-8');
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/') || builtins.has(spec)) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!found.has(name)) found.set(name, path.relative(ROOT, file));
    }
  }
  return found;
}

const webDir = path.join(ROOT, 'web');
const serverFiles = [
  path.join(ROOT, 'server.cjs'),
  ...fs.readdirSync(webDir).filter((f) => f.endsWith('.cjs')).map((f) => path.join(webDir, f)),
];

const desktopDeps = desktopPkg.dependencies || {};
const rootDeps = rootPkg.dependencies || {};
for (const [name, file] of collectThirdPartyRequires(serverFiles)) {
  if (!desktopDeps[name]) {
    fail(`${file} 引用了 "${name}"，但 desktop/package.json 的 dependencies 里没有。请执行：cd desktop && npm i ${name}@${rootDeps[name] || 'latest'}`);
  } else if (rootDeps[name] && rootDeps[name] !== desktopDeps[name]) {
    fail(`"${name}" 版本不一致：根 package.json=${rootDeps[name]}，desktop/package.json=${desktopDeps[name]}。请让两边一致。`);
  }
}

const NATIVE_BLOCKLIST = ['better-sqlite3'];
for (const name of NATIVE_BLOCKLIST) {
  if (desktopDeps[name]) {
    fail(`desktop 依赖里出现原生模块 "${name}"：桌面壳不需要它，且它会触发针对 Electron 的重编译（需要 Python/VS/Xcode 与外网），这是打包失败的常见根因。`);
  }
}

if (errors.length) {
  console.error('\n❌ 桌面打包体检未通过：\n');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('');
  process.exit(1);
}

fs.rmSync(BUNDLE, { recursive: true, force: true });
fs.mkdirSync(BUNDLE, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'server.cjs'), path.join(BUNDLE, 'server.cjs'));
fs.cpSync(webDir, path.join(BUNDLE, 'web'), {
  recursive: true,
  filter: (src) => fs.statSync(src).isDirectory() || src.endsWith('.cjs'),
});
// 只带 Web 会读的文件；search-raw 等审计原文不进安装包
fs.cpSync(path.join(ROOT, 'docs'), path.join(BUNDLE, 'docs'), {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(path.join(ROOT, 'docs'), src);
    if (rel.split(path.sep)[0] === 'search-raw') return false;
    return fs.statSync(src).isDirectory() || /\.(md|json|png|jpe?g|svg)$/i.test(src);
  },
});

const mdCount = fs.readdirSync(path.join(BUNDLE, 'docs')).filter((f) => f.endsWith('.md')).length;
console.log(`✅ stage 完成：server.cjs + web/ + docs/（${mdCount} 篇 .md）→ ${path.relative(ROOT, BUNDLE)}`);
