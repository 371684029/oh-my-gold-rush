import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { buildProbPathMeta } from './prob-path-forecast.js';
import { renderProbPathFanSvg, writeProbPathSvgs } from './prob-path-chart.js';
import type { ProbPathMeta } from './prob-path-types.js';
import type { DataQualityGate } from './data-quality-gate.js';

export interface AttachProbPathInput {
  db: Database.Database;
  asOf: string;
  score: number;
  docsDir: string;
  dataQualityGate?: DataQualityGate | null;
}

/** 构建概率路径、写 SVG、返回可写入 meta / MD 的对象 */
export function attachProbPath(input: AttachProbPathInput): {
  meta: ProbPathMeta;
  svg5: string;
  svg20: string;
} | null {
  const meta = buildProbPathMeta({
    db: input.db,
    asOf: input.asOf,
    score: input.score,
    gateActionable: input.dataQualityGate?.actionable,
    gateTier: input.dataQualityGate?.tier,
  });
  if (!meta) return null;

  if (!fs.existsSync(input.docsDir)) fs.mkdirSync(input.docsDir, { recursive: true });
  const svgRel = writeProbPathSvgs(meta, (name, svg) => {
    fs.writeFileSync(path.join(input.docsDir, name), svg, 'utf-8');
  });
  meta.svgRel = svgRel;

  const svg5 = renderProbPathFanSvg(meta, '5');
  const svg20 = renderProbPathFanSvg(meta, '20');

  const dated5 = `goldrush-prob-path-5d-${input.asOf}.svg`;
  const dated20 = `goldrush-prob-path-20d-${input.asOf}.svg`;
  fs.writeFileSync(path.join(input.docsDir, dated5), svg5, 'utf-8');
  fs.writeFileSync(path.join(input.docsDir, dated20), svg20, 'utf-8');

  return { meta, svg5, svg20 };
}