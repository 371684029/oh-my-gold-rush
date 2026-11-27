#!/usr/bin/env node
/**
 * GoldRush v2.6 — 单源同步脚本：从 src/utils/*.ts 自动生成 web/*.cjs 镜像
 *
 * 彻底消除 TS (ESM) 与 Web (CJS) 两端人工双写导致的公式/阈值漂移。
 * 零新增依赖：直接使用仓库 devDependencies 中已安装的 typescript 编译器 API。
 *
 * 用法：
 *   node scripts/sync-web-cjs.mjs           # 生成/覆盖受管 web/*.cjs 镜像
 *   node scripts/sync-web-cjs.mjs --check   # 校验模式（用于 CI/单测，有漂移则退出码 1）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

/** 单一权威源映射表：src/utils/*.ts -> web/*.cjs */
export const SYNC_TARGETS = [
  { src: 'src/utils/decision-thresholds.ts', dest: 'web/decision-thresholds.cjs' },
  { src: 'src/utils/source-rank.ts',         dest: 'web/source-rank.cjs' },
  { src: 'src/utils/fhs-math.ts',            dest: 'web/fhs-math.cjs' },
  { src: 'src/utils/source-circuit-breaker.ts', dest: 'web/source-circuit-breaker.cjs' },
  { src: 'src/utils/macro-surprise.ts',      dest: 'web/macro-surprise.cjs' },
  { src: 'src/utils/regime-kernel.ts',       dest: 'web/regime-kernel.cjs' },
  { src: 'src/utils/prob-calibration.ts',    dest: 'web/prob-calibration.cjs' },
  { src: 'src/utils/news-veracity.ts',       dest: 'web/news-veracity.cjs' },
  { src: 'src/utils/eight-dimensions.ts',    dest: 'web/eight-dimensions-core.cjs' },
];

export function transpileTsToWebCjs(sourceCode, srcRelPath) {
  const result = ts.transpileModule(sourceCode, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      removeComments: false,
      strict: false,
    },
    fileName: path.basename(srcRelPath),
  });

  // 将同目录 ESM 相对 .js 引用改写为对应的 .cjs 镜像
  const rewritten = result.outputText.replace(
    /require\((["'])(\.\/[^"']+)\.js\1\)/g,
    'require($1$2.cjs$1)',
  );

  const banner = [
    `// AUTO-GENERATED from ${srcRelPath} by scripts/sync-web-cjs.mjs — DO NOT EDIT MANUALLY`,
    `// Run \`npm run sync:web\` after modifying ${srcRelPath}.`,
    '',
  ].join('\n');

  return banner + rewritten;
}

export function runSync({ checkOnly = false, rootDir = ROOT } = {}) {
  const drifted = [];
  const updated = [];

  for (const target of SYNC_TARGETS) {
    const srcAbs = path.join(rootDir, target.src);
    const destAbs = path.join(rootDir, target.dest);
    const srcCode = fs.readFileSync(srcAbs, 'utf-8');
    const generated = transpileTsToWebCjs(srcCode, target.src);
    const existing = fs.existsSync(destAbs) ? fs.readFileSync(destAbs, 'utf-8') : null;

    if (existing !== generated) {
      if (checkOnly) {
        drifted.push(target.dest);
      } else {
        fs.writeFileSync(destAbs, generated, 'utf-8');
        updated.push(target.dest);
      }
    }
  }

  return { drifted, updated, total: SYNC_TARGETS.length };
}

// 仅作为 CLI 直接执行时运行
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const checkOnly = process.argv.includes('--check');
  const res = runSync({ checkOnly });
  if (checkOnly) {
    if (res.drifted.length > 0) {
      console.error(`❌ Web CJS mirrors out of sync (${res.drifted.length}): ${res.drifted.join(', ')}`);
      console.error('   Run `npm run sync:web` to regenerate.');
      process.exit(1);
    }
    console.log(`✅ All ${res.total} web/*.cjs mirrors match src/utils/*.ts`);
  } else {
    console.log(`✅ Synced ${res.total} TS -> CJS mirrors (${res.updated.length} updated): ${res.updated.join(', ') || 'all up-to-date'}`);
  }
}
