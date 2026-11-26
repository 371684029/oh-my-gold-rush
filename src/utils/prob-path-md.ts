import type { ProbPathMeta } from './prob-path-types.js';

export function formatProbPathMarkdown(
  meta: ProbPathMeta,
  svgs?: { svg5?: string; svg20?: string },
): string {
  const h5 = meta.horizons['5'];
  const last5 = h5.points[h5.points.length - 1];
  const struct = meta.structure
    .map(s => `${s.label} ${s.pctFromSpot >= 0 ? '+' : ''}${s.pctFromSpot}%`)
    .join(' · ') || '结构位数据不足';

  const lines: string[] = [
    '## 📈 概率路径（统计扇形）',
    '',
    `> ${meta.inSampleNote}`,
    '',
    `- 决策日：${meta.asOf}　现价 $${meta.spot.toFixed(2)}　条件分桶 **${meta.condition.bucket}**　样本 **n=${meta.sampleSize}**（分桶 ${meta.condition.bucketCount} + 相似日 ${meta.condition.similarAdded}）`,
    `- 状态：\`${meta.degraded}\`　${meta.gateHint ?? ''}`,
    '',
  ];

  if (last5 && h5.futureFan) {
    lines.push(`- **5 个交易日**：P50 **${last5.p50 >= 0 ? '+' : ''}${last5.p50}%**，区间 P10~P90 **${last5.p10}% ~ ${last5.p90}%**`);
  } else {
    lines.push('- **5 个交易日**：样本不足，暂无扇形（见下图历史走势）');
  }

  const last20 = meta.horizons['20'].points[meta.horizons['20'].points.length - 1];
  if (last20 && meta.horizons['20'].futureFan) {
    lines.push(`- **20 个交易日**：P50 **${last20.p50 >= 0 ? '+' : ''}${last20.p50}%**，区间 P10~P90 **${last20.p10}% ~ ${last20.p90}%**`);
  }

  if (meta.baseline) {
    lines.push(`- 对照：${meta.baseline.label}（n=${meta.baseline.sampleSize}）第 5 日中位 **${meta.baseline.p50 >= 0 ? '+' : ''}${meta.baseline.p50}%**`);
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
  lines.push('*概率路径为历史样本内分位统计；仓位以短期操作建议为准。*');
  lines.push('');

  return lines.join('\n');
}