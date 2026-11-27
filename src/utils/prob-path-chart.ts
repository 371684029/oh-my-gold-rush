// 概率路径扇形 SVG — 浅色液态玻璃主题 + 双层分位带（P10-P90 / P25-P75 / P50）+ 无裁切右侧标注

import type { ProbPathMeta, ProbPathStructureLevel } from './prob-path-types.js';

export interface FanChartOptions {
  width?: number;
  height?: number;
  padding?: number;
}

/** 历史 %（锚定今日=0%）+ 未来双层分位扇形（含结构水平线） */
export function renderProbPathFanSvg(
  meta: ProbPathMeta,
  horizonKey: '5' | '20',
  options: FanChartOptions = {},
): string {
  const width = options.width ?? 760;
  const height = options.height ?? 300;
  const padL = options.padding ?? 52;
  const padR = 136;
  const padT = 36;
  const padB = 34;
  const horizon = meta.horizons[horizonKey];
  const hist = meta.history.slice(-40);

  if (hist.length < 2 && horizon.points.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#ffffff" stroke="#e2e8f0" rx="12"/><text x="50%" y="50%" text-anchor="middle" fill="#64748b" font-size="12">暂无概率路径数据</text></svg>`;
  }

  const histPts = hist.map(h => h.cumPct);
  const futP10 = horizon.points.map(p => p.p10);
  const futP25 = horizon.points.map(p => p.p25 ?? p.p10);
  const futP50 = horizon.points.map(p => p.p50);
  const futP75 = horizon.points.map(p => p.p75 ?? p.p90);
  const futP90 = horizon.points.map(p => p.p90);

  const combined: number[] = [...histPts, 0, ...futP10, ...futP50, ...futP90];
  for (const s of meta.structure) combined.push(s.pctFromSpot);

  const rawMin = Math.min(...combined, -1);
  const rawMax = Math.max(...combined, 1);
  const padY = Math.max(0.8, (rawMax - rawMin) * 0.12);
  const minY = rawMin - padY;
  const maxY = rawMax + padY;
  const rangeY = maxY - minY || 1;

  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const histN = hist.length;
  const futN = Math.max(horizon.h, 1);
  // 历史最后一点即决策日(0%)，避免重复占位
  const pivotIdx = Math.max(histN - 1, 0);
  const totalN = pivotIdx + 1 + futN;

  const toX = (i: number) => padL + (totalN <= 1 ? innerW / 2 : (i / (totalN - 1)) * innerW);
  const toY = (v: number) => padT + innerH - ((v - minY) / rangeY) * innerH;

  const zeroY = toY(0);
  const grid = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const val = minY + rangeY * t;
    const y = toY(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>
      <text x="${padL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" fill="#64748b" font-size="10">${val >= 0 ? '+' : ''}${val.toFixed(1)}%</text>`;
  }).join('');

  const histLine = histPts.length >= 2
    ? `<polyline fill="none" stroke="#1e293b" stroke-width="2" stroke-linejoin="round" points="${histPts.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ')}" />`
    : '';

  const pivotX = toX(pivotIdx);
  const pivot = `<line x1="${pivotX.toFixed(1)}" y1="${padT}" x2="${pivotX.toFixed(1)}" y2="${height - padB}" stroke="#94a3b8" stroke-dasharray="4 4" stroke-width="1"/>
    <circle cx="${pivotX.toFixed(1)}" cy="${zeroY.toFixed(1)}" r="3.5" fill="#b45309" stroke="#ffffff" stroke-width="1.5"/>
    <text x="${pivotX.toFixed(1)}" y="${padT - 8}" text-anchor="middle" fill="#475569" font-size="10" font-weight="600">决策日 0%</text>`;

  let fan = '';
  if (horizon.futureFan && futP50.length > 0) {
    const fanPts = (values: number[]) =>
      [0, ...values].map((v, i) => `${toX(pivotIdx + i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');

    const buildBand = (upper: number[], lower: number[]) => [
      ...[0, ...upper].map((v, i) => `${toX(pivotIdx + i).toFixed(1)},${toY(v).toFixed(1)}`),
      ...[...lower].reverse().map((v, i) => {
        const idx = pivotIdx + lower.length - i;
        return `${toX(idx).toFixed(1)},${toY(v).toFixed(1)}`;
      }),
    ].join(' ');

    fan += `<polygon points="${buildBand(futP90, futP10)}" fill="rgba(217,119,6,0.12)" stroke="none"/>`;
    if (horizon.points.some(p => p.p25 != null && p.p75 != null)) {
      fan += `<polygon points="${buildBand(futP75, futP25)}" fill="rgba(217,119,6,0.22)" stroke="none"/>`;
    }
    fan += `<polyline fill="none" stroke="#b45309" stroke-width="2.2" stroke-linejoin="round" points="${fanPts(futP50)}" />`;
    fan += `<polyline fill="none" stroke="#d97706" stroke-width="1" stroke-dasharray="3 3" opacity="0.75" points="${fanPts(futP10)}" />`;
    fan += `<polyline fill="none" stroke="#d97706" stroke-width="1" stroke-dasharray="3 3" opacity="0.75" points="${fanPts(futP90)}" />`;

    const last50 = futP50[futP50.length - 1] ?? 0;
    const endX = toX(pivotIdx + futP50.length);
    fan += `<text x="${(endX - 4).toFixed(1)}" y="${(toY(last50) - 7).toFixed(1)}" text-anchor="end" fill="#b45309" font-size="11" font-weight="600">P50 ${last50 >= 0 ? '+' : ''}${last50.toFixed(1)}%</text>`;
  }

  const structLines = renderStructureLines(meta.structure, toY, padL, width - padR);

  const hN = horizon.sampleSize ?? meta.sampleSize;
  const neffTag = horizon.effectiveSampleSize != null ? ` · N_eff=${horizon.effectiveSampleSize}` : '';
  const title = `概率路径 ${horizonKey} 交易日 · 相对现价涨跌% · n=${hN}${neffTag}`;
  const foot = meta.degraded === 'sparse'
    ? '条件样本偏少，已向无条件 FHS 收缩'
    : meta.degraded === 'unconditional_only'
      ? '条件样本不足，当前展示无条件 FHS 基准'
      : meta.degraded === 'history_only'
        ? '历史样本不足，仅展示已实现走势'
        : '浅带 P10–P90 · 深带 P25–P75 · 实线 P50';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
  <rect width="100%" height="100%" fill="#ffffff" stroke="#e2e8f0" stroke-width="1" rx="12"/>
  ${grid}
  <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${width - padR}" y2="${zeroY.toFixed(1)}" stroke="#94a3b8" stroke-width="1"/>
  ${structLines}
  ${histLine}
  ${fan}
  ${pivot}
  <text x="${padL}" y="20" fill="#0f172a" font-size="12" font-weight="600">${title}</text>
  <text x="${padL}" y="${height - 10}" fill="#64748b" font-size="10">${foot}</text>
</svg>`;
}

function renderStructureLines(
  levels: ProbPathStructureLevel[],
  toY: (v: number) => number,
  padL: number,
  rightX: number,
): string {
  return levels
    .slice(0, 4)
    .map(l => {
      const y = toY(l.pctFromSpot);
      const color = l.kind === 'resistance' ? '#dc2626' : '#059669';
      return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${rightX}" y2="${y.toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="5 4" opacity="0.65"/>
        <text x="${rightX + 6}" y="${(y + 3.5).toFixed(1)}" fill="${color}" font-size="10" font-weight="500">${l.label} ${l.pctFromSpot >= 0 ? '+' : ''}${l.pctFromSpot}%</text>`;
    })
    .join('');
}

export function writeProbPathSvgs(
  meta: ProbPathMeta,
  writeFile: (name: string, svg: string) => void,
): { path5d: string; path20d: string } {
  const dated5 = `goldrush-prob-path-5d-${meta.asOf}.svg`;
  const dated20 = `goldrush-prob-path-20d-${meta.asOf}.svg`;
  const svg5 = renderProbPathFanSvg(meta, '5');
  const svg20 = renderProbPathFanSvg(meta, '20');
  writeFile(dated5, svg5);
  writeFile(dated20, svg20);
  writeFile('goldrush-prob-path-5d-latest.svg', svg5);
  writeFile('goldrush-prob-path-20d-latest.svg', svg20);
  return { path5d: dated5, path20d: dated20 };
}