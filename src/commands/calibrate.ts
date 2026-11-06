// goldrush calibrate — 回测校准

import { getDb } from '../db/index.js';
import { CalibrationRepo } from '../db/calibration.js';
import { ReportsRepo } from '../db/reports.js';
import { GoldPricesRepo } from '../db/gold-prices.js';
import {
  buildCalibrationTearsheet,
  formatTearsheetConsole,
  formatTearsheetMarkdown,
  renderPaperEquitySvg,
} from '../utils/calibration-tearsheet.js';
import { computeFactorIc, formatFactorIcConsole, formatFactorIcMarkdown } from '../utils/factor-ic.js';
import { computeScenarioBrier, formatScenarioBrierConsole, formatScenarioBrierMarkdown } from '../utils/scenario-brier.js';
import { summarizeWalkForward, formatWalkForwardConsole, formatWalkForwardMarkdown, computeOosHitStats } from '../utils/walk-forward.js';
import { header, separator } from '../utils/format.js';
import chalk from 'chalk';
import type { CalibrateOptions } from '../types/config.js';

export async function calibrateCommand(options: CalibrateOptions): Promise<void> {
  console.log('\n📊 GoldRush 校准报告生成中...\n');

  const db = getDb();
  const repo = new CalibrationRepo(db);
  const pricesRepo = new GoldPricesRepo(db);
  const reportsRepo = new ReportsRepo(db);

  // 自动回填
  const filled = repo.backfillPending();
  if (filled > 0) {
    console.log(`  ✅ 回填了 ${filled} 条历史数据`);
  }

  // 计算校准
  const report = repo.computeCalibration(options.days);
  const quantReport = repo.computeQuantCalibration(options.days);

  let tearsheet = null as ReturnType<typeof buildCalibrationTearsheet> | null;
  if (options.tearsheet || options.md) {
    const reports = reportsRepo.getRecent(options.days);
    tearsheet = buildCalibrationTearsheet(reports, pricesRepo);
  }

  let factorIc = null as ReturnType<typeof computeFactorIc> | null;
  if (options.ic || options.md) {
    factorIc = computeFactorIc(reportsRepo.getRecent(Math.max(options.days, 90)), pricesRepo);
  }

  let walkForward = null as ReturnType<typeof summarizeWalkForward> | null;
  if (options.walkForward || options.md) {
    const rows = [...reportsRepo.getRecent(Math.max(options.days, 60))]
      .sort((a, b) => a.date.localeCompare(b.date));
    if (rows.length >= 10) {
      const mid = Math.floor(rows.length / 2);
      const trainFrom = rows[0].date;
      const trainTo = rows[mid - 1].date;
      const testFrom = rows[mid].date;
      const testTo = rows[rows.length - 1].date;
      const trainCal = repo.computeCalibrationInRange(trainFrom, trainTo);
      const testCal = repo.computeCalibrationInRange(testFrom, testTo);
      const oos = computeOosHitStats({
        testReports: rows.slice(mid),
        prices: pricesRepo,
        horizonDays: 5,
      });
      walkForward = summarizeWalkForward(trainCal, testCal, oos);
    } else {
      console.log(chalk.yellow('\n  🚶 Walk-forward：报告不足 10 条，跳过'));
    }
  }

  // 情景概率 Brier 校准（包 G）
  let scenarioBrier = null as ReturnType<typeof computeScenarioBrier> | null;
  if (options.brier || options.md) {
    scenarioBrier = computeScenarioBrier(
      reportsRepo.getRecent(Math.max(options.days, 90)),
      pricesRepo,
      5,
    );
  }

  // 输出
  console.log(header('📊 GoldRush 置信度校准报告', `过去${report.period.days}天 | ${report.period.from} ~ ${report.period.to}`));
  console.log(`  分析报告总数: ${report.totalReports}条 | 有效回填: ${report.validReports}条`);

  if (report.buckets.length === 0) {
    console.log('\n  ⚠️ 暂无足够的历史数据进行校准');
    console.log('  请先运行 goldrush analysis 多次积累数据');
    console.log(separator('═', 55));
    return;
  }

  // 校准表格
  console.log(`\n  📈 评分区间校准\n`);
  console.log('  评分区间  样本  实际涨概率  平均涨幅  偏差      系统偏差');
  console.log(separator('─', 55));

  for (const bucket of report.buckets) {
    const biasStr = bucket.systematicBias === 'optimistic'
      ? chalk.red(`偏乐观${bucket.calibrationError.toFixed(0)}%`)
      : bucket.systematicBias === 'pessimistic'
        ? chalk.green(`偏保守${bucket.calibrationError.toFixed(0)}%`)
        : chalk.cyan('校准良好');

    const systemBiasStr = bucket.systematicBias === 'optimistic' ? '乐观'
      : bucket.systematicBias === 'pessimistic' ? '保守'
        : '校准';

    console.log(`  ${bucket.scoreRange.padEnd(8)} ${String(bucket.sampleSize).padStart(4)}  ${(bucket.actualUpProbability * 100).toFixed(0).padStart(8)}%    ${bucket.avgReturn > 0 ? '+' : ''}${bucket.avgReturn.toFixed(1).padStart(6)}%   ${biasStr}  ${systemBiasStr}`);
  }

  console.log(chalk.gray('\n  （上表为 LLM 分桶校准；坏样本/红档已排除）'));

  // 量化评分校准表格（如果存在量化数据）
  if (quantReport.buckets.length > 0) {
    console.log(`\n  🔢 量化评分校准（独立轨道）\n`);
    console.log('  评分区间  样本  实际涨概率  平均涨幅  偏差      系统偏差');
    console.log(separator('─', 55));

    for (const bucket of quantReport.buckets) {
      const biasStr = bucket.systematicBias === 'optimistic'
        ? chalk.red(`偏乐观${bucket.calibrationError.toFixed(0)}%`)
        : bucket.systematicBias === 'pessimistic'
          ? chalk.green(`偏保守${bucket.calibrationError.toFixed(0)}%`)
          : chalk.cyan('校准良好');

      const systemBiasStr = bucket.systematicBias === 'optimistic' ? '乐观'
        : bucket.systematicBias === 'pessimistic' ? '保守'
          : '校准';

      console.log(`  ${bucket.scoreRange.padEnd(8)} ${String(bucket.sampleSize).padStart(4)}  ${(bucket.actualUpProbability * 100).toFixed(0).padStart(8)}%    ${bucket.avgReturn > 0 ? '+' : ''}${bucket.avgReturn.toFixed(1).padStart(6)}%   ${biasStr}  ${systemBiasStr}`);
    }
  } else {
    console.log(chalk.yellow('\n  🔢 量化评分校准：暂无 quant_score 样本（新报告会写入）'));
  }

  // 双打分：方向命中 + 冲突日
  const dualHits = repo.computeDualTrackHitStats(options.days);
  console.log(`\n  ⚖️ 双打分健全性（5 日方向命中；>55 预测涨，<45 预测跌）\n`);
  const llmRate = dualHits.llmTotal > 0
    ? `${(dualHits.llmHits / dualHits.llmTotal * 100).toFixed(0)}% (${dualHits.llmHits}/${dualHits.llmTotal})`
    : 'N/A';
  const quantRate = dualHits.quantTotal > 0
    ? `${(dualHits.quantHits / dualHits.quantTotal * 100).toFixed(0)}% (${dualHits.quantHits}/${dualHits.quantTotal})`
    : 'N/A';
  console.log(`  LLM 方向命中:   ${llmRate}`);
  console.log(`  量化方向命中:   ${quantRate}`);
  console.log(`  冲突日(|Δ|>15): ${dualHits.conflictDays} 天`);
  if (dualHits.conflictDays > 0) {
    console.log(`    · 冲突日若跟量化命中: ${dualHits.conflictFollowQuantHits}/${dualHits.conflictDays}`);
    console.log(`    · 冲突日若跟LLM命中:  ${dualHits.conflictFollowLlmHits}/${dualHits.conflictDays}`);
    console.log(chalk.gray('    · 产品规则：冲突日操作弃权（维持定投），两套分数仍展示'));
  }

  const llmAvgError = report.buckets.length > 0
    ? report.buckets.reduce((sum, b) => sum + b.calibrationError, 0) / report.buckets.length
    : 0;
  const quantAvgError = quantReport.buckets.length > 0
    ? quantReport.buckets.reduce((sum, b) => sum + b.calibrationError, 0) / quantReport.buckets.length
    : 0;

  if (llmAvgError > 0 || quantAvgError > 0) {
    const better = llmAvgError <= quantAvgError ? 'LLM' : '量化';
    console.log(`\n  📊 分桶校准误差：LLM 均 ${llmAvgError.toFixed(1)}% · 量化均 ${quantAvgError.toFixed(1)}% → 近期更贴「${better}」`);
    console.log(chalk.gray('     （仅作参考；冲突日仍弃权，不自动改写操作）'));
  }

  // --detail：按评分区间展开明细
  if (options.detail) {
    console.log(`\n  🔍 区间明细\n`);
    for (const bucket of report.buckets) {
      console.log(`  ${bucket.scoreRange}: 预测方向=${bucket.predictedDirection} | 实际上涨 ${bucket.actualUpCount}/${bucket.sampleSize} | 校准误差 ${bucket.calibrationError.toFixed(1)}% | 系统偏差=${bucket.systematicBias}`);
    }
  }

  // 整体偏差
  const biasDir = report.overallBias > 0 ? '偏乐观' : report.overallBias < 0 ? '偏保守' : '校准良好';
  console.log(`\n  ⚠️ 系统偏差: 整体${biasDir} ${Math.abs(report.overallBias).toFixed(1)}%`);

  // 风险预警质量
  const rq = report.riskAlertQuality;
  console.log(`\n  🚨 风险预警质量\n`);
  console.log(`  红灯触发: ${rq.redAlertCount}次`);
  console.log(`  红灯命中: ${rq.redAlertHitCount}次 (命中率${(rq.redAlertHitRate * 100).toFixed(0)}%) ${rq.redAlertHitRate > 0.6 ? '✅' : '⚠️'}`);
  console.log(`  漏报次数: ${rq.missedAlerts}次 (漏报率${(rq.missedRate * 100).toFixed(0)}%) ${rq.missedRate < 0.25 ? '✅' : '⚠️'}`);

  // 建议
  console.log(`\n  💡 改进建议`);
  for (const rec of report.recommendations) {
    console.log(`  · ${rec}`);
  }

  if (tearsheet && options.tearsheet) {
    console.log(formatTearsheetConsole(tearsheet));
  }

  if (factorIc && options.ic) {
    console.log('\n' + formatFactorIcConsole(factorIc));
  }

  if (walkForward && options.walkForward) {
    console.log('\n' + formatWalkForwardConsole(walkForward));
  }

  if (scenarioBrier && options.brier) {
    console.log('\n' + formatScenarioBrierConsole(scenarioBrier));
  }

  if (options.md && (tearsheet || factorIc || walkForward || scenarioBrier)) {
    const fs = await import('node:fs');
    const docsDir = 'docs';
    if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
    const periodLabel = `过去${report.period.days}天 (${report.period.from} ~ ${report.period.to})`;
    const parts: string[] = [];
    if (tearsheet) parts.push(formatTearsheetMarkdown(tearsheet, periodLabel));
    if (factorIc) parts.push(formatFactorIcMarkdown(factorIc));
    if (walkForward) parts.push(formatWalkForwardMarkdown(walkForward));
    if (scenarioBrier) parts.push(formatScenarioBrierMarkdown(scenarioBrier));
    const content = parts.join('\n');
    const dated = `${docsDir}/goldrush-calibration-${new Date().toISOString().slice(0, 10)}.md`;
    const latest = `${docsDir}/goldrush-calibration-latest.md`;
    fs.writeFileSync(dated, content, 'utf-8');
    fs.writeFileSync(latest, content, 'utf-8');
    if (tearsheet && tearsheet.equity.points.length >= 2) {
      const svg = renderPaperEquitySvg(tearsheet.equity);
      const svgLatest = `${docsDir}/goldrush-calibration-equity-latest.svg`;
      fs.writeFileSync(svgLatest, svg, 'utf-8');
      console.log(`  📈 纸面权益曲线 SVG: ${svgLatest}`);
    }
    console.log(`\n  📝 校准导出已写入 ${dated}`);
  }

  console.log(separator('═', 55));
}
