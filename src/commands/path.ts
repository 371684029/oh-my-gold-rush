// goldrush path — 概率路径扇形图（纯本地）

import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { getDb } from '../db/index.js';
import { ReportsRepo } from '../db/reports.js';
import { buildProbPathMeta, formatProbPathConsole } from '../utils/prob-path-forecast.js';
import { writeProbPathSvgs } from '../utils/prob-path-chart.js';
import { todayDate } from '../utils/time.js';
import type { ProbPathMeta } from '../utils/prob-path-types.js';

export interface PathCommandOptions {
  date?: string;
  json?: boolean;
  docsDir?: string;
}

function readGateFromReportJson(reportJson: string | null | undefined): {
  actionable?: boolean;
  tier?: string;
} {
  if (!reportJson) return {};
  try {
    const parsed = JSON.parse(reportJson) as {
      dataQualityGate?: { actionable?: boolean; tier?: string };
    };
    return {
      actionable: parsed?.dataQualityGate?.actionable,
      tier: parsed?.dataQualityGate?.tier,
    };
  } catch {
    return {};
  }
}

export function runProbPathBundle(options: PathCommandOptions = {}): ProbPathMeta | null {
  const db = getDb();
  const reports = new ReportsRepo(db);
  const asOf = options.date ?? todayDate();

  const row = reports.getRecent(30).find(r => r.date === asOf)
    ?? reports.getRecent(1)[0];
  if (!row) {
    console.log(chalk.yellow('  无 analysis 报告，无法确定评分条件；请先运行 analysis。'));
    return null;
  }

  const score = row.overallScore;
  const gate = readGateFromReportJson(row.reportJson);
  const meta = buildProbPathMeta({
    db,
    asOf,
    score,
    gateActionable: gate.actionable,
    gateTier: gate.tier,
  });

  if (!meta) {
    console.log(chalk.yellow(`  ${asOf} 无有效伦敦金收盘，无法生成概率路径。`));
    return null;
  }

  const docsDir = options.docsDir ?? 'docs';
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  const svgRel = writeProbPathSvgs(meta, (name, svg) => {
    fs.writeFileSync(path.join(docsDir, name), svg, 'utf-8');
  });
  meta.svgRel = svgRel;

  return meta;
}

export function pathCommand(options: PathCommandOptions = {}): number {
  const meta = runProbPathBundle(options);
  if (!meta) return 0;

  if (options.json) {
    console.log(JSON.stringify(meta, null, 2));
    return 0;
  }

  console.log(chalk.cyan('\n📈 概率路径扇形（Prob Path Fan v2.0）'));
  console.log(formatProbPathConsole(meta));
  if (meta.svgRel) {
    console.log(chalk.gray(`  SVG: docs/${meta.svgRel.path5d}`));
    console.log(chalk.gray(`       docs/${meta.svgRel.path20d}`));
  }
  return 0;
}