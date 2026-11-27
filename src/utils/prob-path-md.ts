import type { ProbPathMeta } from './prob-path-types.js';

function fmtSigned(v: number): string {
  return `${v >= 0 ? '+' : ''}${v}%`;
}

export function formatProbPathMarkdown(
  meta: ProbPathMeta,
  svgs?: { svg5?: string; svg20?: string },
): string {
  const h5 = meta.horizons['5'];
  const last5 = h5.points[h5.points.length - 1];
  const struct = meta.structure
    .map(s => `${s.label} ${fmtSigned(s.pctFromSpot)}`)
    .join(' · ') || '结构位数据不足';

  const extraMeta = [
    meta.effectiveSampleSize != null ? `N_eff=${meta.effectiveSampleSize}` : null,
    meta.vol20dPct != null ? `20日波动率 ${meta.vol20dPct}%/日` : null,
    meta.shrinkageWeight != null ? `收缩权重 α=${meta.shrinkageWeight}` : null,
  ].filter(Boolean).join('　');

  const lines: string[] = [
    '## 📈 概率路径（统计扇形）',
    '',
    `> ${meta.inSampleNote}`,
    '',
    `- 决策日：${meta.asOf}　现价 $${meta.spot.toFixed(2)}　条件分桶 **${meta.condition.bucket}**　样本 **n=${meta.sampleSize}**（分桶 ${meta.condition.bucketCount} + 相似日 ${meta.condition.similarAdded}）${extraMeta ? `　${extraMeta}` : ''}`,
    `- 状态：\`${meta.degraded}\`　${meta.gateHint ?? ''}`,
    '',
  ];

  if (last5 && h5.futureFan) {
    const midBand = last5.p25 != null && last5.p75 != null
      ? `，核心带 P25~P75 **${fmtSigned(last5.p25)} ~ ${fmtSigned(last5.p75)}**`
      : '';
    const riskNote = h5.pathRisk
      ? `（收涨概率 ${h5.pathRisk.upEndProb}%，路径最大回撤 P90 ${h5.pathRisk.maxDdP90}%）`
      : '';
    lines.push(`- **5 个交易日**：P50 **${fmtSigned(last5.p50)}**${midBand}，外带 P10~P90 **${fmtSigned(last5.p10)} ~ ${fmtSigned(last5.p90)}**${riskNote}`);
  } else {
    lines.push('- **5 个交易日**：样本不足，暂无扇形（见下图历史走势）');
  }

  const h20 = meta.horizons['20'];
  const last20 = h20.points[h20.points.length - 1];
  if (last20 && h20.futureFan) {
    const midBand20 = last20.p25 != null && last20.p75 != null
      ? `，核心带 P25~P75 **${fmtSigned(last20.p25)} ~ ${fmtSigned(last20.p75)}**`
      : '';
    const riskNote20 = h20.pathRisk
      ? `（收涨概率 ${h20.pathRisk.upEndProb}%，路径最大回撤 P90 ${h20.pathRisk.maxDdP90}%）`
      : '';
    lines.push(`- **20 个交易日**：P50 **${fmtSigned(last20.p50)}**${midBand20}，外带 P10~P90 **${fmtSigned(last20.p10)} ~ ${fmtSigned(last20.p90)}**${riskNote20}`);
  }

  if (meta.baseline) {
    lines.push(`- 对照：${meta.baseline.label}（n=${meta.baseline.sampleSize}）第 5 日中位 **${fmtSigned(meta.baseline.p50)}**`);
  }

  lines.push(`- 结构带（相对现价）：${struct}`);
  lines.push('');
  lines.push('<div class="prob-path-charts">');
  lines.push('');
  lines.push('<details open class="prob-path-tab" data-h="5"><summary>5 交易日视野</summary>');
  lines.push('<div class="prob-path-chart" data-horizon="5">');
  if (svgs?.svg5) lines.push(svgs.svg5);
  else if (meta.svgRel?.path5d) lines.push(`<!-- 见 docs/${meta.svgRel.path5d} -->`);
  lines.push('</div></details>');
  lines.push('');
  lines.push('<details class="prob-path-tab" data-h="20"><summary>20 交易日视野</summary>');
  lines.push('<div class="prob-path-chart" data-horizon="20">');
  if (svgs?.svg20) lines.push(svgs.svg20);
  else if (meta.svgRel?.path20d) lines.push(`<!-- 见 docs/${meta.svgRel.path20d} -->`);
  lines.push('</div></details>');
  lines.push('</div>');
  lines.push('');
  lines.push('*概率路径为 FHS 标准化与收缩统计分布；仓位以短期操作建议为准。*');
  lines.push('');

  return lines.join('\n');
}