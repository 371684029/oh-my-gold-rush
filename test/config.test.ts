import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resetConfigCache } from '../src/utils/config';

describe('loadConfig — 深合并与 model 收口', () => {
  let tmpDir: string;

  afterEach(() => {
    resetConfigCache();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('默认 model=null（继承 opencode CLI 默认模型）', () => {
    const cfg = loadConfig(path.join(os.tmpdir(), 'nonexistent-goldrush.config.json'));
    expect(cfg.model).toBeNull();
  });

  it('旧 llm.models 八项映射收口为单一 model（取任意一项）', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goldrush-cfg-'));
    const cfgPath = path.join(tmpDir, 'goldrush.config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      llm: {
        models: {
          rebuttal: { providerID: 'opencode-go', modelID: 'custom-model-x' },
          technical: { providerID: 'opencode-go', modelID: 'custom-model-x' },
        },
      },
    }));

    const cfg = loadConfig(cfgPath);
    expect(cfg.model).toEqual({ providerID: 'opencode-go', modelID: 'custom-model-x' });
  });

  it('新 model 字符串写法 "providerID/modelID" 可解析', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goldrush-cfg-'));
    const cfgPath = path.join(tmpDir, 'goldrush.config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ model: 'xiaomi/mimo-v2.6-flash' }));

    const cfg = loadConfig(cfgPath);
    expect(cfg.model).toEqual({ providerID: 'xiaomi', modelID: 'mimo-v2.6-flash' });
  });

  it('database.path 可被用户配置覆盖', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goldrush-cfg-'));
    const cfgPath = path.join(tmpDir, 'goldrush.config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      database: { path: './custom/db.sqlite' },
    }));

    const cfg = loadConfig(cfgPath);
    expect(cfg.database.path).toBe('./custom/db.sqlite');
  });

  it('GOLDRUSH_WEBHOOK_URL 环境变量覆盖 alerts', () => {
    const prev = process.env.GOLDRUSH_WEBHOOK_URL;
    const prevType = process.env.GOLDRUSH_WEBHOOK_TYPE;
    process.env.GOLDRUSH_WEBHOOK_URL = 'https://example.com/hook';
    process.env.GOLDRUSH_WEBHOOK_TYPE = 'dingtalk';
    try {
      const cfg = loadConfig(path.join(os.tmpdir(), 'nonexistent-goldrush.config.json'));
      expect(cfg.alerts.webhookUrl).toBe('https://example.com/hook');
      expect(cfg.alerts.webhookType).toBe('dingtalk');
    } finally {
      if (prev === undefined) delete process.env.GOLDRUSH_WEBHOOK_URL;
      else process.env.GOLDRUSH_WEBHOOK_URL = prev;
      if (prevType === undefined) delete process.env.GOLDRUSH_WEBHOOK_TYPE;
      else process.env.GOLDRUSH_WEBHOOK_TYPE = prevType;
      resetConfigCache();
    }
  });
});
