// 概率路径扇形 SVG

import type { ProbPathHorizon, ProbPathMeta, ProbPathStructureLevel } from './prob-path-types.js';

export interface FanChartOptions {
  width?: number;
  height?: number;
  padding?: number;
}

/** 历史 % + 未来分位扇形（含结构水平线） */
export function renderProbPathFanSvg(
  meta: ProbPathMeta,
  horizonKey: '5' | '20',
  options: FanChartOptions = {},
): string {
  const width = options.width ?? 680;
  const height = options.height ?? 280;
  const pad = options.padding ?? 44;
  const horizon = meta.horizons[horizonKey];
  const hist = meta.history.slice(-40);

  if (hist.length < 2 && horizon.points.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><text x="50%" y="50%" text-anchor="middle" fill="#64748b" font-size="12">暂无概率路径数据</text></svg>`;
  }

  const histPts = hist.map(h => h.cumPct);
  const futP10 = horizon.points.map(p => p.p10);
  const futP50 = horizon.points.map(p => p.p50);
  const futP90 = horizon.points.map(p => p.p90);

  const combined: number[] = [...histPts, 0, ...futP10, ...futP50, ...futP90];
  for (const s of meta.structure) combined.push(s.pctFromSpot);

  const minY = Math.min(...combined, -1) - 1;
  const maxY = Math.max(...combined, 1) + 1;
  const rangeY = maxY - minY || 1;

  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const histN = hist.length;
  const futN = Math.max(horizon.h, 1);
  const totalN = histN + 1 + futN;
  const pivotIdx = histN;

  const toX = (i: number) => pad + (totalN <= 1 ? innerW / 2 : (i / (totalN - 1)) * innerW);
  const toY = (v: number) => pad + innerH - ((v - minY) / rangeY) * innerH;

  const zeroY = toY(0);
  const grid = [0, 0.5, 1].map(t => {
    const val = minY + rangeY * t;
    const y = toY(val);
    return `<line x1="${pad}" y1="${y}" x2="${width - pad}" y2="${y}" stroke="#334155" stroke-width="1"/>
      <text x="${pad - 8}" y="${y + 4}" text-anchor="end" fill="#94a3b8" font-size="10">${val.toFixed(1)}%</text>`;
  }).join('');

  const histLine = histPts.length >= 2
    ? `<polyline fill="none" stroke="#94a3b8" stroke-width="2" points="${histPts.map((v, i) => `${toX(i)},${toY(v)}`).join(' ')}" />`
    : '';

  const pivot = `<line x1="${toX(pivotIdx)}" y1="${pad}" x2="${toX(pivotIdx)}" y2="${height - pad}" stroke="#475569" stroke-dasharray="4 4" stroke-width="1"/>
    <text x="${toX(pivotIdx)}" y="${pad - 8}" text-anchor="middle" fill="#94a3b8" font-size="10">今天 0%</text>`;

  let fan = '';
  if (horizon.futureFan && futP50.length > 0) {
    const fanPts = (values: number[]) =>
      [0, ...values].map((v, i) => `${toX(pivotIdx + i)},${toY(v)}`).join(' ');

    const top = futP90.length ? fanPts(futP90) : '';
    const bot = futP10.length ? fanPts(futP10) : '';
    if (top && bot) {
      const poly = [
        ...[0, ...futP90].map((v, i) => `${toX(pivotIdx + i)},${toY(v)}`),
        ...[...futP10].reverse().map((v, i) => {
          const idx = pivotIdx + futP10.length - i;
          return `${toX(idx)},${toY(futP10[futP10.length - 1 - i]!)}`;
        }),
      ].join(' ');
      fan += `<polygon points="${poly}" fill="rgba(59,130,246,0.15)" stroke="none"/>`;
    }
    fan += `<polyline fill="none" stroke="#3b82f6" stroke-width="2" points="${fanPts(futP50)}" />`;
    fan += `<polyline fill="none" stroke="#60a5fa" stroke-width="1" stroke-dasharray="3 3" points="${fanPts(futP10)}" />`;
    fan += `<polyline fill="none" stroke="#60a5fa" stroke-width="1" stroke-dasharray="3 3" points="${fanPts(futP90)}" />`;
    fan += `<text x="${width - pad}" y="${toY(futP50[futP50.length - 1] ?? 0) - 6}" text-anchor="end" fill="#3b82f6" font-size="11">P50</text>`;
  }

  const structLines = renderStructureLines(meta.structure, toY, pad, width);

  const title = `概率路径 ${horizonKey} 个交易日 · 累计涨跌% · n=${meta.sampleSize}`;
  const foot = meta.degraded === 'sparse'
    ? '样本偏少，分位仅供参考'
    : meta.degraded === 'history_only'
      ? '样本不足，仅历史走势'
      : 'P10/P50/P90 为经验分位';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
  <rect width="100%" height="100%" fill="#0f172a" rx="8"/>
  ${grid}
  <line x1="${pad}" y1="${zeroY}" x2="${width - pad}" y2="${zeroY}" stroke="#64748b" stroke-width="1"/>
  ${structLines}
  ${histLine}
  ${fan}
  ${pivot}
  <text x="${pad}" y="18" fill="#e2e8f0" font-size="12" font-weight="600">${title}</text>
  <text x="${pad}" y="${height - 12}" fill="#64748b" font-size="10">${foot} · ${meta.inSampleNote.slice(0, 36)}…</text>
</svg>`;
}

function renderStructureLines(
  levels: ProbPathStructureLevel[],
  toY: (v: number) => number,
  pad: number,
  width: number,
): string {
  return levels
    .slice(0, 4)
    .map(l => {
      const y = toY(l.pctFromSpot);
      const color = l.kind === 'resistance' ? '#f97316' : '#22c55e';
      return `<line x1="${pad}" y1="${y}" x2="${width - pad}" y2="${y}" stroke="${color}" stroke-width="1" stroke-dasharray="6 4" opacity="0.7"/>
        <text x="${width - pad + 2}" y="${y + 4}" fill="${color}" font-size="9">${l.label} ${l.pctFromSpot >= 0 ? '+' : ''}${l.pctFromSpot}%</text>`;
    })
    .join('');
}

export function writeProbPathSvgs(
  meta: ProbPathMeta,
  writeFile: (name: string, svg: string) => void,
): { path5d: string; path20d: string } {
  const path5d = 'goldrush-prob-path-5d-latest.svg';
  const path20d = 'goldrush-prob-path-20d-latest.svg';
  writeFile(path5d, renderProbPathFanSvg(meta, '5'));
  writeFile(path20d, renderProbPathFanSvg(meta, '20'));
  return { path5d, path20d };
}