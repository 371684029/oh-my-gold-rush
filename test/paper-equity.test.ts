import { describe, it, expect } from 'vitest';
import { buildPaperEquity, extractPositionDecisions, type PaperEquityBar } from '../src/utils/paper-equity';
import type { AnalysisReportRow } from '../src/db/reports';

function mkRow(date: string, overallScore: number, quantScore: number | null, reportJson: string): AnalysisReportRow {
  return { id: 1, date, horizon: 'all', reportJson, overallScore, quantScore, midTermScore: null, direction: 'neutral', createdAt: '' };
}

describe('buildPaperEquity', () => {
  const bars: PaperEquityBar[] = [
    { date: '2026-06-01', close: 100 },
    { date: '2026-06-02', close: 110 }, // +10%
    { date: '2026-06-03', close: 99 },  // -10%
    { date: '2026-06-04', close: 104 }, // +5.05…%
  ];

  it('无决策 → 空结果', () => {
    const r = buildPaperEquity(bars, []);
    expect(r.points).toHaveLength(0);
    expect(r.strategy.totalReturnPct).toBeNull();
  });

  it('决策日无对应收盘 → skippedNoPrice', () => {
    const r = buildPaperEquity(bars, [{ date: '2026-05-30', targetPct: 50, source: 'proxy' }]);
    expect(r.points).toHaveLength(0);
    expect(r.skippedNoPrice).toBe(1);
  });

  it('100% 仓位策略 = 满仓持有；0% 仓位净值不动', () => {
    const full = buildPaperEquity(bars, [{ date: '2026-06-01', targetPct: 100, source: 'stored' }]);
    expect(full.points).toHaveLength(3);
    expect(full.strategy.totalReturnPct).toBeCloseTo(4, 1); // 100→104
    expect(full.strategy.totalReturnPct).toBeCloseTo(full.hold.totalReturnPct!, 5);

    const flat = buildPaperEquity(bars, [{ date: '2026-06-01', targetPct: 0, source: 'stored' }]);
    expect(flat.strategy.totalReturnPct).toBe(0);
    expect(flat.hold.totalReturnPct).toBeCloseTo(4, 1);
  });

  it('50% 仓位 = 半仓基准', () => {
    const half = buildPaperEquity(bars, [{ date: '2026-06-01', targetPct: 50, source: 'stored' }]);
    expect(half.strategy.totalReturnPct).toBeCloseTo(half.half.totalReturnPct!, 5);
    // 半仓波动应为满仓的一半（同向序列；允许四舍五入误差）
    expect(half.strategy.annVolPct!).toBeCloseTo(half.hold.annVolPct! / 2, 0);
  });

  it('决策发生在报告日收盘：当日决策不影响当日已实现的收益（无前视）', () => {
    // 06-02 决策空仓，但 06-01→06-02 的 +10% 应按之前（06-01 的 100% 仓）执行
    const r = buildPaperEquity(bars, [
      { date: '2026-06-01', targetPct: 100, source: 'stored' },
      { date: '2026-06-02', targetPct: 0, source: 'stored' },
    ]);
    expect(r.points[0].date).toBe('2026-06-02');
    expect(r.points[0].appliedPct).toBe(100); // 06-01 的决策
    expect(r.points[1].appliedPct).toBe(0);   // 06-02 的决策从 06-03 生效
    // 06-03 的 -10% 空仓躲过，06-04 +5.05% 也空仓
    expect(r.strategy.totalReturnPct).toBeCloseTo(10, 1); // 只有 06-02 的 +10%
  });

  it('未出报告的日子沿用上一目标仓', () => {
    const r = buildPaperEquity(bars, [{ date: '2026-06-01', targetPct: 40, source: 'stored' }]);
    for (const p of r.points) expect(p.appliedPct).toBe(40);
  });

  it('MaxDD 计算正确（峰谷口径）', () => {
    const ddBars: PaperEquityBar[] = [
      { date: '2026-06-01', close: 100 },
      { date: '2026-06-02', close: 120 },
      { date: '2026-06-03', close: 90 }, // 从 120 回撤 25%
      { date: '2026-06-04', close: 95 },
    ];
    const r = buildPaperEquity(ddBars, [{ date: '2026-06-01', targetPct: 100, source: 'stored' }]);
    expect(r.strategy.maxDrawdownPct).toBeCloseTo(25, 1);
    expect(r.hold.maxDrawdownPct).toBeCloseTo(25, 1);
  });

  it('proxy 决策计入 proxyDecisions 并给出警示', () => {
    const r = buildPaperEquity(bars, [{ date: '2026-06-01', targetPct: 55, source: 'proxy' }]);
    expect(r.proxyDecisions).toBe(1);
    expect(r.storedDecisions).toBe(0);
    expect(r.warnings.some(w => w.includes('近似'))).toBe(true);
  });
});

describe('extractPositionDecisions', () => {
  it('优先取入库的 overall.positionTargetPct（stored）', () => {
    const rows = [mkRow('2026-11-01', 40, 60, JSON.stringify({ overall: { positionTargetPct: 33 } }))];
    const d = extractPositionDecisions(rows);
    expect(d[0].source).toBe('stored');
    expect(d[0].targetPct).toBe(33);
  });

  it('无入库仓位 → (LLM+量化)/2 走 scoreToBasePct 映射（proxy）', () => {
    // (50+40)/2 = 45 → 45%
    const rows = [mkRow('2026-10-01', 50, 40, '{}')];
    const d = extractPositionDecisions(rows);
    expect(d[0].source).toBe('proxy');
    expect(d[0].targetPct).toBe(45);
  });

  it('无量化分 → 直接用 LLM 分映射', () => {
    // 72 → 75%
    const rows = [mkRow('2026-10-01', 72, null, 'not-json')];
    const d = extractPositionDecisions(rows);
    expect(d[0].source).toBe('proxy');
    expect(d[0].targetPct).toBe(75);
  });

  it('越界 stored 值（>100 / <0）不采信，回落 proxy', () => {
    const rows = [mkRow('2026-10-01', 60, null, JSON.stringify({ overall: { positionTargetPct: 150 } }))];
    const d = extractPositionDecisions(rows);
    expect(d[0].source).toBe('proxy');
  });
});
