import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  gradeNewsSourceStrict,
  auditSingleNewsItem,
  auditNewsVeracity,
  NEWS_HALF_LIFE_HOURS,
  NEWS_MAX_AGE_HOURS,
} from '../src/utils/news-veracity.js';
import {
  buildEventGoldTransmission,
  formatTransmissionMarkdown,
} from '../src/utils/event-transmission.js';

const require = createRequire(import.meta.url);
const { auditDailyTransmissionVeracity } = require('../web/news-veracity.cjs');
const { loadDailyForecastDataset } = require('../web/forecast-data.cjs');
const { buildDailyGoldForecast } = require('../web/forecast-engine.cjs');
const DOCS_DIR = path.resolve(process.cwd(), 'docs');

const NOW_MS = Date.parse('2026-11-06T12:00:00Z');

describe('GoldRush v2.5 — 消息真伪甄别与防钓鱼证伪引擎', () => {
  it('严格信源分级：A级官方、B级主流电讯、未知来源与社媒默认降为 C 级', () => {
    expect(gradeNewsSourceStrict('Federal Reserve FOMC')).toBe('A');
    expect(gradeNewsSourceStrict('中国人民银行 PBOC')).toBe('A');
    expect(gradeNewsSourceStrict('Reuters')).toBe('B');
    expect(gradeNewsSourceStrict('财联社')).toBe('B');
    expect(gradeNewsSourceStrict('雪球匿名大V')).toBe('C');
    expect(gradeNewsSourceStrict('某不知名自媒体博客')).toBe('C');
    expect(gradeNewsSourceStrict('')).toBe('C');
  });

  it('真消息（A 级官方 + 跨市场同向确认）进入 B2 事实层并按 36h 半衰期衰减', () => {
    const fresh = auditSingleNewsItem(
      {
        headline: '美联储 FOMC 意外宣布降息 50bp，鲍威尔释放宽松指引',
        sources: ['Federal Reserve', 'Reuters'],
        publishedAt: '2026-11-06T10:00:00Z',
        claimedDirection: 'bullish',
        surpriseZscore: 2.1,
      },
      {
        goldDailyRetPct: 1.85,
        tipsDeltaBp: -12,
        dxyDailyRetPct: -0.75,
        gldFlow5d: 8.5,
      },
      NOW_MS,
    );

    expect(fresh.category).toBe('verified_fact');
    expect(fresh.marketConfirmation).toBe('confirmed');
    expect(fresh.effectiveWeight).toBeGreaterThan(0.7);
    expect(fresh.contrarianSignal).toBeNull();

    // 36h 前发布的消息衰减系数应约为 0.5
    const aged = auditSingleNewsItem(
      {
        headline: '美联储 FOMC 意外宣布降息 50bp',
        sources: ['Federal Reserve'],
        publishedAt: new Date(NOW_MS - NEWS_HALF_LIFE_HOURS * 3600 * 1000).toISOString(),
        claimedDirection: 'bullish',
      },
      { goldDailyRetPct: 1.4, tipsDeltaBp: -8, dxyDailyRetPct: -0.5 },
      NOW_MS,
    );
    expect(aged.decayFactor).toBeCloseTo(0.5, 2);
    expect(aged.effectiveWeight).toBeLessThan(fresh.effectiveWeight);
  });

  it('假消息 / 未知单源传闻：C 级或单源 B 级匿名吹风严格剥离出 B2（权重=0）', () => {
    const cRumor = auditSingleNewsItem(
      {
        headline: '网传史诗级重磅炸弹！黄金马上破6000美元必涨',
        sources: ['微博大V'],
        publishedAt: '2026-11-06T11:00:00Z',
        claimedDirection: 'bullish',
      },
      { goldDailyRetPct: 0.1 },
      NOW_MS,
    );
    expect(cRumor.category).toBe('noise_filtered');
    expect(cRumor.effectiveWeight).toBe(0);
    expect(cRumor.effectiveDirection).toBe('neutral');

    const singleBRumor = auditSingleNewsItem(
      {
        headline: '知情人士称某央行拟大幅调整黄金配额',
        sources: ['Reuters'],
        publishedAt: '2026-11-06T11:00:00Z',
        claimedDirection: 'bullish',
      },
      { goldDailyRetPct: 0.05 }, // 无跨市场确认
      NOW_MS,
    );
    expect(singleBRumor.category).toBe('unconfirmed_rumor');
    expect(singleBRumor.effectiveWeight).toBe(0);
  });

  it('旧闻翻炒：底层事件超过 72 小时自动拦截归零', () => {
    const stale = auditSingleNewsItem(
      {
        headline: '某地区上周冲突报道被重新转发',
        sources: ['Reuters', 'Bloomberg'],
        publishedAt: '2026-11-06T11:30:00Z', // 刚重新发布
        eventDate: new Date(NOW_MS - (NEWS_MAX_AGE_HOURS + 10) * 3600 * 1000).toISOString(), // 实际是82h前旧闻
        claimedDirection: 'bullish',
      },
      { goldDailyRetPct: 0.6 },
      NOW_MS,
    );
    expect(stale.category).toBe('stale_rehash');
    expect(stale.effectiveWeight).toBe(0);
    expect(stale.decayFactor).toBe(0);
  });

  it('利多钓鱼/高位派发：匿名利多 + TIPS飙升/美元走强/金价反跌/CFTC拥挤 → 剥离B2并向S3输出反向扣分与预警', () => {
    const audit = auditNewsVeracity(
      [
        {
          headline: '知情人士称中东地缘全面升级，黄金史诗级暴涨倒计时',
          sources: ['财联社'],
          publishedAt: '2026-11-06T11:00:00Z',
          claimedDirection: 'bullish',
        },
      ],
      {
        goldDailyRetPct: -1.45,
        tipsDeltaBp: 11,
        dxyDailyRetPct: 0.72,
        gldFlow5d: -6.2,
        cftcCrowdingPct: 91,
      },
      NOW_MS,
    );

    expect(audit.baitCount).toBe(1);
    expect(audit.verifiedCount).toBe(0);
    expect(audit.newsScore).toBeNull(); // 严格零污染 B2
    expect(audit.coverage).toBe(0);
    expect(audit.veracityStatus).toBe('bait_suspected');
    expect(audit.contrarianSentimentBias).toBeLessThan(0); // S3 情绪面防追高反向扣分
    expect(audit.baitAlert).toMatch(/钓鱼|派发|追高/);
    expect(audit.noiseShrinkageBoost).toBeGreaterThan(0); // FHS 提高向基准收缩
  });

  it('利空诱空/情绪错杀：恐慌利空传闻 + TIPS下行 + 金价逆势大涨 → 剥离B2并向S3输出正向防割肉修正', () => {
    const audit = auditNewsVeracity(
      [
        {
          headline: '据传央行暂停购金，黄金崩盘预警紧急逃命',
          sources: ['某匿名自媒体'],
          publishedAt: '2026-11-06T10:30:00Z',
          claimedDirection: 'bearish',
        },
      ],
      {
        goldDailyRetPct: 1.6,
        tipsDeltaBp: -9,
        dxyDailyRetPct: -0.6,
      },
      NOW_MS,
    );

    expect(audit.baitCount).toBe(1);
    expect(audit.newsScore).toBeNull();
    expect(audit.contrarianSentimentBias).toBeGreaterThan(0);
    expect(audit.baitAlert).toMatch(/诱空|错杀/);
  });

  it('event-transmission 联动防钓鱼：地缘喊多但美元大涨 + 金价反跌 → 触发 bait_suspected 与警示文案', () => {
    const t = buildEventGoldTransmission({
      marketData: {
        london: { price: { value: 2700, change: -1.2 } },
        dollarIndex: { value: { change: 0.65 } },
        usTreasury: { tips: { value: 2.2 } },
      } as never,
      sentiment: { geopoliticalRisk: '地缘冲突升级、战争风险高企', vix: 'VIX 27' },
    });

    expect(t.veracityStatus).toBe('bait_suspected');
    expect(t.veracityBadge).toContain('钓鱼');
    expect(t.baitWarning).toBeTruthy();
    const md = formatTransmissionMarkdown(t);
    expect(md).toContain('防钓鱼警示');
  });

  it('Web CJS 镜像与预测引擎集成：在 AI 日报日正确输出 B2 veracityBadge 且严格保持零前视', () => {
    // 1) 直接测 CJS 防钓鱼逻辑
    const fakeBait = auditDailyTransmissionVeracity(
      {
        hasAiReport: true,
        londonClose: 2650,
        dxy: 106.5,
        tipsYield: 2.25,
        cftcPercentile: 90,
        transmission: {
          verdict: '地缘升级利多金',
          excerpt: '知情人士称地缘升级',
          channels: [
            { channel: '避险', bias: '利多金', strength: 70 },
            { channel: '利率', bias: '利空金', strength: 60 },
          ],
        },
      },
      {},
      { londonClose: 2700, dxy: 105.5, tipsYield: 2.12 },
    );
    expect(fakeBait.status).toBe('bait_suspected');
    expect(fakeBait.b2Score).toBeNull();
    expect(fakeBait.contrarianSentimentBias).toBeLessThan(0);
    expect(fakeBait.noiseShrinkageBoost).toBeGreaterThan(0);

    // 2) 实盘数据集端到端回归：2026-11-06 AI 日报日 + 零前视不变性
    const records = loadDailyForecastDataset(DOCS_DIR);
    const fc = buildDailyGoldForecast(records, '2026-11-06');
    expect(fc).not.toBeNull();
    const d5 = fc.eightDimensionsByHorizon['5'];
    const b2 = d5.dimensions.find((x: { key: string }) => x.key === 'news');
    expect(b2).toBeDefined();
    expect(typeof b2.veracityBadge).toBe('string');
    expect(b2.veracityBadge.length).toBeGreaterThan(0);
    expect(fc.horizons['5'].sampleStats).toHaveProperty('noiseShrinkageBoost');

    // 零前视校验：截断未来记录不应改变 2026-11-06 的 5 日预测与 B2 分
    const idx = records.findIndex((r: { date: string }) => r.date === '2026-11-06');
    const fcTrunc = buildDailyGoldForecast(records.slice(0, idx + 1), '2026-11-06');
    expect(fcTrunc.horizons['5'].summary.endP50Pct).toBe(fc.horizons['5'].summary.endP50Pct);
    const b2Trunc = fcTrunc.eightDimensionsByHorizon['5'].dimensions.find((x: { key: string }) => x.key === 'news');
    expect(b2Trunc.score).toBe(b2.score);
    expect(b2Trunc.veracityBadge).toBe(b2.veracityBadge);
  });
});
