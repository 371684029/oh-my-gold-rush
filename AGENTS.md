# AGENTS.md

## Cursor Cloud specific instructions

### 提交署名（用户要求，永久）
本仓库 git 提交统一使用 **`wll <371684029@qq.com>`**。每个新会话开始时请先执行：

```
git config --local user.name "wll"
git config --local user.email "371684029@qq.com"
```

不要使用 `Cursor Agent` 等默认署名，提交信息中也不要夹带 `Co-authored-by` / Cursor 等尾注。

### What this is
GoldRush（黄金投资研究 Agent）核心是 **CLI 工具**。入口 `src/index.ts`（Commander.js），数据存于本地 SQLite（`better-sqlite3`，文件 `./data/goldrush.db`，首次运行自动创建，已被 `.gitignore` 忽略）。

生产机另有可选 **`server.cjs`**（HTTP 报告站，常监听 :80），与 CLI 共用 `docs/` 与 DB，**不是** CLI 运行所必需。

### Run / lint / build（命令见 `package.json` scripts）
- 开发模式（直接跑 TS，无需编译）：`npm run dev -- <command>`，例如 `npm run dev -- history`。
- 编译后运行：`npm run build` 然后 `node dist/index.js <command>`。
- Lint = 类型检查：`npm run lint`（`tsc --noEmit` + `tsc -p tsconfig.test.json`）。**测试也参与类型检查**：`test/` 不在 `tsconfig.json` 的 `include` 里（避免被编进 `dist`），但由 `tsconfig.test.json` 单独校验，否则 fixture 会悄悄漂移。改动公共类型后若 `test/` 报错，是提醒你同步 fixture，不是噪音。
- 单元测试：`npm test`（`vitest run`）。测试位于 `test/` 目录，主要覆盖纯函数（时区、百分位、时效性、校准分桶、量化因子、三期展望、日报解析）。`test/list-card-meta.test.ts` 测的是 `web/` 下的纯 JS 模块，类型噪音大，已在 `tsconfig.test.json` 里排除。
- 命令列表见 `README.md`（`price` / `analysis` / `fund` / `calibrate` / `snapshot` / `init-history` / `history`）。

### 非显而易见的运行前提（重要）
- **依赖外部 LLM 服务的命令**：`price`、`analysis`、`fund`、`snapshot`、`init-history` 都会调用 `DataCollectorAgent`，经 `src/agents/base.ts` 请求 opencode 服务器（`OPENCODE_SERVER`，默认 `http://localhost:8080`，Basic Auth 用 `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`，默认 `opencode`/`goldrush2026`；provider/model 见 `goldrush.config.json` 或 `src/types/config.ts` 的 `DEFAULT_CONFIG`，默认 `opencode-go` provider）。该服务器是**仓库外的自建/代理服务**，沙箱里默认不存在。未启动时这些命令会**优雅降级**（打印提示、退出码 0），**不会写入任何数据**。
- **`TAVILY_API_KEY`（可选）**：联网搜索用 Tavily（`@tavily/core`）。未配置时 `SearchRouter` 降级为空结果（不报错）。可写入 `.env`（见 `.env.example`）。
- **纯本地命令（无需任何外部服务）**：`history`、`calibrate`、`diff`、`digest`、`notify --test`（未配置 webhook 时仅打印跳过）；`notify --daily` 需配置 `GOLDRUSH_WEBHOOK_URL` 或 `goldrush.config.json` 的 `alerts.webhookUrl` 才会实际发送。`flow` 在已有 CFTC 数据时可纯本地算分；拉新数据需出站网络。
- **`init-history` / `analysis` Step 0**：优先 **Yahoo Finance GC=F** 日线补 `london_close`；Yahoo 超时/失败时回落 **LBMA** 下午定盘（`yahoo-gold-history.ts` → `fetchLbmaGoldHistory`）。**无需 Tavily**。当日现货采集仍走 Tavily+LLM，再经 **live anchors** 补齐缺失字段。
- **Validator spot-check**：伦敦/上海仅单源时，Validator 会额外 Tavily 搜索并从 snippet 启发式抽价；同时注入 Yahoo/gold-api 等 A 级锚定。
- 技术指标（MA/RSI/MACD 等）需积累约 20 个**有效**交易日（`london_close > 0`）后才可靠。

### 数据质量硬规则（2026-07 起，必读）
详见 `docs/DATA-QUALITY.md`。摘要：

1. **禁止把 0 当有效金价**：`isValidMarketNumber` / `isMissingPrice`（`schemas/market.ts`）；`saveSnapshot` 与 `GoldPricesRepo.upsert` 不写入、不覆盖有效列为 0。
2. **读库净化**：`mapRow` 将历史脏数据 `0` 映射为 `null`，避免 MA/RSI 被污染。
3. **forwardFill 跳过 ≤0**：`price-series.ts`；否则会出现「偏离 MA20 -100%」假信号。
4. **先锚定后搜索**：`collectMarketData` 先直连 gold-api/新浪，再 Tavily+LLM 补全；锚定失败且无金价则 fail-fast。**每个价格字段（伦敦金/上海金 Au99.99/黄金ETF 518880）都必须有零 LLM 直连锚定**（新浪 `hf_GC`/`gds_AU9999`/`sh518880`），Tavily snippet 常无数字可抽，不能当唯一来源；LLM 抽价与锚定**偏差>3% 锚定优先**（`enrichWithLiveAnchors`，原值进 altPrices 审计）。
5. **置信度**：A 级单源 **72**；伦敦金字段权重 50%；锚定一致时 LLM 权重 0.2。
6. **门禁**（`data-quality-gate.ts`）：**勿用 conf&lt;55 硬拦**。红档=无金价 / 锚定偏差&gt;3% / conf&lt;35 → 关闭操作结论；黄档可出报告；绿档 conf≥70 且锚定贴合。
7. **双打分**（`dual-score.ts`）：LLM 分与量化分**始终并排**；`|Δ|&gt;15` 或方向相反 → **仓位受限（≤50%）+ 定投为主**，文案须写清谁偏哪边与具体仓位%，**勿**千篇一律「双体系不一致」；四维弱一致单独不等于双体系冲突；不抬某一侧权重；`calibrate` 分轨统计谁更准；量化因子 `event_heat` 默认 0，无效因子可在 `DEFAULT_WEIGHTS` 置 0。
8. **长期 1/3/5 年**（`long-term-outlook.ts`）：**配置向、慢变量主导**；3/5 年与当日 overall **脱钩**；反驳多年档惩罚封顶；累计区间硬顶 ±35%；`confidence=low` 不展示点位式累计%；相对上一 outlook **平滑**。完整说明：`docs/LONG-TERM-OUTLOOK.md`。命令：`outlook` / `outlook --md`（按最新 analysis 用新规则重算，不必等完整 analysis）。
9. **仓位推荐 + 预测对错**（`position-recommend.ts` / `prediction-track.ts`）：相对「计划黄金仓」0–100%（非杠杆）；门禁红 ≤35%、双分冲突 ≤50%；每次 analysis 刷新 `docs/goldrush-stats-latest.json`（短期 5 日 LLM/量化命中 + **中期 20 日 midTerm**、分桶、明细）。完整说明：`docs/POSITION-AND-TRACK.md`。Web：`server.cjs` 首页/文章页面板。
10. **可信度一览**（`reliability-card.ts`）：门禁+双分+一致+校准+滚动命中 → 0–100 操作可信度 + 评分区间半宽 + 三行 TL;DR；**不是**预测准确率承诺。搜索原文存档 `docs/search-raw/`（`search-raw-archive.ts`）。说明：`docs/RELIABILITY.md`。
11. **统一操作建议**（`resolveOperationalAdvice`）：优先级 门禁红 → 双分分歧（有仓位则仍给具体%） → 仓位推荐 → 分数人话；CLI/MD/Web 不得各写一套互相矛盾的文案。Smart 路径也须输出仓位与可信度。
12. **较昨日 Δ + 研究卫生**（`day-delta.ts` / `factor-ic.ts` / `walk-forward.ts`）：日报强调相对昨日差分与驱动归因；持平可跳过细读；`calibrate --ic` / `--walk-forward`（含测试窗 OOS 命中）。说明：`docs/DAILY-DELTA.md`。
13. **周末错因反思**（`weekly-reflect.ts` / `reflect`）：周日归纳打脸原因→`docs/goldrush-reflect-latest.md`；下次 analysis 注入阅读要点。说明：`docs/WEEKLY-REFLECT.md`。
14. **事件传导 + 今日必看**（`event-transmission.ts` / `reading-checklist.ts`）：热点只保留利率/美元/避险通道；无传导则「可忽略」。**暂定不加量化权重**（与 `event_heat=0` 一致，仅 Explain）。说明：`docs/USER-VALUE.md` §3.1。
15. **三个时间尺度**（`mid-term-outlook.ts` / `long-term-outlook.ts`）：短期 5 日、中期 1～3 个月、长期 1/3/5 年，**命中标签不同必须分轨统计**；中期只吃慢变量、不吃 RSI/MACD；三档不一致是常态，仓位以短期档为准。说明：`docs/HORIZONS.md`。
16. **口径单一来源**：方向阈值/持平死区/命中判定看 `decision-thresholds.ts`，前瞻收益窗口看 `forward-return.ts`，日报解析看 `web/report-extract.cjs`（**优先** `.meta.json` sidecar）。**勿再在别处硬编码 58/42/55/45/0.1%**；命中率一律带 Wilson 区间与「永远看涨」基准。
17. **日报 meta sidecar**（`report-meta.ts`）：`analysis` 写 MD 时同步 `*.meta.json`；Web 决策面板优先读机器契约。历史日报需重跑 `--md` 才有 sidecar。
18. **后续规划入口**：**`docs/ROADMAP-FINENG.md`**；**本轮决策质量总清单**：**`docs/DECISION-QUALITY.md`**。新功能先落 **Signals → Gates → Portfolio → Explain** 哪一层；勿以点位准确率为 KPI、勿冲突时抬单侧权重。

### 出站网络现状（生产机实测，会变）
| 源 | 状态 | 用途 |
|----|------|------|
| cftc.gov | 通 | COT |
| gold-api.com / 新浪 hq | 通 | 现货金锚定 |
| prices.lbma.org.uk | 通 | 历史金价 |
| 东财 search-api | 通 | **GLD 吨数 / PBOC 储备** 新闻解析 |
| Yahoo query1 | 常超时 | 有回落，勿假设必通 |
| FRED | 常超时 | 10Y/TIPS/宽美元可能空 |
| SPDR CSV / Yahoo GLD 份额 | 常失败 | 已用东财持仓新闻替代 |

改数据源时：优先在 `src/data/live-anchors.ts` 加瀑布源，并保持「无数据 → null/中性，不编造」。

### 注意
- 源码脚手架最初缺失 `src/data/`（`data-collector.ts` import 的 `../data/search-router.js`）。若 `npm run build` 报 `Cannot find module '../data/search-router.js'`，说明该模块缺失会导致**整个构建失败**（`index.ts` 静态引入了所有命令）。本仓库已补回 `src/data/search-router.ts`。
- `price` / `analysis` 冒烟会调 LLM，可能跑 5–15 分钟；验收优先 `npm test`、`flow`、直连锚定探针，再跑完整 `analysis`。

---

## 三个时间尺度（短 / 中 / 长）

用户的核心诉求是「买 / 卖 / 持」，三档口径不同，**不要混着解释**：

| 档位 | 模块 | 视野 | 命中标签 | 产出 |
|------|------|------|----------|------|
| 短期 | `overall.score` + `quant-score.ts` | 日线 | **5 个交易日** | 综合分、双打分、当日仓位% |
| 中期 | `mid-term-outlook.ts` | 1～3 个月 | **20 个交易日**（`analysis_reports.mid_term_score`） | 1 个月 / 3 个月两档方向 + 操作倾向 + 推翻条件 |
| 长期 | `long-term-outlook.ts` | 1 / 3 / 5 年 | 不做点位问责 | 配置档位、定投建议 |

- **中期只吃慢变量**：MA50/MA200 结构、实际利率 60 日趋势、美元相对 MA60、近一年估值分位、CFTC 持仓拥挤度（极端反向）、官方与 ETF 买盘。**刻意不吃 RSI/MACD/布林**，否则中期只是短期分的复读。权重见 `MID_TERM_WEIGHTS`（合计 1.0），同样按覆盖度重归一。
- **实际利率看方向不看水平**：高位但持续下行仍判偏多。
- **三档不一致是常态**，报告与网页都要写清「仓位以短期那格为准」，不要强行调和。
- Web 首屏 `web/horizon-strip.cjs` 把三档并排展示；中期与长期小节默认展开（`web/article-collapse.cjs` 的 `OPEN_SECTION_KEYS`）。
- 完整说明：**`docs/HORIZONS.md`**。

## 口径单一来源（勿再散落硬编码）

| 内容 | 唯一来源 | 曾经的问题 |
|------|----------|-----------|
| 方向阈值 / 持平死区 / 命中判定 / Wilson 区间 / 基准比较 | `src/utils/decision-thresholds.ts` | 阈值散落 8 处；展示用 58/42、记账用 55/45，**56 分页面写「中性」却按「预测涨」记账** |
| 前瞻收益窗口 | `src/utils/forward-return.ts` | 命中率用 close(T)→close(T+5)，因子 IC 用 close(T+1)→close(T+6)，两者对不上账 |
| 日报机器可读契约 | `src/utils/report-meta.ts` → `*.meta.json` | 版式一改（区间评分）正则静默失败，整个决策面板消失 |
| 日报 Markdown → 结构化字段（回落） | `web/report-extract.cjs` | 仅当 sidecar 缺失或 schema 不匹配时使用 |

**命中率必须带样本量与基准**：`formatHitRate` 会输出 Wilson 95% 区间，样本 < 10 明确标注「不具统计意义」；`prediction-track` 同时给出「永远看涨」朴素基准——黄金长期偏多头，不比基准分不清模型有信息量还是只是蹭趋势。

**Markdown 表格解析按表头名取列，不要按列序号**：长期表在 2026-07 中旬没有「配置档位」列，按序号硬取会把回报区间当配置档位显示。

**决策质量总清单（以后改分/命中/Web 决策面板先读）**：**`docs/DECISION-QUALITY.md`**。

## 双打分制（LLM + 量化）

`analysis` 命令运行两套独立评分系统并行对比：

### LLM 评分（主）
```
四维度(技术/基本/情绪面) LLM 均分 → 反驳修正 → 校准偏移 → finalScore
```
依赖 opencode 服务器，有随机性。

### 量化评分（参）
纯本地计算，零 LLM，100% 可复现。入口 `src/indicators/quant-score.ts`。

**因子体系（11 类，权重总和 = 1.0）：**

| 因子 | key | weight | 数据源 | 逻辑 |
|------|-----|--------|--------|------|
| 金价趋势 | `trend` | 12% | `gold_prices.london_close` | MA20 偏离百分比 → 信号分 |
| RSI 动量 | `rsi` | 10% | 同上 | RSI(14) 直接值 |
| MACD 动能 | `macd` | 10% | 同上 | histogram/price 归一化 |
| 布林带 | `bollinger` | 5% | 同上 | %B 反转（低轨→偏多） |
| 估值水位 | `valuation` | 8% | 同上 | 历史百分位反转 |
| 主力动向 | `flow` | 15% | SQLite `institutional_flows` | CFTC+GLD+央行综合分 |
| 美元指数 | `dxy` | 12% | `gold_prices.dollar_index` | DXY 偏离 MA20，反向 |
| 名义利率 | `us10y` | 8% | `gold_prices.us10y_yield` | 10Y 偏离 MA20，反向 |
| **实际利率** | `tips` | 10% | `gold_prices.tips_yield` | **黄金最重要单一驱动**，反向 |
| 波动率 | `volatility` | 5% | 从 closes 计算 ATR | 高波动→偏多避险（以 0.5%/日 ATR 为中枢） |
| 宏观阶段 | `regime` | 5% | `opts.macroRegime.tag` | 见 `REGIME_SIGNAL_MAP` |
| 事件热度 | `event_heat` | 0% | Tavily（预留） | 关键词计数，默认关闭 |

**改变因子权重时**：修改 `DEFAULT_WEIGHTS` 对象（`quant-score.ts`），确保总和 = 1.0。`event_heat` 启用时需在 `orchestrator.ts` 传入 `eventScore`。

**覆盖度重归一（2026-07 起，重要）**：缺数据的因子会被剔除，`score` 按**实际参与的权重**重归一，因此分数标尺与覆盖度无关。不这样做时，缺 `dxy`/`us10y`/`tips`/`regime`（合计 35%）会让中性行情算出 32.5 分并被读成「偏空」——生产日报里出现过覆盖度 70% → 36 分的例子，等于 FRED 一断线就自动看空。结果附带 `coverage` / `missingFactors` / `staleFactors`，覆盖度 < 75% 时报告会提示。

**宏观时效**：`macroAgeDays` 传入各宏观序列最新观测的滞后天数，超过 `MAX_MACRO_AGE_DAYS`（10 天）剔除并重归一，避免 FRED 中断时拿两周前的实际利率当今天的信号。FRED 锚定的 `timestamp` **必须用观测日**（`live-anchors.fetchFredLatest`），禁止写成 `new Date()`。序列与时效由 `pickMacroSeries`（`price-series.ts`）一起取出。

**改 `macro-regime.ts` 的 tag 时必须同步改 `REGIME_SIGNAL_MAP`**：两者曾经完全不相交（前者产出 `real_rate_headwind` 等，后者只认 `recession_risk` 等），该因子长期恒为 50。现在未知 tag 会被剔除而不是伪装成中性，`test/quant-score.test.ts` 有断言守住这条。

**数据流**：`orchestrator.ts` 从 `GoldPricesRepo.getRecent(120)` 一次查询提取 4 个序列（`closes/dxy/us10y/tips`），传入 `computeQuantScore()`。全链路无新增查询。

**因子函数签名必须不可变**：所有因子函数接受纯数据数组，返回 `QuantFactorDetail`，不访问 DB/网络/LLM。

### 展示与冲突
- **终端**：双分并排 + `formatQuantScoreConsole` 因子表 + `evaluateDualScore` 策略行  
- **Markdown**：`## ⚖️ 双打分机制` + 因子表 + 弃权说明（`report-md.ts`）  
- **Web**：`server.cjs` 双分横幅 / 冲突时「维持定投」  
- **校准**：`calibrate` LLM 分桶 + 量化分桶 + 方向命中 + 冲突日统计  
- 完整说明：**`docs/DUAL-SCORE.md`**

### 仓位推荐与预测对错（analysis 附带）
- **仓位**：`recommendPosition` → MD `## 📦 当前仓位推荐`；相对计划仓，非杠杆；红档/双分冲突收紧上限  
- **对错**：`buildPredictionTrackStats` → `docs/goldrush-stats-latest.json` + MD `## 📊 历史预测对错`  
- **Web**：首页/文章页解析 MD 仓位小节 + 读取 stats JSON 展示命中率等统计  
- **完整说明**：**`docs/POSITION-AND-TRACK.md`**  
- **规划（仓位 v2 等）**：**`docs/ROADMAP-FINENG.md`**  
- **测试**：`test/position-recommend.test.ts`、`test/prediction-track.test.ts`

### DB schema
```sql
analysis_reports.quant_score    REAL -- 量化评分（可为 NULL；新 analysis 写入）
analysis_reports.mid_term_score REAL -- 中期方向分，命中标签 20 个交易日
-- report_json 内 overall.quantFactors 为因子明细（可选）
```
迁移是幂等的（`ALTER TABLE ADD COLUMN`，列已存在则忽略）。

**落库时序**：`orchestrator` 在 LLM 合成后就 `insert`，并把行 id 挂到 `report.reportRowId`；长期/中期展望、仓位、门禁覆盖都是之后才补的，所以分析流程末尾必须调用 `ReportsRepo.updateFinal` 回写完整报告，否则 SQLite 里的 `report_json` 会比 `docs/*.md` 少一截，`history` / `diff` / `calibrate` 读到的是半成品。

**`institutional_flows.upsert` 一律 COALESCE**：各来源分开抓（`ensureCftc` 只带 CFTC 字段、GLD/PBOC 位置显式传 null），若写 `excluded.*`，刷新 CFTC 会清空同一天已抓到的 GLD 吨数与央行储备。

### 数据质量
- **`saveSnapshot` 过滤**：`source: 'N/A'`、值为 0 的字段不入库（`data-collector.ts` + `GoldPricesRepo.upsert` sanitize）。
- **`scenario_features` 迁移**：`cftc_percentile`、`etf_flow_5d`、`flow_score` 三列有幂等迁移（`db/index.ts`），旧 DB 自动补齐。
- **`institutional_flows`**：`flow --init` 回填 CFTC；**GLD 吨数 / PBOC 储备** 优先 **东财搜索新闻解析**（`etf-grabber` / `pboc-grabber`）；失败不编造。
- **flow 因子 15%**：CFTC+GLD+央行综合；单维缺失时该维中性，不编造持仓。
