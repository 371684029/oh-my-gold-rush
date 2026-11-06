// 配置管理

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, type GoldRushConfig, type ModelConfig } from '../types/config.js';

const CONFIG_FILENAME = 'goldrush.config.json';

let config: GoldRushConfig | null = null;

/** 深合并（仅对象层，数组/原始值直接覆盖） */
function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const val = override[key];
    const baseVal = base[key];
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key as keyof T] = deepMerge(
        baseVal as Record<string, unknown>,
        val as Record<string, unknown>,
      ) as T[keyof T];
    } else if (val !== undefined) {
      result[key as keyof T] = val as T[keyof T];
    }
  }
  return result;
}

/** 解析单个模型配置：支持 { providerID, modelID } 或 "providerID/modelID" 字符串 */
function parseModelConfig(value: unknown): ModelConfig | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.providerID === 'string' && typeof obj.modelID === 'string' && obj.providerID && obj.modelID) {
    return { providerID: obj.providerID, modelID: obj.modelID };
  }
  return null;
}

/**
 * 兼容旧配置写法并收口到单一 model：
 * - llm.model / llm.models（旧八项映射，取任意一项，全一致时等价）
 * - models（旧八项映射）
 * - model 字符串 "providerID/modelID"
 */
function normalizeUserConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...raw };

  const llm = raw.llm;
  if (llm && typeof llm === 'object' && !Array.isArray(llm)) {
    const llmObj = llm as Record<string, unknown>;
    if (llmObj.model !== undefined && normalized.model === undefined) {
      normalized.model = llmObj.model;
    }
    if (llmObj.models && typeof llmObj.models === 'object' && normalized.model === undefined) {
      normalized.model = llmObj.models;
    }
  }
  delete normalized.llm;

  // 旧 models 八项映射 → 单一 model（未显式给 model 时）
  if (normalized.model === undefined && normalized.models !== undefined) {
    normalized.model = normalized.models;
  }
  delete normalized.models;

  // model 可能是旧八项映射对象：取第一个合法项
  if (normalized.model && typeof normalized.model === 'object' && !Array.isArray(normalized.model)) {
    const obj = normalized.model as Record<string, unknown>;
    if (obj.providerID === undefined) {
      const first = Object.values(obj).find(v => parseModelConfig(v) !== null);
      normalized.model = first ?? null;
    }
  }
  // model 可能是 "providerID/modelID" 字符串
  if (typeof normalized.model === 'string') {
    const s = normalized.model;
    const idx = s.indexOf('/');
    normalized.model = idx > 0 && idx < s.length - 1
      ? { providerID: s.slice(0, idx), modelID: s.slice(idx + 1) }
      : null;
  }

  return normalized;
}

/** 加载配置 */
export function loadConfig(configPath?: string): GoldRushConfig {
  if (config) return config;

  const resolvedPath = configPath ?? path.resolve(process.cwd(), CONFIG_FILENAME);
  let loaded: GoldRushConfig;

  if (fs.existsSync(resolvedPath)) {
    try {
      const raw = fs.readFileSync(resolvedPath, 'utf-8');
      const userConfig = normalizeUserConfig(JSON.parse(raw) as Record<string, unknown>);
      loaded = deepMerge(
        { ...DEFAULT_CONFIG } as unknown as Record<string, unknown>,
        userConfig,
      ) as unknown as GoldRushConfig;
    } catch {
      loaded = { ...DEFAULT_CONFIG };
    }
  } else {
    loaded = { ...DEFAULT_CONFIG };
  }

  // 从环境变量覆盖
  if (process.env.TAVILY_API_KEY) {
    loaded.search.tavilyApiKey = process.env.TAVILY_API_KEY;
  }
  if (process.env.GOLDRUSH_WEBHOOK_URL) {
    loaded.alerts.webhookUrl = process.env.GOLDRUSH_WEBHOOK_URL;
  }
  if (process.env.GOLDRUSH_WEBHOOK_TYPE) {
    const t = process.env.GOLDRUSH_WEBHOOK_TYPE;
    if (t === 'dingtalk' || t === 'wecom' || t === 'generic') {
      loaded.alerts.webhookType = t;
    }
  }

  config = loaded;
  return config;
}

/** 获取当前配置 */
export function getConfig(): GoldRushConfig {
  return loadConfig();
}

/** 保存配置 */
export function saveConfig(cfg: Partial<GoldRushConfig>, configPath?: string): void {
  const current = loadConfig(configPath);
  const merged = deepMerge(
    current as unknown as Record<string, unknown>,
    cfg as unknown as Record<string, unknown>,
  ) as unknown as GoldRushConfig;
  const resolvedPath = configPath ?? path.resolve(process.cwd(), CONFIG_FILENAME);
  fs.writeFileSync(resolvedPath, JSON.stringify(merged, null, 2), 'utf-8');
  config = merged;
}

/** 测试用：重置配置缓存 */
export function resetConfigCache(): void {
  config = null;
}
