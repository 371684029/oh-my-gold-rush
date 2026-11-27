import { describe, it, expect } from 'vitest';
import {
  computeMacroSurprise,
  aggregateMacroSurprises,
  extractMacroSurpriseFromText,
} from '../src/utils/macro-surprise.js';
import { auditNewsVeracity } from '../src/utils/news-veracity.js';

describe('Macro Economic Calendar Surprise Engine (v2.6 M3)', () => {
  it('computes negative goldSurpriseZ when CPI beats consensus (hawkish for gold)', () => {
    const res = computeMacroSurprise({ indicator: 'CPI', actual: 3.1, consensus: 2.8 });
    expect(res.rawSurprise).toBeCloseTo(0.3, 4);
    expect(res.rawZscore).toBeCloseTo(2.5, 2);
    expect(res.goldSurpriseZ).toBeLessThan(-2);
    expect(res.goldDirection).toBe('bearish');
    expect(res.b2DeltaPoints).toBeLessThan(-15);
    expect(res.isSignificant).toBe(true);
  });

  it('computes positive goldSurpriseZ when unemployment rises above consensus (bullish for gold)', () => {
    const res = computeMacroSurprise({ indicator: 'UNEMPLOYMENT', actual: 4.5, consensus: 4.2 });
    expect(res.rawSurprise).toBeCloseTo(0.3, 4);
    expect(res.goldSurpriseZ).toBeGreaterThan(2);
    expect(res.goldDirection).toBe('bullish');
    expect(res.b2DeltaPoints).toBeGreaterThan(15);
  });

  it('aggregates multiple same-day macro releases by sensitivity weights', () => {
    const agg = aggregateMacroSurprises([
      { indicator: 'NFP', actual: 10, consensus: 18 },       // miss -> bullish gold
      { indicator: 'UNEMPLOYMENT', actual: 4.4, consensus: 4.1 }, // higher -> bullish gold
    ]);
    expect(agg.results).toHaveLength(2);
    expect(agg.compositeGoldZ).not.toBeNull();
    expect(agg.compositeGoldZ!).toBeGreaterThan(1.5);
    expect(agg.b2ScoreAdjustment).toBeGreaterThan(10);
    expect(agg.dominantSummary).toBeTruthy();
  });

  it('extracts structured surprise from Chinese and English headlines', () => {
    const cnCpi = extractMacroSurpriseFromText('美国CPI同比公布2.9%，预期2.7%，通胀黏性再超预期');
    expect(cnCpi).not.toBeNull();
    expect(cnCpi!.indicator).toBe('CPI');
    expect(cnCpi!.actual).toBe(2.9);
    expect(cnCpi!.consensus).toBe(2.7);
    expect(cnCpi!.goldDirection).toBe('bearish');

    const cnNfp = extractMacroSurpriseFromText('美国非农就业新增12万人，低于预期18万人');
    expect(cnNfp).not.toBeNull();
    expect(cnNfp!.indicator).toBe('NFP');
    expect(cnNfp!.actual).toBe(12);
    expect(cnNfp!.consensus).toBe(18);
    expect(cnNfp!.goldDirection).toBe('bullish');

    const enCoreCpi = extractMacroSurpriseFromText('US Core CPI actual 3.1% vs consensus 3.3%');
    expect(enCoreCpi).not.toBeNull();
    expect(enCoreCpi!.indicator).toBe('CORE_CPI');
    expect(enCoreCpi!.goldDirection).toBe('bullish');

    // Non-macro headline returns null
    expect(extractMacroSurpriseFromText('某自媒体爆料神秘资金扫货黄金')).toBeNull();
  });

  it('automatically injects extracted macro surprise z-score into auditNewsVeracity', () => {
    const nowMs = Date.parse('2026-11-26T12:00:00Z');
    const result = auditNewsVeracity(
      [
        {
          headline: '美国劳工部公布美国非农就业新增10万人，低于预期18万人',
          sources: ['BLS 美国劳工部', 'Reuters'],
          publishedAt: '2026-11-26T10:00:00Z',
          claimedDirection: 'bullish',
        },
      ],
      {
        goldDailyRetPct: 1.4,
        tipsDeltaBp: -8,
        dxyDailyRetPct: -0.6,
      },
      nowMs,
    );

    expect(result.veracityStatus).toBe('confirmed');
    expect(result.verifiedCount).toBe(1);
    expect(result.newsScore).not.toBeNull();
    expect(result.newsScore!).toBeGreaterThan(68);
    expect(result.items[0].reasons.some(r => r.includes('日历预期差'))).toBe(true);
  });
});
