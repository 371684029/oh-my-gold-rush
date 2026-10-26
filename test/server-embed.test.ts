import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// 桌面版（desktop/main.cjs）依赖的契约：GOLDRUSH_EMBEDDED=1 时不自动监听、导出 server、尊重 GOLDRUSH_DOCS_DIR
describe('server.cjs 嵌入模式', () => {
  let server: Server;
  let docsDir: string;
  let base: string;

  beforeAll(async () => {
    docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goldrush-docs-'));
    fs.writeFileSync(
      path.join(docsDir, 'goldrush-analysis-2026-01-02.md'),
      '# 黄金日报 2026-01-02\n\n综合评分 **56/100**\n',
    );
    process.env.GOLDRUSH_EMBEDDED = '1';
    process.env.GOLDRUSH_DOCS_DIR = docsDir;
    const require = createRequire(import.meta.url);
    const mod = require('../server.cjs') as { server: Server; DOCS_DIR: string };
    expect(mod.DOCS_DIR).toBe(path.resolve(docsDir));
    server = mod.server;
    expect(server.listening).toBe(false);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server?.close();
    delete process.env.GOLDRUSH_EMBEDDED;
    delete process.env.GOLDRUSH_DOCS_DIR;
    fs.rmSync(docsDir, { recursive: true, force: true });
  });

  it('首页列出自定义 docs 目录里的日报', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('goldrush-analysis-2026-01-02.md');
  });

  it('文章页渲染 Markdown', async () => {
    const res = await fetch(`${base}/goldrush-analysis-2026-01-02.md`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('黄金日报 2026-01-02');
  });

  it('拒绝路径穿越', async () => {
    const res = await fetch(`${base}/..%2Fpackage.json`);
    expect(res.status).toBe(403);
  });
});
