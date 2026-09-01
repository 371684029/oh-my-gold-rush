import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildReportMeta,
  saveReportMeta,
  loadReportMeta,
  REPORT_META_SCHEMA,
} from '../src/utils/report-meta.js';
import { gateFromMeta } from '../web/report-meta.cjs';
import type { GoldAnalysisReport } from '../src/types/analysis.js';
import type { MidTermOutlook } from '../src/utils/mid-term-outlook.js';

function stubReport(overrides: Partial<GoldAnalysisReport> = {}): GoldAnalysisReport {
  return {
    timestamp: '2026-07-20T08:00:00.000Z',
    marketData: {} as GoldAnalysisReport['marketData'],
    dataQuality: { overallConfidence: 80, warnings: [] },
    technical: {} as GoldAnalysisReport['technical'],
    fundamental: {} as GoldAnalysisReport['fundamental'],
    sentiment: {} as GoldAnalysisReport['sentiment'],
    fund: {} as GoldAnalysisReport['fund'],
    rebuttal: {} as GoldAnalysisReport['rebuttal'],
    tailRisks: [],
    overall: {
      score: 62,
      direction: 'bullish',
      quantScore: 58,
      quantCoverage: 0.85,
      scenarios: {} as GoldAnalysisReport['overall']['scenarios'],
      calibration: {} as GoldAnalysisReport['overall']['calibration'],
      shortTerm: {} as GoldAnalysisReport['overall']['shortTerm'],
      midTerm: {} as GoldAnalysisReport['overall']['midTerm'],
    },
    midTermOutlook: {
      score: 57,
      direction: 'neutral',
      coverage: 0.9,
      factors: {},
      horizons: [
        {
          months: 3,
          label: '约 3 个月',
          direction: 'neutral',
          biasScore: 57,
          confidence: 'moderate',
          stance: 'hold',
          action: '维持定投',
        },
      ],
      drivers: ['实际利率回落'],
      watchTriggers: [],
      summary: '中期中性偏多',
    } satisfies MidTermOutlook,
    ...overrides,
  };
}

describe('buildReportMeta / saveReportMeta', () => {
  it('写出 schemaVersion=1 的 sidecar，含短中期与操作建议', () => {
    const meta = buildReportMeta({
      report: stubReport(),
      scoreLow: 54,
      scoreHigh: 70,
      dataQualityGate: {
        tier: 'green',
        actionable: true,
        overallConfidence: 80,
        banners: [],
      } as never,
      dualVerdict: {
        llmScore: 62,
        quantScore: 58,
        delta: 4,
        alignment: 'aligned',
        llmDirection: 'bullish',
        quantDirection: 'bullish',
        sameDirection: true,
        actionPolicy: 'both',
        banners: [],
        actionOverride: null,
      },
      positionRec: {
        targetPct: 55,
        label: '标配',
        tilt: 'hold',
        headline: '标配附近',
        action: '建议约 55%',
        emoji: '🟡',
      } as never,
      reliabilityCard: {
        score: 72,
        tier: 'high',
      } as never,
    });

    expect(meta.schemaVersion).toBe(REPORT_META_SCHEMA);
    expect(meta.date).toBe('2026-07-20');
    expect(meta.score).toBe(62);
    expect(meta.scoreLow).toBe(54);
    expect(meta.scoreHigh).toBe(70);
    expect(meta.quantScore).toBe(58);
    expect(meta.midTermScore).toBe(57);
    expect(meta.position?.targetPct).toBe(55);
    expect(meta.advice?.source).toBe('position');
    expect(meta.reliability?.level).toBe('high');
    expect(meta.short.score).toBe(62);
    expect(meta.mid?.score).toBe(57);
    expect(meta.mid?.stance).toBe('维持');
  });

  it('读写往返：load 校验 schema，版本不对返回 null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goldrush-meta-'));
    const mdPath = path.join(dir, 'goldrush-analysis-2026-07-20.md');
    fs.writeFileSync(mdPath, '# stub\n', 'utf-8');

    const meta = buildReportMeta({ report: stubReport() });
    const out = saveReportMeta(mdPath, meta);
    expect(out.endsWith('.meta.json')).toBe(true);

    const loaded = loadReportMeta(mdPath);
    expect(loaded?.score).toBe(62);
    expect(loaded?.direction).toBe('bullish');

    const badPath = path.join(dir, 'bad.meta.json');
    fs.writeFileSync(badPath, JSON.stringify({ ...meta, schemaVersion: 999 }), 'utf-8');
    expect(loadReportMeta(badPath)).toBeNull();
  });
});

describe('gateFromMeta（web 读取端）', () => {
  it('gate 形状与 extractDataQualityGate 对齐：confidence 命名 + notes 数组', () => {
    const gate = gateFromMeta({ gate: { tier: 'yellow', actionable: true, overallConfidence: 72 } });
    expect(gate?.tier).toBe('yellow');
    expect(gate?.confidence).toBe(72);
    expect(Array.isArray(gate?.notes)).toBe(true);
  });

  it('meta 无 gate 时返回 null', () => {
    expect(gateFromMeta({})).toBeNull();
    expect(gateFromMeta(null)).toBeNull();
  });
});
