// 配置类型定义

/** LLM 模型配置 */
export interface ModelConfig {
  providerID: string;
  modelID: string;
}

/** 投资视角 */
export type Horizon = 'short' | 'mid' | 'all';

/** 分析命令选项 */
export interface AnalysisOptions {
  horizon: Horizon;
  json: boolean;
  save: boolean;
  md: boolean;
}

/** 回测命令选项 */
export interface CalibrateOptions {
  days: number;
  detail: boolean;
  tearsheet: boolean;
  md: boolean;
  /** 输出因子 Spearman IC */
  ic: boolean;
  /** Walk-forward 样本外 MAE 卫生检查 */
  walkForward: boolean;
}

/** 周期摘要命令选项 */
export interface DigestOptions {
  days: number;
  md: boolean;
  json: boolean;
}

/** Webhook 告警配置 */
export type WebhookType = 'generic' | 'dingtalk' | 'wecom';

export interface AlertsConfig {
  webhookUrl: string;
  webhookType: WebhookType;
  /** 评分较上一日变化超过此值时告警 */
  scoreSwingThreshold: number;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
}

/** 通知命令选项 */
export interface NotifyOptions {
  test: boolean;
  daily: boolean;
  exitCode: number;
}

/** 全局配置 */
export interface GoldRushConfig {
  /**
   * LLM 模型（全局单一配置，所有 Agent 共用）。
   * null = 不传 -m，继承 opencode CLI 自身默认模型（~/.config/opencode/opencode.jsonc 的 model）。
   * 可写 { providerID, modelID }，或字符串 "providerID/modelID"（normalize 会解析）。
   */
  model: ModelConfig | null;
  search: {
    tavilyApiKey: string;
    defaultResults: number;
    cacheMinutes: number;
  };
  database: {
    path: string;
  };
  investment: {
    defaultHorizon: Horizon;
    stopLossRange: [number, number]; // [min, max] %
    maxTailRiskIndex: number;
  };
  alerts: AlertsConfig;
}

/** 默认配置 */
export const DEFAULT_CONFIG: GoldRushConfig = {
  // null = 继承 opencode CLI 默认模型（opencode.jsonc 的 "model"）
  model: null,
  search: {
    tavilyApiKey: '',
    defaultResults: 5,
    cacheMinutes: 5,
  },
  database: {
    path: './data/goldrush.db',
  },
  investment: {
    defaultHorizon: 'all',
    stopLossRange: [3, 5],
    maxTailRiskIndex: 20,
  },
  alerts: {
    webhookUrl: '',
    webhookType: 'generic',
    scoreSwingThreshold: 8,
    notifyOnSuccess: false,
    notifyOnFailure: true,
  },
};
