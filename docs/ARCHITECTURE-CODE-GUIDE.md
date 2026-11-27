# GoldRush 技术架构与代码导读手册

> **适用版本**：`v2.4.0`（含 `v2.5-P1` 消息面真伪甄别与防钓鱼证伪引擎）  
> **代码规模**：`src/` 130 个 TypeScript 模块（ESM） · `web/` 17 个 CommonJS 模块 + `server.cjs` · `test/` 65 个单测文件（508 条用例）  
> **数据资产**：`docs/market-data/` 5 年日线（1,259 交易日）+ 26 年月线（315 月） · `docs/` 135 份 AI 分析日报 + 67 份 `.meta.json` 契约

---

## 1. 项目定位与设计哲学

**GoldRush** 是一个面向黄金研究与配置决策的**双形态系统**：

1. **CLI 研判与回测引擎（`src/`，TypeScript ESM）**：负责每日行情直连锚定、多 Agent 协作研判、纯本地多因子量化评分、回测校准、仓位风控、错因反思、Webhook 告警与 Markdown/JSON 报告产出。
2. **Web 报告与概率走势预测站（`server.cjs` + `web/`，零前端构建依赖的 Node HTTP + CJS SSR/CSR）**：对外提供日报阅读器、首页决策仪表盘以及**多周期概率走势预测台（`/forecast`：5/20/60 日 + 1/2/5 年）**，并内置 30 分钟自动行情增量同步与一键刷新。

### 1.1 核心分层设计思想：`Signals → Gates → Portfolio → Explain`

整个代码库的所有功能必须清晰落位到以下四层之一，绝不混写：

| 层级 | 职责边界 | 代表模块 |
|------|---------|---------|
| **Signals（信号层）** | 客观数据采集、八维正交打分（三基 + 五专）、纯量化 11 因子、FHS 概率路径 | `src/data/*`, `src/indicators/*`, `src/utils/eight-dimensions.ts`, `src/utils/news-veracity.ts`, `web/forecast-engine.cjs`, `web/forecast-longterm.cjs` |
| **Gates（门禁层）** | 数据质量红/黄/绿分档、双打分冲突裁决、消息真伪隔离、推理门控（`--smart`） | `src/utils/data-quality-gate.ts`, `src/utils/dual-score.ts`, `src/utils/analysis-gate.ts`, `src/utils/news-veracity.ts` |
| **Portfolio（仓位层）** | 相对「计划黄金仓」0–100% 映射、20 日波动缩放、60 日回撤刹车、单日 ±10% 调仓平滑、统一操作建议 | `src/utils/position-recommend.ts`, `src/utils/plain-advice.ts`, `src/utils/paper-equity.ts` |
| **Explain（解释与审计层）** | 强制反驳、评分构成拆解、可信度卡片、较昨日 Δ 归因、事件三通道传导、预测对错与 Brier/IC/Walk-Forward 校准 | `src/agents/rebuttal.ts`, `src/utils/reliability-card.ts`, `src/utils/day-delta.ts`, `src/utils/event-transmission.ts`, `src/utils/prediction-track.ts`, `src/utils/report-md.ts` |

---

## 2. 系统全局架构图

```text
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                    外部数据源（白名单直连 + 搜索 + LLM）                   │
│  [零 LLM 直连锚定]  gold-api.com · 新浪 hq(hf_GC/AU9999/518880) · Yahoo(GC=F/DXY/GLD)    │
│                     FRED(DFII10/DGS10/DGS2/DFF/CPI/DEXCHUS) · CFTC COT · LBMA · 东财新闻 │
│  [联网搜索]         Tavily API (@tavily/core, 含 SQLite 缓存)                            │
│  [LLM 推理]         /usr/local/bin/opencode run (CLI stdin 调用 + 4 级 JSON 自愈解析)    │
└───────────────────────────────┬───────────────────────────────┬─────────────────────────┘
                                │                               │
                                ▼                               ▼
┌─────────────────────────────────────────────┐ ┌─────────────────────────────────────────┐
│         CLI 引擎 (src/ · TypeScript ESM)     │ │    Web 实时同步与报告站 (server.cjs)     │
│  入口: src/index.ts (15 个 Commander 子命令)  │ │  端口: :3000 (零打包依赖, 纯 Node HTTP)  │
│  ┌───────────────────────────────────────┐  │ │  ┌───────────────────────────────────┐  │
│  │ Agents (src/agents/)                  │  │ │  │ 路由层:                           │  │
│  │  DataCollector → Validator →          │  │ │  │  GET /                日报索引页   │  │
│  │  [Tech,Fund,Sent,FundAgent] →         │  │ │  │  GET /*.md            报告阅读器   │  │
│  │  Rebuttal → Orchestrator              │  │ │  │  GET /forecast        走势预测台   │  │
│  └───────────────┬───────────────────────┘  │ │  │  GET /api/forecast    日期切换JSON │  │
│  ┌───────────────▼───────────────────────┐  │ │  │  GET /api/forecast/status          │  │
│  │ 本地指标 + 决策核心 (indicators/utils) │  │ │  │  POST /api/forecast/refresh        │  │
│  │  · 11因子纯量化 (quant-score.ts)       │  │ │  └───────────────┬───────────────────┘  │
│  │  · 八维正交契约 (eight-dimensions.ts)  │  │ │  ┌───────────────▼───────────────────┐  │
│  │  · 消息防钓鱼 (news-veracity.ts)       │  │ │  │ Web 计算镜像 (web/*.cjs)           │  │
│  │  · 数据门禁 / 双打分 / 仓位 v2         │  │ │  │  · market-sync.cjs (5Y/25Y 双写)   │  │
│  │  · 短(5D)/中(20D)/长(1-5Y) 三尺度      │  │ │  │  · forecast-data.cjs (日线+AI融合) │  │
│  │  · 回测校准 (IC/WalkForward/Brier/权益) │  │ │  │  · forecast-engine.cjs (5/20/60D)  │  │
│  └───────────────┬───────────────────────┘  │ │  │  · forecast-longterm.cjs (1/2/5Y)  │  │
└──────────────────┼──────────────────────────┘ │  │  · fhs-math / eight-dimensions /    │  │
                   │                            │  │    news-veracity (纯函数 CJS 镜像)   │  │
                   ▼                            │  └───────────────┬───────────────────┘  │
┌───────────────────────────────────────────────┴──────────────────▼──────────────────────┐
│                              双写持久化与文件契约层                                       │
│  1. SQLite (./data/goldrush.db, WAL模式):                                               │
│     gold_prices · fund_nav · analysis_reports · scenario_features ·                     │
│     search_cache · institutional_flows                                                  │
│  2. Git 可读产物 (./docs/):                                                              │
│     goldrush-analysis-YYYY-MM-DD.md + .meta.json (机器契约 Sidecar)                      │
│     goldrush-stats-latest.json (90天短/中期命中统计) · goldrush-reflect-latest.md/.json   │
│     market-data/gold-daily-5y.jsonl (5年日线) · gold-monthly-25y.jsonl (26年月线)        │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### 为什么 `src/`（TypeScript ESM）与 `web/`（CommonJS `.cjs`）并存？

- **`src/`** 采用 `"type": "module"` + `module: "Node16"` 编译到 `dist/`，用于命令行工具与离线深度研判。
- **`server.cjs` + `web/*.cjs`** 采用纯 CommonJS，目的是在生产服务器上**无需先 `tsc` 编译即可直接 `node server.cjs` 启动**，并且与前端内联模板解耦。
- 为防止两边逻辑漂移，核心数学与契约模块采用**严格对称镜像 + 跨侧单测锁定**：
  - `src/utils/fhs-math.ts` ⟷ `web/fhs-math.cjs`
  - `src/utils/eight-dimensions.ts` ⟷ `web/eight-dimensions.cjs`
  - `src/utils/news-veracity.ts` ⟷ `web/news-veracity.cjs`
  - `src/utils/report-meta.ts` ⟷ `web/report-meta.cjs`

---

## 3. 代码目录全景地图

```text
goldrush/
├── src/                        # CLI 与核心研判引擎（130 个 .ts 文件）
│   ├── index.ts                # Commander CLI 总入口（15 个命令 + 默认 dashboard）
│   ├── commands/               # 15 个 CLI 子命令编排层
│   ├── agents/                 # 7 个 Agent（采集、验证、4维分析、反驳、总编排）
│   ├── data/                   # 10 个外部数据源抓取与搜索路由器
│   ├── db/                     # 8 个 SQLite 初始化与 Repository
│   ├── indicators/             # 12 个纯本地技术/主力/专业维/量化评分计算模块
│   ├── schemas/                # 2 个 Zod 校验与 0 值净化 schema
│   ├── types/                  # 7 个全局 TypeScript 类型定义
│   └── utils/                  # 68 个纯函数算法、门禁、仓位、校准、报告渲染工具
├── server.cjs                  # Web HTTP 报告站与走势预测服务入口（:3000）
├── web/                        # 17 个 Web 端纯 CJS 引擎、数据融合、页面模板与安全模块
├── docs/                       # 每日报告(.md/.meta.json)、市场快照(market-data/)、规划文档
├── test/                       # 65 个 Vitest 自动化测试（508 条用例）
├── scripts/daily-analysis.sh   # 每日 11:30 cron 自动化调度脚本
├── goldrush.config.json        # 运行时配置（模型、搜索缓存、DB 路径、告警阈值）
├── tsconfig.json               # 生产编译配置（仅编译 src/ → dist/）
└── tsconfig.test.json          # 测试类型检查配置（校验 src/ + test/，防 fixture 漂移）
```

### 3.1 CLI 命令地图（`src/commands/`，15 个文件）

| 命令 | 文件 | 是否依赖 LLM/外网 | 核心职责 |
|------|------|------------------|---------|
| `goldrush`（无参） | `dashboard.ts` | 纯本地 | 终端速览仪表盘（最新金价、最近研判、仓位、命中率） |
| `goldrush analysis` | `analysis.ts` | 需 opencode + 外网 | **核心流水线**：采集→验证→四维→反驳→八维/量化→门禁→三尺度→仓位→落库→写 `.md`+`.meta.json`；支持 `--smart` 低波跳过 LLM |
| `goldrush price` | `price.ts` | 直连锚定 / LLM | 实时金价速查并自动写入 SQLite 快照 |
| `goldrush fund` | `fund.ts` | 需 LLM | 支付宝/场内黄金基金对比（000216/000217/002610/002611/518880） |
| `goldrush flow` | `flow.ts` | 已有数据可纯本地 | 主力动向监测（CFTC COT + SPDR GLD + PBOC 储备 + 价格背离检测） |
| `goldrush calibrate` | `calibrate.ts` | 纯本地 | 回测校准总入口：分桶校准、`--tearsheet` 纸面权益、`--ic` Spearman 因子 IC、`--walk-forward` 样本外验证、`--brier` 情景概率校准 |
| `goldrush outlook` | `outlook.ts` | 纯本地 | 按最新报告重算 1/3/5 年长期配置展望，无需重跑 LLM |
| `goldrush path` | `path.ts` | 纯本地 | 概率路径扇形图（`P10/P50/P90` 纯本地 SVG） |
| `goldrush reflect` | `reflect.ts` | 纯本地 | 周末预测错因反思，输出 `goldrush-reflect-latest.md/.json` 并反馈给下周分析 Prompt |
| `goldrush digest` | `digest.ts` | 纯本地 | 7 日/周期摘要（均分、多空分布、最大分差跳变） |
| `goldrush diff <A> <B>` | `diff.ts` | 纯本地 | 两日分析报告差分（评分、四维、情景概率变化） |
| `goldrush history` | `history.ts` | 纯本地 | 查询 SQLite 本地 `prices` / `reports` / `funds` |
| `goldrush snapshot` / `init-history` | `snapshot.ts` | 外网 | 手动存快照 / 首次回填 60 日历史金价 |
| `goldrush sync-market` | `sync-market.ts` | 外网（零 LLM） | 同步 5 年日线 + 26 年月线宏观/CFTC 数据，双写 SQLite + `docs/market-data/*.jsonl` |
| `goldrush notify` | `notify.ts` | Webhook | 每日任务结果或大幅波动告警推送 |

### 3.2 Agent 协作层（`src/agents/`，7 个文件）

| 文件 | 类/职责 | 关键工程设计 |
|------|--------|-------------|
| `base.ts` | `BaseAgent` | 通过 `execSync('/usr/local/bin/opencode run')` + `stdin` 传 Prompt（避开 shell 长度/转义限制）；模型配置收口为单一来源 `goldrush.config.json` 的 `model`（`null` 继承 opencode 默认模型）；内置 **4 级 JSON 自愈解析**（深度清洗 → 代码块提取 → 引号状态机修复 → 回喂 LLM 修复）与 `AgentTimeoutError` |
| `data-collector.ts` | `DataCollectorAgent` | **先锚定、后搜索**：Step 1a 先直连 `fetchLiveAnchors()` 建骨架（保证零 LLM 也有伦敦金/上海金/ETF），Step 1b 再用 Tavily + LLM 补全细节，Step 1c 再次 merge 锚定并做 >3% 偏差拦截（原值进 `altPrices` 审计）；同步归档搜索原文至 `docs/search-raw/` |
| `validator.ts` | `ValidatorAgent` | 多源交叉验证、A/B/C 信源评级、单源触发 Tavily 补搜抽价、加权计算整体数据置信度（伦敦金权重 50%） |
| `analysis-agents.ts` | `TechnicalAgent` / `FundamentalAgent` / `SentimentAgent` / `FundAgent` | 各自接收本地预计算客观指标（MA/RSI/MACD/周线/主力动向），输出结构化 JSON（强制含 `counterPoints` 反方论据）；v2.5 在 `SentimentAgent` 中加入 A/B/C 信源纪律与跨市场防钓鱼 Prompt；全部配有 `*_FALLBACK` 超时优雅降级 |
| `rebuttal.ts` | `RebuttalAgent` | **强制反驳 Agent**：专职扮演空头/逆向审稿人，针对四维结论找漏洞、识别尾部风险（`tailRisks`），给出 `bearScore` 与 `rebuttalStrength`，直接参与 `adjustScoreWithRebuttal` 扣分修正 |
| `orchestrator.ts` | `OrchestratorAgent` | 汇总四维 + 反驳 + 校准偏移 + 情景概率 + 量化评分 + **v2.4 八维正交画像** + **v2.5 消息真伪审计（`auditNewsVeracity`）**，输出双视角策略并首次落库 `ReportsRepo.insert` |

### 3.3 外部数据采集层（`src/data/`，10 个文件）

- `live-anchors.ts`：零 LLM 直连瀑布锚定核心（gold-api.com 现货金、新浪 `hf_GC`/`gds_AU9999`/`sh518880`、FRED 10Y/TIPS/宽美元——**严格保留观测日 `timestamp`**，绝不伪造 `new Date()`）。
- `yahoo-gold-history.ts` / `yahoo-live.ts`：Yahoo Finance `GC=F` 历史日线与实时行情，Yahoo 超时自动回落 **LBMA 下午定盘价**。
- `cftc-grabber.ts`：CFTC 公开报告（非商业净多头、持仓量 OI、报告日期）。
- `eastmoney-search.ts` + `etf-grabber.ts` + `pboc-grabber.ts`：因海外 SPDR CSV 常不可达，优先经东方财富搜索新闻结构化抽取 **SPDR GLD 吨数** 与 **PBOC 央行黄金储备**，抓不到返回 `null` 绝不编造。
- `search-router.ts` + `tavily-client.ts`：统一搜索路由 + SQLite `search_cache`（默认 5 分钟 TTL）；未配 `TAVILY_API_KEY` 时优雅降级为空数组。

### 3.4 本地指标与量化引擎（`src/indicators/`，12 个文件）

| 分类 | 文件 | 职责说明 |
|------|------|---------|
| 基础技术指标 | `ma.ts`, `rsi.ts`, `macd.ts`, `bollinger.ts`, `percentile.ts` | 纯数学序列计算（均线、14 日 RSI、MACD 金死叉、布林 %B、历史百分位） |
| 主力动向 | `flow-signal.ts` | 合成 CFTC + GLD ETF + 央行购金综合分与价量背离标注 |
| 纯量化打分 | `quant-score.ts` | **零 LLM、100% 可复现** 11 因子评分（见 §4.2），带覆盖度重归一与 10 天宏观时效淘汰 |
| v2.4 五专正交计算 | `capital-flow.ts` (S1), `policy-cycle.ts` (S2), `behavioral-sentiment.ts` (S3), `positioning-chip.ts` (S4) | 严格按「零跨维重复计分」拆分出的四套专业维纯函数指标引擎 |

### 3.5 Web 端模块地图（`server.cjs` + `web/`，18 个文件）

| 模块 | 职责 |
|------|------|
| `server.cjs` | HTTP 服务总入口（端口 3000），承载首页索引、Markdown 日报渲染（含决策面板、双打分条、三尺度横条、可信度与预测对错）、`/forecast` 与 `/api/forecast*` 路由，并防路径穿越与跨站 POST |
| `web/market-sync.cjs` | 零 LLM 5 年日线 + 26 年月线多源同步引擎：固定 5 个 HTTPS 官方域名白名单（Yahoo/FRED/gold-api/新浪/CFTC）、30s 手动刷新冷却 + 并发锁 + 30min 后台自动同步、**F15 期现基差复权**（消除 GC=F 与现货拼接跳空）、双写 SQLite + `docs/market-data/*.jsonl` |
| `web/forecast-data.cjs` | 融合 5 年实盘日线 JSONL 与 `docs/goldrush-analysis-*.md/.meta.json`，带 mtime+size 内存缓存；有 AI 日报日叠加事件传导与门禁，无 AI 日报日诚实标明纯实盘推导 |
| `web/forecast-engine.cjs` | **5/20/60 日走势预测核心引擎**：因果特征提取 → 去均值对数 FHS → 9 维 Z-score 相似核 + 去重叠降权 → Kish $N_{\text{eff}}$ 经验贝叶斯权重混合 → 噪音自适应收缩 → 八维短中期评分 → 严格零前视 `actualReplay` |
| `web/forecast-longterm.cjs` | **1/2/5 年长期宏观周期预测引擎**：基于 26 年连续月线 + 55 年黄金/CPI 实际购买力先验锚（F13），与日线消息/情绪严格 0% 脱钩，输出三情景目标价、CAGR、跑赢通胀概率与独立周期相似案例 |
| `web/fhs-math.cjs` | 共享金融工程数学核心 CJS 镜像（F01 几何峰谷回撤、F02 去均值对数 FHS、F04 同源混合分位与概率） |
| `web/eight-dimensions.cjs` | 八维动态权重装配与 Top 4 主导维度切分 CJS 镜像 |
| `web/news-veracity.cjs` | v2.5 消息真伪与跨市场防钓鱼证伪 CJS 镜像（供 B2 徽章、S3 反向修正与短周期噪音收缩使用） |
| `web/forecast-page.cjs` | `/forecast` 页面 SSR HTML + 交互式 SVG 扇形图（USD/CNY/% 切换、6 视野切换、历史日期回放、`actualReplay` 实盘对比、八维矩阵、可查证据链审计表） |
| `web/report-meta.cjs` & `web/report-extract.cjs` | 机器可读 `.meta.json` 读取器与历史 Markdown 正则回落解析器（按表头名取列，防版式微调崩坏） |
| `web/horizon-strip.cjs` / `list-card-meta.cjs` / `prob-path-panel.cjs` / `article-collapse.cjs` / `nav-tabs.cjs` / `md-sanitize.cjs` / `theme-css.cjs` | 报告站 UI 组件、DOMPurify HTML 消毒防 XSS、长文默认折叠与 Apple Glass 主题样式 |

---

## 4. 核心业务与算法链路导读

### 4.1 每日综合分析完整流水线（`src/commands/analysis.ts`）

阅读每日研判主流程时，直接顺着 `analysisCommand()` 的执行阶段往下看：

```text
Step 0   ensureGoldPriceHistory(60天) —— Yahoo GC=F 补齐历史金价（失败回落 LBMA）
         └─ 若开启 --smart：evaluateAnalysisGate() 检查近5日波动，平静日直接复用上日研判（仍输出仓位与可信度）
Step 1   DataCollectorAgent.collectMarketData() —— 先直连锚定，再 Tavily+LLM 补全，再偏差 >3% 锚定覆盖
         ValidatorAgent.validate() → evaluateDataQualityGate() 评出绿/黄/红三档门禁
Step 1.8 ensureInstitutionalFlows() + computeInstitutionalSignal() —— 补齐 CFTC/GLD/央行并算主力分
Step 2   两批并行四维分析：[TechnicalAgent, FundamentalAgent] → [SentimentAgent, FundAgent]
         （任一超时或异常由 analyzeWithFallback 自动降级，不拖垮全链路）
Step 2.5 RebuttalAgent.rebut() 强制反驳 → buildScoreBreakdown() → detectMacroRegime() → matchCausalChains()
         同时加载近30日历史报告 + 周末错因反思(weekly-reflect) + ScenarioFeatures 历史相似日情景概率
Step 3   OrchestratorAgent.orchestrate():
         ├─ 计算纯量化 11 因子 (computeQuantScore)
         ├─ 计算 v2.4 八维画像 (capital-flow / policy-cycle / behavioral-sentiment / positioning-chip)
         ├─ 执行 v2.5 消息面真伪审计 (auditNewsVeracity) → 净 B2 分 + S3 防钓鱼反向修正
         ├─ 合成校准偏移后的 overall.score，首次 ReportsRepo.insert() 拿到 reportRowId
Step 4   后置决策装配（全部纯本地确定性计算）：
         ├─ evaluateDualScore() 双打分对齐/冲突判定
         ├─ buildLongTermOutlook() (1/3/5年) + buildMidTermOutlook() (1~3个月)
         ├─ recommendPosition() 仓位 v2（门禁红 ≤35%，双分冲突 ≤50%，20D波动缩放，60D回撤刹车，日平滑±10%）
         ├─ buildPredictionTrackStats() → 写入 docs/goldrush-stats-latest.json
         ├─ buildDayDelta() 较昨日变化归因 + buildReliabilityCard() 可信度卡片
         ├─ buildEventGoldTransmission() 事件三通道传导 + 防钓鱼警示
         ├─ buildReadingChecklist() 今日必看 5 步 + attachProbPath() 本地概率扇形路径
Step 5   ReportsRepo.updateFinal(reportRowId, report) —— ★ 关键：将后置补全的完整报告回写 SQLite
         formatReportMarkdown() → 写 docs/goldrush-analysis-YYYY-MM-DD.md + .meta.json sidecar
```

> **读代码必知陷阱**：`OrchestratorAgent` 在 Step 3 先 `insert` 一条报告拿到 `reportRowId`，而中期/长期展望、仓位推荐、门禁覆盖都是在 Step 4 补齐的；因此 Step 5 必须执行 `ReportsRepo.updateFinal()`，否则数据库里存的是半成品。

### 4.2 双打分体系（LLM 主轨 vs 11 因子量化轨）

- **LLM 评分（主）**：四维分析 → 反驳扣分（`rebuttal-score.ts`）→ 历史系统偏差校准（`calibration-adjust.ts`）。
- **量化评分（参，`src/indicators/quant-score.ts`）**：零 LLM、100% 可复现。当前权重总和 `1.00`：
  - `flow` (15%) · `trend` (14%) · `tips` (13%) · `dxy` (12%) · `rsi` (10%) · `macd` (10%) · `valuation` (8%) · `us10y` (8%) · `bollinger` (5%) · `regime` (5%)
  - `volatility` (**0%**，v2.4 F07 修复：波动率属无方向风险尺度，退出方向打分，仅用于风控与带宽缩放)
  - `event_heat` (**0%**，默认关闭)
- **覆盖度重归一 + 宏观 10 天时效**：缺数据或宏观观测滞后 `> 10` 天（`MAX_MACRO_AGE_DAYS`）的因子直接剔除，按剩余有效权重重归一，避免 FRED 断线把中性行情误算成看空；覆盖度 `< 75%` 发出提示。
- **冲突裁决（`src/utils/dual-score.ts`）**：`|LLM - 量化| > 15` 或方向相反时进入 `hold_on_conflict`，不强行调高单侧权重，而是收紧目标仓位上限至 `≤ 50%`、定投为主，并用 `alignDualOverrideWithPosition` 统一 CLI/MD/Web 文案。

### 4.3 八维全景正交体系（v2.4 三基 + 五专）

契约唯一来源：`src/utils/eight-dimensions.ts`（镜像 `web/eight-dimensions.cjs`）。核心铁律是**正交不重复计分**与**多时间尺度隔离**：

| 编号 | 维度 | 核心独占指标（绝不跨维复算） | 5D | 20D | 60D | 1Y | 2Y | 5Y |
|------|------|----------------------------|----|-----|-----|----|----|----|
| **B1** | 基本面 | 10Y TIPS 水平、CPI、真实金价/CPI、DXY 相对 MA60 | 5% | 20% | 25% | 30% | 35% | 35% |
| **B2** | 消息面 | 事件三通道传导、v2.5 真伪核验、预期差催化 | 15% | 5% | **0%** | **0%** | **0%** | **0%** |
| **B3** | 技术面 | MA20/MA50/MA60 结构、MACD、布林带结构位 | 20% | 12% | 10% | 8% | 5% | 5% |
| **S1** | 资金面 | GLD 5D/20D 动量、CFTC 4W 边际 Δ、COMEX 量比、SGE 溢价 | 20% | 18% | 15% | 8% | 5% | 5% |
| **S2** | 政策面 | 联储利率周期、TIPS 60D 斜率、2s10s 曲线、PBOC 储备 | 0% | 10% | 15% | 22% | 25% | 25% |
| **S3** | 情绪面 | GVZ/VIX 恐慌、RSI 极端反转段、连涨连跌羊群、防钓鱼反向警示 | 15% | 5% | **0%** | **0%** | **0%** | **0%** |
| **S4** | 筹码面 | CFTC 3 年拥挤分位（极端反向）、60D 量权成本 VWAP、AISC 底盘 | 7% | 15% | 20% | 17% | 15% | 15% |
| **S5** | 量化面 | 去均值对数 FHS、Wilder ATR 风险带、有效样本 $N_{\text{eff}}$ | 18% | 15% | 15% | 15% | 15% | 15% |

- 任意视野若某维度缺数（`score == null` 或 `coverage == 0`），自动剔除并重归一；有效权重覆盖 `< 70%` 触发降级横幅。
- `60D / 1Y / 2Y / 5Y` 严格将 **B2 消息面** 与 **S3 情绪面** 权重锁死在 `0%`，防止短线突发噪音污染中长期周期预测。

### 4.4 消息面四道防线与防钓鱼证伪（v2.5-P1）

实现位于 `src/utils/news-veracity.ts`（镜像 `web/news-veracity.cjs`），并已接入 `orchestrator.ts`、`event-transmission.ts`、`analysis-agents.ts` 与 `web/forecast-engine.cjs`：

1. **信源严格分级（`gradeNewsSourceStrict`）**：A 级（美联储/BLS/PBOC/COMEX/LBMA/WGC）、B 级（路透/彭博/财联社/金十等主流电讯）、C 级（社媒/自媒体/匿名）——**新闻场景下未知来源强制降为 C 级**（宁缺毋滥）。
2. **时效半衰期与文本识别**：底层事件超过 **72 小时** 直接标为 `stale_rehash` 归零；有效消息按 **36 小时指数半衰期**（$2^{-t/36\text{h}}$）自然衰减；正则识别匿名吹风（"知情人士/据传/小作文"）与标题党煽动词。
3. **三通道跨市场价格证伪**：用真金白银投票验证消息——综合 **10Y TIPS 变动（35%）+ 金价当日二阶反应（30%）+ DXY 变动（25%）+ GLD 5 日资金流（10%）** 计算客观 `marketVote ∈ [-1, +1]`，结合 CFTC 拥挤度判定：
   - 利多宣称 + 跨市场反向走弱 → **`bait_trap`（疑似利多钓鱼/高位派发）**
   - 利空恐慌 + 跨市场反向走强 → **`bait_trap`（疑似利空诱空/情绪错杀）**
4. **正交分流与噪音自适应收缩**：
   - `verified_fact` 进入 **B2 消息面**；
   - `noise_filtered` / `unconfirmed_rumor` / `stale_rehash` 权重严格置 `0`；
   - `bait_trap` 从 **B2 事实层彻底剥离**（`effectiveWeight = 0`），同时提取 `contrarianSentimentBias`（-15..+15）与 `baitAlert` 注入 **S3 情绪面**，并在短期（5D/20D）FHS 预测中通过 `noiseShrinkageBoost` 抬高经验贝叶斯收缩 $\lambda$，减少假信号带偏方向。

### 4.5 多周期概率走势预测引擎（`web/forecast-engine.cjs` & `forecast-longterm.cjs`）

所有概率预测遵循**严格因果零前视（Zero Look-Ahead）**，截断 `asOf` 之后的全部价格不得改变当日任何输出：

- **数学内核（`fhs-math.ts/.cjs`）**：
  - **F02 去均值单步对数 FHS**：$r_k = \ln(P_{d+k}/P_{d+k-1})$，$\tilde{r}_k = \mu_0 + \frac{\sigma_0}{\sigma_d}(r_k - \mu_0)$，保证价格严格为正且不放大期望漂移。
  - **F01 严格几何峰谷回撤**：区分「峰谷最大回撤 `maxDrawdownPct`」与「相对起点最大浮亏 `maxUnderwaterPct`」。
  - **F04 样本权重层经验贝叶斯混合**：先对相似历史样本去重叠降权，算出 Kish 有效样本数 $N_{\text{eff}} = (\sum w_i)^2 / \sum w_i^2$，计算收缩系数 $\lambda = K / (N_{\text{eff}} + K)$（红档门禁强制 $\lambda = 1$；噪音/钓鱼日额外叠加 `noiseShrinkageBoost`），在样本权重层构造 $w_{\text{mix}} = (1-\lambda) w_{\text{norm}} + \lambda / N$，再由同一套 $w_{\text{mix}}$ 计算 `P10/P25/P50/P75/P90` 与收涨胜率，保证分位数与概率 100% 数学自洽。
  - **F12 人民币联合汇率路径**：利用历史 `USD/CNY` 联合汇率序列同步模拟人民币克价路径与回撤，不再用静态汇率硬乘。
  - **F13 长期真实购买力先验锚**：1Y/2Y/5Y 基于 26 年连续月线 + 1971+ 黄金/CPI 实际购买力长周期锚，并强制相似周期起点间隔 $\ge 12$ 个月。

---

## 5. 数据存储与契约规范

### 5.1 SQLite 数据库（`src/db/index.ts`，WAL 模式，6 张核心表）

| 表名 | 主键 | 关键字段与设计约束 |
|------|------|------------------|
| `gold_prices` | `date` | 伦敦/上海 OHLC、ETF 净值、DXY、US10Y、TIPS；**禁止把 `0` 当有效金价**（写入过滤 + `mapRow` 读库净化 + `forwardFill` 跳过 `<=0`） |
| `fund_nav` | `(date, code)` | 追踪基金净值、累计净值、涨跌幅与场内溢价率 |
| `analysis_reports` | `id` (自增) | `date`, `horizon`, `report_json`, `overall_score`, `quant_score`, `mid_term_score`, `direction`（列迁移幂等） |
| `scenario_features` | `id` (自增) | 决策日宏观/主力特征向量 + 事后回填 `actual_5d_return` / `actual_20d_return` / `backfill_status`，供历史相似日与回测使用 |
| `institutional_flows` | `date` | CFTC 持仓、GLD/IAU 吨数、国内黄金 ETF 份额、PBOC 储备；**`upsert` 一律使用 `COALESCE`**，避免单独刷新 CFTC 时覆盖当日已抓取的 GLD/PBOC |
| `search_cache` | `query_hash` | Tavily 搜索结果缓存（带 `expires_at` 过期控制） |

### 5.2 文件契约（`docs/`）

- `docs/goldrush-analysis-YYYY-MM-DD.md` + `docs/goldrush-analysis-YYYY-MM-DD.meta.json`：Markdown 供人读，`.meta.json` sidecar 供 `server.cjs` 决策面板直接消费，避免版式微调导致正则静默失效。
- `docs/goldrush-stats-latest.json`：近 90 日短（5D LLM/量化）与中（20D）分轨预测命中统计，带 Wilson 95% 置信区间（含重叠窗口 HAC 修正）及「永远看涨」朴素基准。
- `docs/market-data/gold-daily-5y.jsonl` & `gold-monthly-25y.jsonl` & `sync-meta.json`：5 年日线与 26 年月线 Git 可追踪快照，与 SQLite 双向同步。

---

## 6. 核心不变铁律与单一事实来源（SSOT）

修改代码前，务必先确认以下唯一权威模块，**禁止在别处复制硬编码常量**：

| 规则主题 | 唯一权威来源 | 约束说明 |
|---------|-------------|---------|
| 方向阈值 / 持平死区 / 命中判定 / HAC Wilson CI | `src/utils/decision-thresholds.ts` | 偏多 `>=58`、偏空 `<=42`、持平死区 `±0.1%`、展示口径与记账口径严格一致；样本 `<10` 标明不具统计意义 |
| 前瞻收益窗口 | `src/utils/forward-return.ts` | 命中统计与因子 IC 共用同一前瞻收益定义，禁止 T→T+5 与 T+1→T+6 各算各的 |
| 门禁三档规则 | `src/utils/data-quality-gate.ts` | 红档（无金价 / 锚定偏差 >3% / 置信度 <35 / 伦敦金 >96h 未更新）关闭操作结论；严禁用 `conf < 55` 一刀切 |
| 仓位基础档位与风险刹车 | `src/utils/position-recommend.ts` | `scoreToBasePct` 唯一映射；红档 `<=35%`、双分冲突 `<=50%`、单日调仓 `±10%` 平滑；纸面权益回放必须复用 |
| 统一操作建议文案 | `src/utils/plain-advice.ts` (`resolveOperationalAdvice`) | 优先级：门禁红 → 双分分歧 → 仓位推荐 → 分数人话，确保 CLI / MD / Web 永不自相矛盾 |
| 八维正交权重与指标归属 | `src/utils/eight-dimensions.ts` (`web/eight-dimensions.cjs`) | 静态表 `DIMENSION_METRIC_OWNERSHIP` 经单测守护零重复计分 |
| FHS 数学与回撤 | `src/utils/fhs-math.ts` (`web/fhs-math.cjs`) | 严禁对累计百分比线性缩放或用端点最小浮亏替代几何峰谷回撤 |

---

## 7. 开发、测试与运维速查

### 7.1 常用命令

```bash
# 1. 启动 Web 报告站与走势预测台（默认端口 3000）
npm run dev                  # 或 npm start（直接运行 node server.cjs）

# 2. 开发模式运行 CLI（无需编译，走 tsx）
npm run cli -- history
npm run cli -- calibrate --tearsheet --ic --brier
npm run cli -- flow
npm run cli -- sync-market

# 3. 生产编译 + 严格类型检查（含 test/ fixture 校验）
npm run build                # tsc -> dist/
npm run lint                 # tsc --noEmit && tsc -p tsconfig.test.json

# 4. 运行全部 65 个自动化测试（508 条用例）
npm test                     # vitest run
```

### 7.2 自动化定时运维（`scripts/daily-analysis.sh`）

生产环境由 cron 每日 `11:30` 触发：

1. `git pull --rebase` + `npm run build` 确保 `dist/` 最新；
2. 执行 `node dist/index.js analysis --md` 产出当日报告与 `.meta.json`；
3. 执行 `node dist/index.js flow --md` 产出主力监测日报；
4. 执行 `node dist/index.js notify --daily --exit "$EXIT_CODE"` 发送 Webhook 告警；
5. 每周日自动加跑 `digest --days 7 --md` 与 `reflect --days 14 --md --refresh-stats`，闭环驱动下周研判。

### 7.3 新人代码阅读推荐路线

- **30 分钟快速上手（建立全景）**：
  1. `src/index.ts`（了解全部 15 个命令）
  2. `src/db/index.ts`（看清 6 张表与迁移规则）
  3. `src/utils/decision-thresholds.ts` & `src/utils/eight-dimensions.ts`（掌握核心口径与权重矩阵）
  4. `server.cjs` 末尾路由段（lines 1779–1959，理解 Web 服务全景）
- **2 小时深入核心算法**：
  1. `src/commands/analysis.ts`（通读 Step 0 → Step 5 主干链路）
  2. `src/indicators/quant-score.ts` & `src/utils/news-veracity.ts`（纯量化 11 因子与防钓鱼四道防线）
  3. `src/utils/data-quality-gate.ts` → `src/utils/dual-score.ts` → `src/utils/position-recommend.ts`（门禁到仓位闭环）
  4. `web/forecast-engine.cjs` & `web/forecast-longterm.cjs` & `web/fhs-math.cjs`（短中长全周期 FHS 预测引擎）
- **改动前必读约束文档**：
  - `AGENTS.md`（全仓工程红线）
  - `docs/DECISION-QUALITY.md` & `docs/DATA-QUALITY.md`
  - `docs/PLAN-V2.4-FINENG-AUDIT.md` & `docs/PLAN-V2.5-NEWS-VERACITY-ALPHA.md`
