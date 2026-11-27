// 市场数据类型定义

/** 来源可信度等级 */
export type SourceGrade = 'A' | 'B' | 'C';

/** 带来源标注的数据点 */
export interface SourcedValue<T> {
  value: T;
  source: string;
  sourceGrade: SourceGrade;
  verifiedAt: string; // ISO datetime
}

/** 带涨跌幅的数据点 */
export interface SourcedPrice extends SourcedValue<number> {
  change: number; // 涨跌幅 (%)
}

/** 伦敦金数据 */
export interface LondonGold {
  price: SourcedPrice;   // USD/oz
  altPrices?: SourcedPrice[]; // 其他来源报价（交叉验证）
  high?: SourcedValue<number>;
  low?: SourcedValue<number>;
}

/** 上海金数据 */
export interface ShanghaiGold {
  price: SourcedPrice;   // CNY/g
  altPrices?: SourcedPrice[];
  high?: SourcedValue<number>;
  low?: SourcedValue<number>;
}

/** 黄金ETF数据 */
export interface EtfData {
  code: string;          // ETF代码 (518880)
  name: string;
  nav: SourcedPrice;     // 最新净值
  premiumDiscount?: SourcedValue<number>; // 溢价/折价率 (%)
}

/** 美元指数数据 */
export interface DollarIndexData {
  value: SourcedPrice;
}

/** 美债收益率数据 */
export interface UsTreasuryData {
  yield10y: SourcedPrice; // 10年期美债收益率 (%)
  tips: SourcedValue<number>; // TIPS 实际利率 (%)
}

/** 完整市场数据 */
export interface MarketData {
  timestamp: string;     // 数据采集时间 ISO datetime
  london: LondonGold;
  shanghai: ShanghaiGold;
  etf: EtfData;
  dollarIndex: DollarIndexData;
  usTreasury: UsTreasuryData;
}

/** 验证结果 */
export interface ValidationSource {
  value: number | string;
  source: string;
  grade: SourceGrade;
  timestamp: string;
}

export type ValidationConsensus = 'verified' | 'single_source' | 'minor_deviation' | 'major_conflict';

export interface ValidationResult {
  field: string;
  sources: ValidationSource[];
  consensus: ValidationConsensus;
  finalValue: number | string;
  confidence: number; // 0-100
}

/** SQLite 金价快照记录 */
export interface GoldPriceRecord {
  date: string;          // YYYY-MM-DD
  londonClose: number | null;
  londonHigh: number | null;
  londonLow: number | null;
  shanghaiClose: number | null;
  shanghaiHigh: number | null;
  shanghaiLow: number | null;
  etfNav: number | null;
  etfChange: number | null;
  dollarIndex: number | null;
  us10yYield: number | null;
  tipsYield: number | null;
  /** v2.6: 黄金隐含波动率指数 (CBOE GVZ) */
  gvz?: number | null;
  /** v2.6: 2年期美债收益率 (%) */
  us2yYield?: number | null;
  /** v2.6: 上海金 Au99.99 相对伦敦金溢价 (USD/oz，可正可负) */
  sgePremiumUsd?: number | null;
  createdAt: string;
}

/** 搜索引擎类型 */
export type SearchEngine = 'tavily';

/** 搜索结果 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: SearchEngine;
  publishedDate?: string;
  sourceGrade?: SourceGrade;
}

/** 搜索选项 */
export interface SearchOptions {
  engine: SearchEngine;
  numResults?: number;
  needStructure?: boolean;
  useCache?: boolean;
}

/** 交易时段 */
export type TradingSession = 'pre_market' | 'day' | 'after_hours' | 'night' | 'closed';

/** 交易时间判断结果 */
export interface TradingTimeInfo {
  session: TradingSession;
  description: string;
  isTradingDay: boolean;
}
