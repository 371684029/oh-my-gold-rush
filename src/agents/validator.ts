// 信息验证 Agent — 多源交叉验证 + Tavily spot-check + LLM 异常检测

import { BaseAgent } from './base.js';
import { getConfig } from '../utils/config.js';
import { getDb } from '../db/index.js';
import { SearchCacheRepo } from '../db/search-cache.js';
import { SearchRouter } from '../data/search-router.js';
import { fetchGoldLive, fetchDxyLive } from '../data/yahoo-live.js';
import { fetchLiveAnchors } from '../data/live-anchors.js';
import { checkPriceConsistency } from '../utils/price-consistency.js';
import {
  crossValidate,
  checkFreshness,
  validationSourcesFromPrices,
  weightedFieldConfidence,
} from '../utils/source-rank.js';
import {
  extractLondonPricesFromSearch,
  extractShanghaiPricesFromSearch,
  mergeValidationSources,
  needsSpotCheck,
} from '../utils/spot-verify.js';
import type { MarketData, ValidationResult } from '../types/market.js';
import { isValidMarketNumber, isMissingPrice } from '../schemas/market.js';

const VALIDATION_SYSTEM_PROMPT = `你是黄金市场数据验证专家。你的任务是验证采集到的市场数据的准确性和时效性。

## 验证规则

1. **3源验证**：同一数据点至少3个独立来源交叉验证
   - 3源一致 → ✅ 采信
   - 2源一致，1源偏差<0.5% → ⚠️ 取均值
   - 3源差异>1% → ❌ 标注可疑

2. **来源分级**：
   - A级（权威）：交易所、央行 → 直接采信
   - B级（可信）：财经媒体 → 采信但需验证
   - C级（参考）：自媒体 → 仅参考

3. **时效性**：
   - 价格数据 > 4小时 → 标注⚠️
   - 利率/CPI > 1天 → 正常
   - 新闻 > 3天 → 标注日期

4. **反向核查**：重大新闻/观点必须搜反对观点

5. **内在一致性校验**：伦敦金和上海金之间存在换算关系（上海金/g ≈ 伦敦金×汇率/31.1035），
   检查两者是否有明显背离。美元指数 vs 金价的负相关是否符合预期。`;

const VALIDATION_SCHEMA = {
  type: 'object',
  properties: {
    anomalies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string' },
          issue: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['field', 'issue', 'severity'],
      },
    },
    crossValidationNotes: { type: 'string' },
    overallAssessment: { type: 'string', enum: ['normal', 'suspicious', 'unreliable'] },
    llmConfidence: { type: 'number' },
  },
  required: ['anomalies', 'overallAssessment', 'llmConfidence'],
};

export class ValidatorAgent extends BaseAgent {
  private searchRouter: SearchRouter;

  constructor() {
    const config = getConfig();
    super({
      name: 'validator',
      model: config.models.validator,
      systemPrompt: VALIDATION_SYSTEM_PROMPT,
    });
    const db = getDb();
    const cache = new SearchCacheRepo(db, config.search.cacheMinutes);
    this.searchRouter = new SearchRouter(config.search.tavilyApiKey, { cache });
  }

  async validate(data: MarketData): Promise<{
    validations: ValidationResult[];
    overallConfidence: number;
    warnings: string[];
    /** 直连锚定金价（用于数据质量门禁） */
    anchorGoldPrice: number | null;
  }> {
    // 预取 Yahoo 实时数据作为 A 级锚定源（失败不影响流程）；锚定还提供 USDCNY 供伦敦-上海换算校验
    const [yahooGold, yahooDxy, anchors] = await Promise.all([
      fetchGoldLive().catch(() => null),
      fetchDxyLive().catch(() => null),
      fetchLiveAnchors().catch(() => null),
    ]);

    const validations: ValidationResult[] = [];

    if (!isMissingPrice(data.london?.price) && isValidMarketNumber(data.london?.price?.value)) {
      let sources = validationSourcesFromPrices(data.london.price, data.london.altPrices);
      // 注入 Yahoo GC=F / gold-api 作为 A 级锚定源
      if (yahooGold) {
        sources.unshift({
          value: yahooGold.price,
          source: yahooGold.symbol === 'XAU' ? 'gold-api.com XAU' : 'Yahoo Finance GC=F',
          grade: 'A',
          timestamp: yahooGold.timestamp,
        });
      }
      if (needsSpotCheck(sources) && this.searchRouter.enabled) {
        const results = await this.searchRouter.searchBatch([
          { query: 'XAUUSD gold spot price Kitco Investing.com' },
          { query: 'COMEX gold futures last price USD per ounce' },
        ], { numResults: 4 });
        const flat = [...results.values()].flat();
        sources = mergeValidationSources(sources, extractLondonPricesFromSearch(flat));
      }
      validations.push(crossValidate('london.price', sources));
    }

    if (!isMissingPrice(data.shanghai?.price) && isValidMarketNumber(data.shanghai?.price?.value)) {
      let sources = validationSourcesFromPrices(data.shanghai.price, data.shanghai.altPrices);
      if (needsSpotCheck(sources) && this.searchRouter.enabled) {
        const results = await this.searchRouter.searchBatch([
          { query: '上海金 Au99.99 今日收盘价 元/克' },
          { query: '上海黄金交易所 Au99.99 行情' },
        ], { numResults: 4 });
        const flat = [...results.values()].flat();
        sources = mergeValidationSources(sources, extractShanghaiPricesFromSearch(flat));
      }
      validations.push(crossValidate('shanghai.price', sources));
    }

    if (!isMissingPrice(data.etf?.nav) && isValidMarketNumber(data.etf?.nav?.value)) {
      validations.push(crossValidate('etf.nav', [{
        value: data.etf.nav.value,
        source: data.etf.nav.source ?? 'unknown',
        grade: data.etf.nav.sourceGrade ?? 'C',
        timestamp: data.etf.nav.verifiedAt ?? '',
      }]));
    }

    if (!isMissingPrice(data.dollarIndex?.value) && isValidMarketNumber(data.dollarIndex?.value?.value)) {
      const sources = [{
        value: data.dollarIndex.value.value,
        source: data.dollarIndex.value.source ?? 'unknown',
        grade: data.dollarIndex.value.sourceGrade ?? 'C',
        timestamp: data.dollarIndex.value.verifiedAt ?? '',
      }];
      // 注入 Yahoo DXY / FRED 作为 A 级锚定源
      if (yahooDxy) {
        sources.unshift({
          value: yahooDxy.price,
          source: yahooDxy.symbol?.includes('DTWEX') ? 'FRED DTWEXBGS' : 'Yahoo Finance DX-Y.NYB',
          grade: 'A',
          timestamp: yahooDxy.timestamp,
        });
      }
      validations.push(crossValidate('dollarIndex.value', sources));
    }

    const warnings: string[] = [];
    for (const v of validations) {
      if (v.consensus === 'major_conflict') {
        warnings.push(`🔴 ${v.field} 多源冲突（置信度 ${v.confidence}%）`);
      } else if (v.consensus === 'single_source') {
        warnings.push(`🟡 ${v.field} 仅单源（置信度 ${v.confidence}%）`);
      } else if (v.sources.length >= 2 && v.consensus === 'verified') {
        warnings.push(`✅ ${v.field} ${v.sources.length}源一致（置信度 ${v.confidence}%）`);
      }
    }

    const freshness = checkFreshness(data.timestamp);
    if (!freshness.fresh && freshness.warning) {
      warnings.push(freshness.warning);
    }

    // 价格内部一致性校验（纯程序化，不依赖 LLM）
    const londonVal = data.london?.price?.value;
    const shanghaiVal = data.shanghai?.price?.value;
    const consistency = londonVal != null ? checkPriceConsistency(
      londonVal,
      shanghaiVal ?? null,
      yahooGold?.price ?? null,
      anchors?.usdcny?.price ?? null,
    ) : null;
    if (consistency) {
      warnings.push(...consistency.warnings);
    }

    const dataSummary = [
      `时间戳: ${data.timestamp}`,
      `伦敦金: $${data.london?.price?.value ?? 'N/A'} (${data.london?.price?.change ?? 'N/A'}%) 来源: ${data.london?.price?.source ?? 'N/A'}`,
      `上海金: ¥${data.shanghai?.price?.value ?? 'N/A'}/g  来源: ${data.shanghai?.price?.source ?? 'N/A'}`,
      `ETF(518880): ${data.etf?.nav?.value ?? 'N/A'}  来源: ${data.etf?.nav?.source ?? 'N/A'}`,
      `美元指数: ${data.dollarIndex?.value?.value ?? 'N/A'} (${data.dollarIndex?.value?.change ?? 'N/A'}%)`,
      `10Y美债: ${data.usTreasury?.yield10y?.value ?? 'N/A'}%`,
      `TIPS: ${data.usTreasury?.tips?.value ?? 'N/A'}%`,
    ].join('\n');

    let llmAssessment: {
      anomalies: Array<{ field: string; issue: string; severity: string }>;
      overallAssessment: string;
      llmConfidence: number;
    } | null = null;

    try {
      llmAssessment = await this.structuredPrompt<{
        anomalies: Array<{ field: string; issue: string; severity: string }>;
        overallAssessment: 'normal' | 'suspicious' | 'unreliable';
        llmConfidence: number;
      }>(
        `请验证以下市场数据的准确性和内在一致性，尤其关注：\n`
        + `1. 伦敦金与上海金的换算比率是否合理（上海金/g ≈ 伦敦金×汇率÷31.1035）\n`
        + `2. 美元指数与金价的走势关系是否符合常理\n`
        + `3. 各项数据是否有明显异常或背离\n\n`
        + dataSummary,
        VALIDATION_SCHEMA,
      );
    } catch (err) {
      console.error('  ⚠️ LLM验证不可用，降级为纯本地验证:', err instanceof Error ? err.message : 'unknown');
    }

    if (llmAssessment) {
      for (const anomaly of llmAssessment.anomalies ?? []) {
        if (anomaly.severity === 'high') {
          warnings.push(`🔴 ${anomaly.field}: ${anomaly.issue}`);
        } else if (anomaly.severity === 'medium') {
          warnings.push(`🟡 ${anomaly.field}: ${anomaly.issue}`);
        }
      }

      if (llmAssessment.overallAssessment === 'unreliable') {
        warnings.push('🔴 LLM 评估：数据整体不可靠，请人工核实');
      } else if (llmAssessment.overallAssessment === 'suspicious') {
        warnings.push('🟡 LLM 评估：数据存在部分异常');
      }
    }

    // 伦敦金 50% + 其余字段 50%，避免可选字段单源拖死总分
    const baseLocalConfidence = weightedFieldConfidence(validations);

    // 注入价格一致性校验奖励分（三合一：跨市场/Yahoo锚定/历史连续）
    const consistencyBonus = consistency?.bonusConfidence ?? 0;
    const localConfidence = Math.max(10, Math.min(95, baseLocalConfidence + consistencyBonus));

    // 锚定一致时降低 LLM 自评权重（0.2），避免「数对但 LLM 嘴严」压分
    const anchorAligned = consistency?.details.yahooAnchor.passed === true
      || (yahooGold != null && data.london?.price?.value != null
        && Math.abs(data.london.price.value - yahooGold.price) / yahooGold.price < 0.01);

    let overallConfidence: number;
    if (llmAssessment) {
      const llmConf = typeof llmAssessment.llmConfidence === 'number' && !Number.isNaN(llmAssessment.llmConfidence)
        ? llmAssessment.llmConfidence
        : 50;
      const llmW = anchorAligned ? 0.2 : 0.4;
      const localW = 1 - llmW;
      overallConfidence = Math.round(localConfidence * localW + llmConf * llmW);
    } else {
      overallConfidence = localConfidence;
    }

    return {
      validations,
      overallConfidence,
      warnings,
      anchorGoldPrice: yahooGold?.price ?? null,
    };
  }
}
