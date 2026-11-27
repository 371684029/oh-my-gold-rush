# GoldRush v2.6 规划文档：全链路校准闭环、宏观预期差、数据补齐与工程治理

> **目标版本号**：`v2.6.0`（承接 `v2.4.0` 八维正交与 `v2.5-P1` 消息防钓鱼证伪引擎）  
> **核心原则**：**准确率可实证、契约单一来源、弱网高容错、服务器低负载稳定运行**  
> **显式排除项（重要架构红线）**：**刻意保持 `BaseAgent` 串行低并发调用（`concurrency = 1`），不实施 `opencode` 高并发改造**——生产服务器资源与上游模型网关在高并发下易过载抖动，优先保障单次任务稳定完成。

---

## 1. 架构落点（Signals → Gates → Portfolio → Explain → Infra）

| 层级 | v2.6 升级项 | 对应模块 |
|------|------------|---------|
| **Signals（信号层）** | M3 宏观日历预期差 $z$-score · M5 分宏观体制动态特征核 · M6 补齐 GVZ / US2Y / SGE 溢价入库 | `src/utils/macro-surprise.ts`, `src/utils/regime-kernel.ts`, `src/db/gold-prices.ts`, `web/market-sync.cjs` |
| **Gates（门禁与容错层）** | M7 外部数据源熔断器（Circuit Breaker，连续失败自动冷却跳过） | `src/utils/source-circuit-breaker.ts`, `src/data/live-anchors.ts`, `web/market-sync.cjs` |
| **Explain & Calibration（审计校准层）** | M4 CRPS 概率扇面评分 + P10–P90 区间覆盖率 + `calibrate --crps / --news-audit` · M9 `/forecast` 历史实盘校准成绩单 | `src/utils/prob-calibration.ts`, `src/commands/calibrate.ts`, `web/forecast-scorecard.cjs` |
| **Infra（工程基建层）** | M1 消除 TS/CJS 核心模块人工双写（自动同步脚本） · M2 补齐 68 份历史老日报 `.meta.json` · M8 拆分 `server.cjs` 超大单文件 · M9 首页目录索引缓存与按月筛选 | `scripts/sync-web-cjs.mjs`, `scripts/backfill-meta.mjs`, `web/docs-index.cjs`, `server.cjs` |

---

## 2. 九大核心优化模块拆解

### M1：消除 `src/` 与 `web/*.cjs` 核心模块人工双写（单源自动同步）
- **痛点**：`fhs-math`、`eight-dimensions`、`news-veracity` 等纯数学/契约模块同时维护 TS（ESM）和 CJS 两份源码，后续迭代极易产生口径漂移。
- **方案**：新增 `scripts/sync-web-cjs.mjs`（利用仓库已有 `typescript` 编译器 API，零新增依赖），从 `src/utils/` 单一权威源自动编译生成 `web/*.cjs` 镜像（含 `fhs-math`、`eight-dimensions`、`source-circuit-breaker`、`macro-surprise`、`regime-kernel`），并纳入 `npm run sync:web` 与自动化一致性单测守卫。

### M2：补齐历史 68 份老日报 `.meta.json` Sidecar
- **痛点**：2026-06 至 2026-08 共 68 份历史日报缺少 `.meta.json`，Web 端每次加载均需走正则回落。
- **方案**：新增 `scripts/backfill-meta.mjs`，复用 `web/report-extract.cjs` 与统一方向阈值规则为所有缺失 sidecar 的历史日报一次性补齐 `schemaVersion: 1` 的 `.meta.json`（标注 `backfilledFromMarkdown: true` 保障审计诚实性），实现全量 135/135 份日报统一契约。

### M3：宏观经济日历「预期差（Surprise $z$-score）」引擎
- **痛点**：仅靠文本情感无法区分“CPI 2.9% 绝对值偏高但低于市场预期 3.1%（实际利多黄金）”与“高于预期（实际利空黄金）”。
- **方案**：新建 `src/utils/macro-surprise.ts`（自动镜像至 `web/macro-surprise.cjs`），内置黄金核心宏观指标库（CPI / Core CPI / PCE / Core PCE / 非农 NFP / 失业率 / FOMC 利率 / GDP / ISM PMI / 零售销售）及历史标准差 $\sigma_{\text{hist}}$，自动计算标准化预期差 $z = (\text{Actual} - \text{Consensus}) / \sigma_{\text{hist}}$ 与对黄金方向映射，并接入 `news-veracity.ts` 与 `orchestrator.ts` 自动从新闻摘要中抽取 `Actual vs Consensus` 提升 B2 精准度。

### M4：整条概率扇面校准（CRPS + P10–P90 覆盖率）与 `calibrate --news-audit`
- **痛点**：此前主要追踪中位数方向命中率与情景 Brier，缺少对 `P10–P90` 整条概率扇面宽窄是否校准的量化检验，也缺少防钓鱼滤网开启前后的事后胜率对照。
- **方案**：
  - 新建 `src/utils/prob-calibration.ts`：实现分位数近似 **CRPS**、相对无条件基准的 **CRPSS**、**P10–P90（目标 75%–85%）** 与 **P25–P75（目标 45%–55%）** 实盘覆盖率诊断；
  - 实现 `buildNewsAuditStats`：按 `verified_fact` / `bait_trap` / `noise_filtered` 分组计算 T+1 / T+5 实盘收益、HAC 修正 Wilson 95% 区间命中率与滤网净提升；
  - CLI `goldrush calibrate` 新增 `--crps` 与 `--news-audit` 两个子开关。

### M5：分宏观体制（Regime-Aware）动态特征核
- **痛点**：`web/forecast-engine.cjs` 中 9 维相似历史检索权重为固定常量，在加息紧缩、降息宽松、滞胀避险三种体制切换时响应偏慢。
- **方案**：新建 `src/utils/regime-kernel.ts`（同步 `web/regime-kernel.cjs`），仅使用截止 `asOf` 的严格因果指标（TIPS 水平与 60 日变动、DXY 偏离 MA60、2s10s 利差、20D 实现波动/GVZ）实时判别所处宏观体制，对 9 维距离权重施加带安全收缩（shrinkage toward base）的体制倾斜，并在 `/api/forecast` 与 `/forecast` 页面公开展示当前体制标签与权重解释。

### M6：补齐三大黄金专属序列（GVZ、US2Y、SGE 实时溢价持久化）
- **痛点**：SQLite `gold_prices` 此前未落库 `gvz`、`us2y_yield`、`sge_premium_usd` 三列，导致 CLI 端 S1/S2/S3/S4 专业维覆盖度受限。
- **方案**：
  - `src/db/index.ts` 增加幂等列迁移：`gvz REAL`、`us2y_yield REAL`、`sge_premium_usd REAL`；
  - `src/db/gold-prices.ts` 与 `web/market-sync.cjs` 双向读写并受 `COALESCE` 保护；
  - `src/data/live-anchors.ts` 补拉 FRED `DGS2` 并利用伦敦金/上海金/USDCNY 实时计算并持久化 SGE 美元溢价。

### M7：外部数据源熔断器（Circuit Breaker）
- **痛点**：Yahoo / FRED / SPDR 在弱网或海外限流时段频繁超时，每次同步或采集都要白等十余秒。
- **方案**：新建 `src/utils/source-circuit-breaker.ts`（同步 `web/source-circuit-breaker.cjs`），对各独立域名维护连续失败计数、默认 2 次失败熔断、15 分钟冷却期与半开探针恢复；接入 `live-anchors.ts` 与 `market-sync.cjs`，并在 `/api/forecast/status` 返回 `sourceHealth` 快照。

### M8：拆分超大单文件，降低维护耦合
- 将 `server.cjs` 中的 `docs/` 文件扫描、按月分组、mtime 缓存与卡片元数据组装抽离为独立模块 `web/docs-index.cjs`；
- 将 `/forecast` 页面的历史校准成绩单计算与渲染抽离为独立模块 `web/forecast-scorecard.cjs`。

### M9：Web 报告站索引缓存 + 按月筛选 + `/forecast` 实盘校准成绩单
- **首页 (`GET /`)**：接入 `web/docs-index.cjs` 的目录 `mtime` 失效内存缓存（避免每次刷新同步扫盘百余篇 Markdown），并在搜索栏新增按月筛选按钮（`全部` / `2026-11` / `2026-10` / …）与结果计数；
- **走势预测页 (`/forecast`)**：新增「历史实盘校准成绩单（零前视）」面板，直接展示近 90 日 5D/20D **P10–P90 区间覆盖率**、**CRPS / CRPSS**、**方向胜率**、**防钓鱼拦截统计** 与 **宏观体制动态核状态**。

---

## 3. 验收标准

| 维度 | 量化验收标准 |
|------|------------|
| **并发安全红线** | `src/agents/base.ts` 保持串行执行，不引入并发子进程风暴 |
| **单源同步** | `npm run sync:web` 生成的 CJS 镜像与 TS 源码 100% 行为一致并通过单测锁定 |
| **契约完备率** | `docs/goldrush-analysis-*.md` 对应 `.meta.json` 覆盖率达到 100%（135/135） |
| **算法严谨性** | CRPS / P10–P90 覆盖率 / 体制核 / 预期差均严格零前视泄漏，全量单测 + 类型检查零报错 |
| **Web 体验** | 首页按月筛选、历史回填日报决策面板、`/forecast` 实盘校准成绩单与体制徽章浏览器实测通过，零控制台报错 |
