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
  models: {
    dataCollector: ModelConfig;
    validator: ModelConfig;
    technical: ModelConfig;
    fundamental: ModelConfig;
    sentiment: ModelConfig;
    fund: ModelConfig;
    rebuttal: ModelConfig;
    orchestrator: ModelConfig;
  };
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
  models: {
    dataCollector: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash-vision-exp' },
    validator: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash-vision-exp' },
    technical: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash-vision-exp' },
    fundamental: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash-vision-exp' },
    sentiment: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash-vision-exp' },
    fund: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash-vision-exp' },
    rebuttal: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash-vision-exp' },
    orchestrator: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash-vision-exp' },
  },
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
