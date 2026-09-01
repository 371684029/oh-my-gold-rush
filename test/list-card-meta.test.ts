import { describe, it, expect } from 'vitest';
import {
  listDualScores,
  scoreTone,
  synthesizeNeighborDelta,
  attachNeighborDeltas,
  attachPredictionOutcomes,
  describeOutcome,
  renderListDualHtml,
  renderQuantBadgeHtml,
  renderListDeltaHtml,
  renderListOutcomeHtml,
  fmtSigned,
} from '../web/list-card-meta.cjs';

describe('list-card-meta', () => {
  it('fmtSigned', () => {
    expect(fmtSigned(3)).toBe('+3');
    expect(fmtSigned(-2)).toBe('-2');
    expect(fmtSigned(0)).toBe('±0');
  });

  it('scoreTone 与 scoreBadge 同口径分档', () => {
    expect(scoreTone(80)).toBe('bullish');
    expect(scoreTone(75)).toBe('bullish');
    expect(scoreTone(60)).toBe('neutral');
    expect(scoreTone(55)).toBe('neutral');
    expect(scoreTone(40)).toBe('bearish');
    expect(scoreTone(null)).toBeNull();
  });

  it('listDualScores 读 LLM/量化/冲突', () => {
    const d = listDualScores({
      score: 70,
      dualScore: { llm: 70, quant: 50, delta: 20, conflict: true },
      quantInfo: { quantScore: 50 },
    });
    expect(d.llm).toBe(70);
    expect(d.quant).toBe(50);
    expect(d.conflict).toBe(true);
  });

  it('renderQuantBadgeHtml 按量化分分档着色', () => {
    expect(renderQuantBadgeHtml({ quant: 80 }, s => s)).toContain('rc-qb-bullish');
    expect(renderQuantBadgeHtml({ quant: 60 }, s => s)).toContain('rc-qb-neutral');
    expect(renderQuantBadgeHtml({ quant: 40 }, s => s)).toContain('rc-qb-bearish');
    expect(renderQuantBadgeHtml({ quant: 55 }, s => s)).toContain('rc-qb-neutral');
    expect(renderQuantBadgeHtml({ quant: 55 }, s => s)).toContain('> 55');
    expect(renderQuantBadgeHtml(null, s => s)).toBe('');
    expect(renderQuantBadgeHtml({ llm: 60, quant: null }, s => s)).toBe('');
  });

  it('renderListDualHtml：一致/轻度分歧/分歧弃权三档', () => {
    // |Δ|≤8 → 一致
    const ok = renderListDualHtml({ llm: 57, quant: 55, delta: 2, conflict: false }, s => s);
    expect(ok).toContain('Δ+2');
    expect(ok).toContain('一致');
    expect(ok).toContain('rc-dual-ok');
    expect(ok).not.toContain('rc-dual-flag');
    expect(ok).not.toContain('分歧');
    // 8<|Δ|≤15 → 轻度分歧
    const mild = renderListDualHtml({ llm: 58, quant: 46, delta: 12, conflict: false }, s => s);
    expect(mild).toContain('轻度分歧');
    expect(mild).toContain('rc-dual-mild');
    // conflict → 分歧·操作弃权 + 弃权标
    const conflict = renderListDualHtml({ llm: 70, quant: 50, delta: 20, conflict: true }, s => s);
    expect(conflict).toContain('Δ+20');
    expect(conflict).toContain('分歧·操作弃权');
    expect(conflict).toContain('rc-dual-conflict');
    expect(conflict).toContain('rc-dual-flag');
    // Δ 缺失 → 不渲染
    expect(renderListDualHtml({ llm: 60, quant: null, delta: null, conflict: false }, s => s)).toBe('');
    // 数字由左列徽章承载，Δ 行不再重复
    expect(ok).not.toContain('LLM');
    expect(ok).not.toContain('量化');
  });

  it('相邻推算：分数跳变时有差分 headline', () => {
    const curr = { dateLabel: '2026-07-24', score: 62, quantInfo: { quantScore: 55 }, positionRec: { targetPct: 65 } };
    const prev = { dateLabel: '2026-07-23', score: 50, quantInfo: { quantScore: 52 }, positionRec: { targetPct: 50 } };
    const dd = synthesizeNeighborDelta(curr, prev);
    expect(dd.skipFineRead).toBe(false);
    expect(dd.scoreDelta).toBe(12);
    expect(dd.positionDelta).toBe(15);
    expect(dd.source).toBe('neighbor');
    expect(dd.headline).toMatch(/较2026-07-23/);
    expect(renderListDeltaHtml(dd, s => s)).toContain('分+12');
  });

  it('相邻推算：持平标记 skip', () => {
    const curr = { dateLabel: '07-24', score: 55, quantInfo: { quantScore: 54 }, positionRec: { targetPct: 55 } };
    const prev = { dateLabel: '07-23', score: 54, quantInfo: { quantScore: 54 }, positionRec: { targetPct: 55 } };
    const dd = synthesizeNeighborDelta(curr, prev);
    expect(dd.skipFineRead).toBe(true);
    expect(dd.headline).toMatch(/持平/);
  });

  it('attachNeighborDeltas：无 MD 时用相邻推算；有 MD 优先', () => {
    const rows = attachNeighborDeltas([
      {
        dateLabel: '2026-07-24',
        score: 60,
        quantInfo: { quantScore: 58 },
        dayDelta: { headline: 'MD头条', scoreDelta: 5, skipFineRead: false },
      },
      {
        dateLabel: '2026-07-23',
        score: 50,
        quantInfo: { quantScore: 52 },
        positionRec: { targetPct: 50 },
      },
      {
        dateLabel: '2026-07-22',
        score: 48,
        quantInfo: { quantScore: 50 },
        positionRec: { targetPct: 48 },
      },
    ]);
    expect(rows[0].listDelta.headline).toBe('MD头条');
    expect(rows[0].listDelta.source).toBe('md');
    expect(rows[1].listDelta.source).toBe('neighbor');
    expect(rows[1].listDelta.scoreDelta).toBe(2);
    expect(rows[2].listDelta).toBeNull();
  });

  it('describeOutcome：命中带顺预测与同档偏差', () => {
    const d = describeOutcome({
      date: '2026-07-10',
      pred: 'up',
      actual5dPct: 1.2,
      hit: true,
      status: 'hit',
      alignPct: 1.2,
      bucketAvgReturn: 0.8,
      vsBucketPct: 0.4,
      quantStatus: 'hit',
    });
    expect(d.tone).toBe('hit');
    expect(d.detail).toMatch(/方向命中/);
    expect(d.detail).toMatch(/顺预测/);
    expect(d.detail).toMatch(/相对同档/);
    expect(d.detail).toMatch(/量化亦中/);
    expect(renderListOutcomeHtml({
      pred: 'up', actual5dPct: 1.2, status: 'hit', alignPct: 1.2,
    }, s => s)).toContain('rc-out-hit');
  });

  it('describeOutcome：打脸补算逆预测（旧 JSON 无 alignPct）', () => {
    const d = describeOutcome({
      pred: 'up',
      actual5dPct: -2.1,
      hit: false,
      status: 'miss',
    });
    expect(d.tone).toBe('miss');
    expect(d.detail).toMatch(/打脸/);
    expect(d.detail).toMatch(/逆预测 2\.1%/);
  });

  it('attachPredictionOutcomes 按 dateLabel 挂载', () => {
    const rows = attachPredictionOutcomes(
      [{ dateLabel: '2026-07-10', score: 64 }, { dateLabel: '2026-07-09', score: 50 }],
      {
        recent: [
          { date: '2026-07-10', pred: 'up', actual5dPct: 1.2, status: 'hit', hit: true },
        ],
      },
    );
    expect(rows[0].outcome.status).toBe('hit');
    expect(rows[1].outcome).toBeNull();
  });
});
