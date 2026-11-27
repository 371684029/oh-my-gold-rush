// CLI 命令：goldrush sync-market — 同步近 5 年黄金/宏观/资金流日线至本地 SQLite 与 Git 快照

import chalk from 'chalk';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface SyncMarketMeta {
  dateRange?: { from?: string | null; to?: string | null };
  tradingDays?: number;
  liveQuotes?: {
    xauUsd?: number | null;
    shanghaiCny?: number | null;
    usdCny?: number | null;
  };
  obsDates?: {
    tips?: string | null;
    cftc?: string | null;
  };
}

interface SyncMarketResult {
  ok: boolean;
  refreshed: boolean;
  tradingDays?: number;
  latestDate?: string | null;
  message: string;
  meta?: SyncMarketMeta | null;
}

export interface SyncMarketOptions {
  full?: boolean;
  json?: boolean;
}

export async function syncMarketCommand(opts: SyncMarketOptions = {}): Promise<number> {
  const modPath = path.resolve(process.cwd(), 'web', 'market-sync.cjs');
  const { syncMarketData } = require(modPath) as {
    syncMarketData: (o: { docsDir: string; mode: 'auto' | 'full' | 'incremental'; force: boolean }) => Promise<SyncMarketResult>;
  };

  const docsDir = path.resolve(process.cwd(), 'docs');
  const mode = opts.full ? 'full' : 'auto';
  if (!opts.json) {
    console.log(chalk.cyan(`⏳ 正在同步近 5 年黄金与宏观实盘数据（mode=${mode}）...`));
  }

  const res = await syncMarketData({ docsDir, mode, force: true });

  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }

  if (!res.ok) {
    console.error(chalk.red(`❌ ${res.message}`));
    return 1;
  }

  const q = res.meta?.liveQuotes;
  const dr = res.meta?.dateRange;
  console.log(chalk.green(`✅ ${res.message}`));
  if (dr?.from && dr?.to) {
    console.log(chalk.gray(`   区间: ${dr.from} ~ ${dr.to} · Git 快照: docs/market-data/gold-daily-5y.jsonl`));
  }
  if (q) {
    const parts: string[] = [];
    if (q.xauUsd != null) parts.push(`伦敦金 $${q.xauUsd}/oz`);
    if (q.shanghaiCny != null) parts.push(`上海金 ¥${q.shanghaiCny}/克`);
    if (q.usdCny != null) parts.push(`USD/CNY ${q.usdCny}`);
    if (parts.length) console.log(chalk.yellow(`   实时行情: ${parts.join(' · ')}`));
  }
  if (res.meta?.obsDates?.tips || res.meta?.obsDates?.cftc) {
    console.log(chalk.gray(`   观测日: FRED TIPS ${res.meta.obsDates.tips ?? '—'} · CFTC ${res.meta.obsDates.cftc ?? '—'}`));
  }
  return 0;
}
