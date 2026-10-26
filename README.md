# GoldRush — 黄金投资研究 Agent

一个 CLI 工具，一条命令自动采集金价数据、四维度分析、强制反驳、回测校准、主力动向监测，输出**短期+中长期双视角**策略报告。

面向通过**支付宝基金**做黄金中长期配置的个人投资者，同时兼顾短线参考。

---

## 快速开始

### 前置条件

- Node.js >= 20
- opencode CLI 已安装且可用（`opencode run` 能正常调用）
- （可选）Tavily API Key — 用于联网金融数据搜索

### 安装

```bash
git clone <repo-url> && cd goldRush
npm install
npm run build
```

### 配置（可选）

```bash
# Tavily API（联网金融数据搜索，不配也能跑，会降级为空结果）
export TAVILY_API_KEY=your_tavily_api_key_here

# 或者写到 .env 文件
cp .env.example .env
# 编辑 .env 填入你的 TAVILY_API_KEY
```

### 运行

```bash
# 默认仪表盘 — 一眼看懂（金价 + 研判 + 主力 + 建议）
node dist/index.js

# 实时金价
node dist/index.js price

# 综合分析报告（默认双视角 + 信号一致性 + 人话建议）
node dist/index.js analysis

# 导出 Markdown 投资日报
node dist/index.js analysis --md

# 主力动向监测（CFTC 持仓 + ETF 资金流 + 央行购金 + 背离检测）
node dist/index.js flow

# 导出主力监测日报
node dist/index.js flow --md

# 基金对比分析
node dist/index.js fund

# 首次回填历史（无需 Tavily，Yahoo 日线）
node dist/index.js init-history --days 60

# 首次回填主力数据
node dist/index.js flow --init
```

建议设置 alias 方便使用：

```bash
alias goldrush="node /path/to/goldRush/dist/index.js"
goldrush                    # 默认仪表盘
goldrush price
goldrush analysis
goldrush flow
```

---

## 命令一览

| 命令 | 说明 |
|------|------|
| `goldrush` | **默认仪表盘**（金价 + 最新研判 + 主力动向 + 操作建议） |
| `goldrush price` | 实时金价速查，自动存 SQLite |
| `goldrush analysis` | 综合分析报告（四维度+反驳+情景+双轨策略+信号一致性+人话建议） |
| `goldrush analysis -H short` | 仅短期视角（日线/入场止损） |
| `goldrush analysis -H mid` | 仅中长期视角（周线/定投加减仓） |
| `goldrush analysis --json` | JSON 格式输出 |
| `goldrush analysis --md` | 保存报告为 Markdown 到 docs/ 目录 |
| `goldrush flow` | **主力动向监测**（CFTC + GLD ETF + 央行购金 + 背离检测） |
| `goldrush flow --init` | 首次回填 CFTC + GLD 全部历史数据 |
| `goldrush flow --json` | JSON 格式输出 |
| `goldrush flow --md` | 主力日报写入 docs/ |
| `goldrush fund` | 黄金基金对比（费率/溢价/定投信号） |
| `goldrush calibrate` | 回测校准（历史准确率统计） |
| `goldrush calibrate --days 90` | 回顾 90 天 |
| `goldrush snapshot` | 手动保存当日数据快照 |
| `goldrush init-history` | Yahoo GC=F 回填 60 天 |
| `goldrush history` | 查看历史金价/报告/基金 |
| `goldrush diff <dateA> <dateB>` | 对比两日报告变化 |
| `goldrush digest --days 7` | 周期摘要（均分、跳变） |
| `goldrush reflect --days 14 --md` | 周末预测错因反思（打脸分桶+下周清单） |
| `goldrush notify --test` | Webhook 连通性测试 |
| `goldrush outlook` | **1/3/5 年长期档**（配置向·慢变量；`outlook --md` 写 docs） |

---

## 架构

```
用户 CLI 命令
    │
    ▼
Commander.js (命令路由)
    │
    ▼
Orchestrator (编排层)
    │
    ├──→ 数据采集层
    │     ├── Tavily 搜索 (LLM 提取金价/美元/美债)
    │     ├── Yahoo Finance 直连 (GC=F/DXY 实时价, A级锚定源)
    │     ├── CFTC.gov ZIP 解析 (COT 持仓报告, 周度)
    │     └── SPDR CSV 解析 (GLD ETF 持仓, 日度)
    │
    ├──→ 数据验证层
    │     ├── 多源交叉验证 (Yahoo锚定 + Tavily多源)
    │     ├── 来源分级 (A/B/C)
    │     └── Yahoo A级源注入 → 置信度 46%→65%+
    │
    ├──→ 主力动向层 (纯本地计算, 不依赖 LLM)
    │     ├── CFTC 持仓评分 (非商业净多百分位 + 趋势)
    │     ├── GLD ETF 资金流评分 (5日/20日持仓变化)
    │     ├── 央行购金信号 (PBOC 月度储备)
    │     ├── 背离检测 (价-仓-量 背离)
    │     └── 综合主力评分
    │
    ├──→ 四维度分析 (LLM)
    │     ├── 技术面 (本地 MA/RSI/MACD + LLM 解读)
    │     ├── 基本面 (美元/美债/美联储)
    │     ├── 情绪面 (注入本地主力数据替代 LLM 猜测)
    │     └── 基金面 (费率/溢价/估值水位)
    │
    ├──→ 强制反驳 Agent (独立 session)
    │
    └──→ 综合编排 Agent
          注入校准上下文 + 三情景分析 + 尾部风险
          输出双轨策略 + 信号一致性 + 人话建议
```

---

## 核心设计

### 数据源

| 数据源 | 方式 | 频率 | 用途 | 现网可达性（阿里云） |
|--------|------|------|------|---------------------|
| Tavily 搜索 | LLM 提取 | 按需 | 金价/美元/美债/新闻 | 需 `TAVILY_API_KEY` |
| **Yahoo Finance** | HTTP 直连（零 LLM） | 实时/日线 | GC=F / DXY / 10Y / GLD 份额 | ⚠️ 部分机房超时，有瀑布回落 |
| **gold-api.com** | HTTP 直连 | 实时 | XAU 现货锚定 | ✅ |
| **新浪财经** | `hq.sinajs.cn` | 实时 | 纽约金 `hf_GC`、美元指数等 | ✅ |
| **LBMA** | JSON 历史定盘 | 日度 | 金价历史回填（Yahoo 失败时） | ✅ |
| **CFTC.gov** | ZIP + 本地解析 | 周度 | COT 持仓（黄金 088691） | ✅ |
| **SPDR / Yahoo GLD** | CSV / quoteSummary | 日度 | GLD 持仓吨数 | ⚠️ 官网 SPA/Yahoo 常失败 |
| PBOC / 公开页 | 启发式解析 | 月度 | 中国央行黄金储备 | ⚠️ 页面结构易变，可能为空 |

**锚定瀑布（`src/data/live-anchors.ts` + `yahoo-live.ts`）**：Yahoo → gold-api / 新浪 / LBMA / FRED（FRED 在部分机房亦超时）。LLM 提取失败或为 0 时，用直连锚定补齐，**禁止把 0 当有效金价入库**。

### 主力动向监测 (`goldrush flow`)

纯本地计算，不依赖 LLM。追踪三大维度：

| 维度 | 数据 | 评分逻辑 |
|------|------|----------|
| CFTC 投机持仓 | 非商业净多头 | 历史百分位 (40%) + 趋势 (30%) + 极端信号 (20%) |
| GLD ETF 资金流 | 日度持仓变化 | 5日趋势 (40%) + 20日趋势 (30%) + 持仓水位 (20%) |
| 央行购金 | PBOC 月度储备 | 连续增持月数 (50%) + 月度变化 (30%) |

综合评分 = 0.40×CFTC + 0.30×ETF + 0.15×央行 + 0.15×其他。

### 信息可靠性

1. **多源 A 级锚定** — Yahoo / gold-api / 新浪 / LBMA 直连，不依赖 LLM 编造
2. **来源分级** — A级(交易所/央行/官方) > B级(财经媒体) > C级(自媒体)
3. **3源交叉验证** — 同一数据尽量多源；单源标注 `single_source`
4. **零值防线** — `parseMarketData` / `saveSnapshot` / `forwardFillCloses` 拒绝 `0` 与 `N/A` 污染历史
5. **中英文双搜 + 反向核查** — 降低信息茧房与乐观偏差

### 强制反驳机制

正常分析天然偏乐观。强制反驳 Agent 独立运行，专门找看空论据：

```
四维度分析 → 初步评分 70 分
    ↓
反驳 Agent (看不到综合评分，避免锚定)
    ↓
看空力度 42/100，反驳强度 moderate
    ↓
评分修正: 70 → 64 (下调 6 分)
    ↓
最终输出: 64 分 + 反驳摘要 + 尾部风险 + 信号一致性 + 人话建议
```

### 信号一致性检查

四维度方向一致性检测：

| 一致性 | 标记 | 含义 |
|--------|------|------|
| 4/4 一致 | ✅ 强一致 | 全部维度同方向 |
| 3/4 一致 | ⚠️ 中等 | 1个维度唱反调 |
| ≤2/4 一致 | 🔴 弱 | 方向分歧，谨慎参考 |

### 人话分数映射

| 评分 | 建议 |
|------|------|
| 0-30 | 🔴 暂停定投，等待评分回升至 45 以上 |
| 30-45 | 🟠 放慢定投节奏，不加仓 |
| 45-55 | 🟡 维持基础定投，按日历执行 |
| 55-75 | 🟢 维持定投；急跌可小幅加码，高位不追 |
| 75-100 | 🔵 可适度加码，但高位不追、设好止盈 |

### 双视角输出

| 维度 | 短期 | 中长期 |
|------|------|--------|
| 时间框架 | 日线/小时线 | 周线/月线 |
| 持仓周期 | 数天~2周 | 1~6个月 |
| 推荐品种 | 518880 场内ETF | 000216/002610 联接基金 |
| 策略核心 | 入场点位、止盈止损 | 定投节奏、加减仓 |
| 风控方式 | 固定止损 3-5% | 估值止盈、仓位管理 |

### 长期档（1 / 3 / 5 年，配置向）

与「中长期周线策略」不同：这是 **多年配置档位**，见 [docs/LONG-TERM-OUTLOOK.md](./docs/LONG-TERM-OUTLOOK.md)。

| 原则 | 说明 |
|------|------|
| 慢变量主导 | 3/5 年几乎不吃当日技术与 overall 短线分 |
| 不吓人 | 累计参考区间硬顶约 ±35%；**low 置信不展示点位** |
| 可操作 | `overweight` / `neutral` / `underweight` + 定投文案（非清仓） |
| 防乱翻 | 相对上一报告平滑 |

```bash
node dist/index.js outlook          # 按最新 analysis 重算
node dist/index.js outlook --md     # docs/goldrush-outlook-latest.md
```

### 双打分制（LLM + 量化并行，健全版）

`analysis` 同时跑**两套独立分数**，始终并排展示，**不合成一个黑箱分**。详见 [docs/DUAL-SCORE.md](./docs/DUAL-SCORE.md)。

| 轨道 | 路径 | 特点 |
|------|------|------|
| **LLM 分** | 四维 → 反驳 → 校准偏移 → `overall.score` | 可读叙事，有随机性 |
| **量化分** | 本地因子加权 → `overall.quantScore` + 因子明细 | 零 LLM，可复现 |

**冲突规则**（`src/utils/dual-score.ts`）：

| 条件 | 操作 |
|------|------|
| \|LLM−量化\| ≤ 8 且同向 | 可参考综合结论 |
| 微偏同向 | 叙事看 LLM，结构可参考量化 |
| **\|Δ\| > 15** 或方向相反或四维弱一致 | **操作弃权：维持定投**（两套分仍展示） |
| 数据门禁红档 | 优先关闭操作（与双分无关） |

**不**在冲突时自动抬高某一侧权重；谁更准看 `calibrate` 分轨统计。

```
综合研判(LLM): 📈 67/100
🔢 量化评分: 63/100 | 偏差=LLM偏高 +4 | 策略=both
  （因子表：trend/rsi/macd/flow/dxy/tips/…）
```

量化因子权重：`src/indicators/quant-score.ts` 的 `DEFAULT_WEIGHTS`（**总和=1.0**；`event_heat` 默认 **0**；无效因子可置 0 后归一）。

### 仓位推荐 + 历史预测对错（Web 日报）

完整说明见 **[docs/POSITION-AND-TRACK.md](./docs/POSITION-AND-TRACK.md)**。

### 可信度一览与评分区间

- 日报 / Web 顶部：**可信度 0–100**（操作可信，非涨跌准确率）+ **评分区间**（如 55–67）+ **三行看懂**
- 合成因子：门禁、双分、四维一致、校准样本、滚动命中
- 搜索原文：`docs/search-raw/YYYY-MM-DD.json`（30 天，审计 LLM 抽价）

完整说明见 **[docs/RELIABILITY.md](./docs/RELIABILITY.md)**。

### 后续规划（金融工程 / 业界）

风险约束仓位 v2、纸面 MaxDD、Regime 命中、因子 IC、walk-forward 等 **规划与反模式** 见：

→ **[docs/ROADMAP-FINENG.md](./docs/ROADMAP-FINENG.md)** · 摘要索引 [docs/OPTIMIZATION.md](./docs/OPTIMIZATION.md) v1.7 · 决策质量总清单 [docs/DECISION-QUALITY.md](./docs/DECISION-QUALITY.md)

`analysis --md` 额外输出两块，并写入供 Web 读取：

| 功能 | 模块 | 展示 |
|------|------|------|
| **当前仓位推荐** | `position-recommend.ts` | 相对计划黄金仓 0–100%；定投层/波段层；门禁红上限 35%、双分冲突 ≤50% |
| **历史预测对错** | `prediction-track.ts` | LLM/量化 5 日方向命中、高/低分段涨概率、冲突日、分桶表、近 12 日明细 |

- JSON：`docs/goldrush-stats-latest.json`（每次 analysis 刷新）
- Web 首页：统计卡「LLM命中 / 量化命中 / 建议仓位」+ 面板
- Web 文章页：预测仪表盘下方同款面板
- 旧日报无仓位小节时：Web 按分数**粗推**档位（标注旧报告）

> 仓位百分比均相对于你预设的「黄金计划仓」=100%，不是总资产杠杆；命中率非业绩承诺。

### 回测校准闭环（分轨）

```bash
node dist/index.js calibrate --days 90 --detail
```

- **LLM 分桶** + **量化分桶**（独立）
- 方向命中率（>55 预测涨 / <45 预测跌）
- 冲突日若跟 LLM / 跟量化各自命中次数
- **排除**无效金价、报告数据红档样本

校准上下文仍会注入综合编排 prompt（LLM 分区间历史涨概率）。

---

## Web 报告展示

启动内置 HTTP 服务即可在浏览器查看所有报告：

```bash
node server.cjs
# → http://localhost 或服务器 IP: http://106.14.92.235
```

**Web 特性**：
- 🏠 首页：最新研判 + 历史报告列表 + 搜索/排序
- 🟢🟡🔴 **数据质量点**：列表/英雄卡置信度色点（旧报按 conf 推断）
- 📊 **30秒速读卡片**：评分 + 操作建议 + 门禁标签
- 📈 **预测仪表盘**：大号评分 + 校准 + 三情景 + **双打分横幅**
- ⚖️ 冲突日展示「操作弃权 · 维持定投」
- 📁 **智能折叠**：默认只展开策略+情景
- 🏦 **主力仪表盘**：CFTC/ETF/央行 评分条

### 桌面版（Windows / macOS / Linux）

桌面版是 Electron 壳：进程内启动同一个 `server.cjs`（只监听 `127.0.0.1` 随机端口），窗口里看日报，不需要 80 端口和服务器。独立子项目 `desktop/`，**不装 better-sqlite3、不跑 CLI 分析**，所以打包时不会触发原生模块重编译。

**推荐：用 GitHub Actions 打包（无需本机环境）**

- Actions → `desktop` → Run workflow，跑完在 Artifacts 下载 `GoldRush-win` / `GoldRush-mac` / `GoldRush-linux`
- 推送 `desktop-v*` 标签（如 `desktop-v0.1.0`）会自动发 GitHub Release
- 改动 `server.cjs` / `web/` / `desktop/` 的 PR 会自动跑三平台打包，坏了在合并前就能看到

**本机打包**

```bash
cd desktop
npm ci
npm start              # 开发预览
npm run dist           # 打当前平台的包，产物在 desktop/dist/
```

国内网络下载 Electron 慢或失败时，先设置镜像再 `npm ci` / `npm run dist`：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
# Windows PowerShell: $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" 等
```

`npm run dist` 会先跑 `stage`（复制 server/web/docs 并体检依赖）和 Electron 运行时冒烟，任一失败直接给出中文原因，不会产出一个装好就白屏的包。

安装包内置打包时刻的 `docs/` 快照；菜单「报告 → 选择报告目录」可指向本地 clone 的 `docs/` 以看最新日报。macOS 包未签名，首次打开需右键 → 打开。

#### 打包经验教训（2026-10，必读）

以前桌面包反复失败，根因都不是代码 bug，而是打包方式本身有坑。下面每条规则都有自动检查兜底，**违反时会在 `npm run dist` 或 PR 的 CI 上直接失败**，而不是产出一个装好就白屏的包。

| # | 踩过的坑 | 现象 | 规则 | 自动兜底 |
|---|----------|------|------|----------|
| 1 | `marked` 18 是纯 ESM，`server.cjs` 用 `require('marked')` 加载，只有 Node ≥ 22.12 支持 | pkg / 旧 Electron 打出来一打开就 `ERR_REQUIRE_ESM`，白屏或闪退 | **不用 pkg / nexe**；Electron 版本内置的 Node 必须 ≥ 22.12（当前 Electron 45 / Node 24），降级 Electron 前先查它的 Node 版本 | `npm run smoke` 用 **Electron 自带的 Node** 真实请求首页和日报 |
| 2 | 系统 Node 能跑 ≠ Electron 能跑 | 本机 `node server.cjs` 正常，打包后崩 | 验证一律以 Electron 运行时为准，不以系统 Node 为准 | 同上 |
| 3 | `better-sqlite3` 是原生模块 | 打包时针对 Electron 重编译，要 Python / VS / Xcode + 访问 GitHub，国内网络常失败 | 桌面壳**只跑日报站，不跑 CLI 分析**；`desktop/` 依赖里**禁止原生模块**；保持 `npmRebuild: false` | `npm run stage` 发现原生模块直接报错 |
| 4 | 桌面依赖和根项目混在一起 | 根 `npm ci` 也去下 Electron；生产机 cron 被拖累 | 桌面是独立子项目 `desktop/`，有自己的 `package.json` 和 lock，**不要把 electron 加进根 `package.json`** | — |
| 5 | `server.cjs` 新增 `require('某包')` 却忘了加到桌面依赖 | 打包成功，运行时 `Cannot find module` | 给 `server.cjs` / `web/*.cjs` 加第三方依赖时，**同步加到 `desktop/package.json`，版本与根一致** | `npm run stage` 扫描所有 require 并比对版本 |
| 6 | `server.cjs` 默认监听 `0.0.0.0:80` | 桌面普通权限 `EACCES`，且会暴露到局域网 | 桌面壳设 `GOLDRUSH_EMBEDDED=1`，自己 `listen(0, '127.0.0.1')`；**不要删掉 `server.cjs` 末尾的 `module.exports` 和嵌入开关** | `test/server-embed.test.ts`（根 `npm test`） |
| 7 | 用 `require.main === module` 判断是否直接运行 | pm2 下判断失败，生产站不监听 | 嵌入开关只用环境变量 `GOLDRUSH_EMBEDDED` | 同上 |
| 8 | 在一台机器上交叉打三个平台 | Windows 上打 mac 包、Linux 上打 Windows 包需要额外工具，经常失败 | **正式包一律走 GitHub Actions**（三平台原生 runner）；本机只打本平台 | `.github/workflows/desktop.yml` |
| 9 | 国内下载 Electron / electron-builder 二进制超时 | `npm ci` 或打包卡死、失败 | 本机打包前设置 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`（见上文） | CI 在海外 runner，不受影响 |
| 10 | GitHub Actions 依赖的 Node 运行时下线 | 某天 CI 突然全红 | Actions 跟随大版本升级（当前 checkout@v7 / setup-node@v7 / upload-artifact@v7）；CI 出现 deprecated 警告就及时升级 | CI annotations |
| 11 | `docs/` 每天都有新日报提交 | 每天触发三平台打包，浪费且排队 | CI 不按 `docs/` 变更触发；要带最新日报的包就手动 Run workflow | — |

**改动后自查顺序**：`npm test`（根）→ `cd desktop && npm run smoke` → 推 PR 看 `desktop` CI 三平台全绿再合并。CI 红了先看失败步骤：`stage` 红多为依赖不一致（规则 3、5），`smoke` 红多为运行时不兼容（规则 1、2），`electron-builder` 红多为网络或平台问题（规则 8、9）。

### 每日定时分析

已在服务器设置每日自动执行分析并生成 Markdown 报告（cron，以服务器实际为准）：

```bash
crontab -l
# 现网示例（可能随运维调整）：
# 0 10 * * * cd /root/git/goldRush && ./scripts/daily-analysis.sh >> logs/cron.log 2>&1
```

日志在 `logs/daily-YYYY-MM-DD.log` / `logs/cron.log`，报告写入 `docs/`（分析日报 + 主力监测日报）。

**周日额外**：同一脚本会跑 `digest --md` 与 `reflect --md`（预测错因反思，见 `docs/WEEKLY-REFLECT.md`）。

---

## 本地数据存储

SQLite 数据库自动创建在 `data/goldrush.db`：

| 表 | 用途 |
|----|------|
| `gold_prices` | 每日金价快照（伦敦金/上海金/ETF/美元/美债） |
| `fund_nav` | 基金净值快照（000216/002610 等） |
| `institutional_flows` | **主力动向数据**（CFTC持仓/GLD持仓/PBOC储备） |
| `analysis_reports` | 分析报告存档（含完整 JSON） |
| `scenario_features` | 市场特征向量（含主力维度，用于历史模式匹配） |
| `search_cache` | 搜索缓存（5分钟内免重复请求） |

每次运行 `price`、`analysis` 或 `flow` 自动存数据，无需手动操作。

---

## 技术指标

本地计算，100% 客观，不依赖 LLM：

| 指标 | 实现 | 用途 |
|------|------|------|
| MA5/MA20/MA60 | `src/indicators/ma.ts` | 均线趋势、金叉死叉 |
| RSI(14) | `src/indicators/rsi.ts` | 超买超卖信号 |
| MACD | `src/indicators/macd.ts` | 动量方向、金叉死叉 |
| 布林带 | `src/indicators/bollinger.ts` | 波动区间、%B |
| 历史百分位 | `src/indicators/percentile.ts` | 估值水位判断 |
| **主力信号** | `src/indicators/flow-signal.ts` | CFTC/ETF/央行评分 + 背离检测 |

数据积累 20 天后技术指标自动生效，注入技术面 Agent prompt。

---

## 项目结构

```
goldRush/
├── src/
│   ├── index.ts              # CLI 入口 (Commander.js)
│   ├── commands/
│   │   ├── dashboard.ts      # [新] 默认仪表盘
│   │   ├── price.ts          # 实时金价
│   │   ├── analysis.ts       # 综合分析报告 (含主力+一致性+人话)
│   │   ├── flow.ts           # [新] 主力动向监测
│   │   ├── fund.ts           # 基金对比
│   │   ├── calibrate.ts      # 回测校准
│   │   ├── snapshot.ts       # 数据快照
│   │   └── history.ts        # 历史数据
│   ├── agents/
│   │   ├── base.ts           # Agent 基类 (opencode CLI)
│   │   ├── data-collector.ts # 数据采集 + Tavily 搜索
│   │   ├── validator.ts      # 信息验证 (含 Yahoo 锚定源注入)
│   │   ├── analysis-agents.ts# 四维度 Agent (情绪面注入主力数据)
│   │   ├── rebuttal.ts       # 强制反驳 Agent
│   │   └── orchestrator.ts   # 综合编排 Agent
│   ├── data/
│   │   ├── live-anchors.ts   # 多源实时锚定 (gold-api/新浪/LBMA/FRED)
│   │   ├── yahoo-live.ts     # Yahoo 实时价 + 锚定回落
│   │   ├── yahoo-gold-history.ts # Yahoo 日线 + LBMA 历史回落
│   │   ├── cftc-grabber.ts   # CFTC COT 报告采集
│   │   ├── etf-grabber.ts    # GLD 吨数（东财新闻优先）
│   │   ├── pboc-grabber.ts   # PBOC 储备（东财搜索）
│   │   ├── eastmoney-search.ts # 东财 JSONP 搜索
│   │   ├── search-router.ts  # Tavily 搜索封装及路由
│   │   └── tavily-client.ts  # Tavily API 客户端
│   ├── db/
│   │   ├── index.ts          # SQLite 初始化 (含 institutional_flows)
│   │   ├── gold-prices.ts    # 金价 CRUD
│   │   ├── institutional-flows.ts # [新] 主力数据 CRUD
│   │   ├── fund-nav.ts       # 基金净值 CRUD
│   │   ├── reports.ts        # 报告存档 CRUD
│   │   ├── scenario-features.ts # 特征向量 CRUD (含主力维度)
│   │   ├── search-cache.ts   # 搜索缓存
│   │   └── calibration.ts    # 校准回测逻辑
│   ├── indicators/
│   │   ├── ma.ts / rsi.ts / macd.ts / bollinger.ts / percentile.ts
│   │   └── flow-signal.ts    # [新] 主力信号计算
│   ├── types/
│   │   ├── institutional.ts  # [新] 主力数据类型
│   │   └── ...
│   └── utils/
│       ├── ensure-flows.ts   # [新] 主力数据自动补齐
│       ├── plain-advice.ts   # [新] 人话建议 + 信号一致性
│       └── ...
├── web/
│   └── article-collapse.cjs  # Web 智能折叠 (只展开策略+情景)
├── server.cjs                # Web 服务 (端口80, 含新仪表盘)
├── data/goldrush.db          # SQLite (自动创建)
├── docs/                     # 报告存档
│   ├── FLOW-PLAN.md          # 主力监测设计规划
│   ├── OPTIMIZATION.md       # 优化路线图 (五维度)
│   └── ROADMAP-FINENG.md     # 金融工程/业界借鉴后续
├── scripts/daily-analysis.sh # 每日定时分析 (含 flow --md)
└── package.json
```

---

## 技术栈

| 组件 | 选型 | 原因 |
|------|------|------|
| 语言 | TypeScript | 类型安全 |
| CLI | Commander.js | 成熟稳定 |
| LLM | opencode CLI | Go 套餐 $10/月封顶 |
| 搜索(联网) | Tavily | 金融分类搜索、内容提取 |
| 实时数据 | **Yahoo Finance API** | 免费、零 LLM、A 级锚定源 |
| 持仓数据 | **CFTC.gov + SPDR** | 官方数据、本地解析 |
| 数据库 | SQLite (better-sqlite3) | 零配置、本地、够用 |
| 终端输出 | chalk + cli-table3 | 表格+颜色 |
| 报告展示 | 内置 HTTP 服务 (server.cjs) | 端口80 仪表盘+折叠 |

---

## 开发

```bash
# 开发模式（直接运行 TS）
npm run dev -- price

# 编译
npm run build

# 类型检查
npm run lint

# 测试
npm test
```

---

## 文档

| 文档 | 内容 |
|------|------|
| [docs/DUAL-SCORE.md](./docs/DUAL-SCORE.md) | **双打分机制**（冲突规则、分轨校准、因子） |
| [docs/HORIZONS.md](./docs/HORIZONS.md) | **短/中/长三期尺度**（中期慢变量、命中分轨） |
| [docs/DECISION-QUALITY.md](./docs/DECISION-QUALITY.md) | **2026-07 决策质量待办总清单**（改分/命中/Web 先读） |
| [docs/LONG-TERM-OUTLOOK.md](./docs/LONG-TERM-OUTLOOK.md) | **1/3/5 年长期档**（慢变量、配置向、防吓人区间） |
| [docs/POSITION-AND-TRACK.md](./docs/POSITION-AND-TRACK.md) | **仓位推荐 + 历史预测对错**（Web 统计面板） |
| [docs/RELIABILITY.md](./docs/RELIABILITY.md) | **可信度一览 / 评分区间 / 搜索原文存档** |
| [docs/ROADMAP-FINENG.md](./docs/ROADMAP-FINENG.md) | **金融工程 + 业界借鉴后续包**（仓位 v2 / MaxDD / IC…） |
| [docs/DATA-QUALITY.md](./docs/DATA-QUALITY.md) | **数据质量**（零价/门禁/锚定/Web 色点） |
| [docs/FLOW-PLAN.md](./docs/FLOW-PLAN.md) | 主力动向监测设计规划 |
| [docs/OPTIMIZATION.md](./docs/OPTIMIZATION.md) | 优化路线图（五维度 + 完成状态；链到 FINENG） |
| [AGENTS.md](./AGENTS.md) | 开发/运维约定（硬规则、出站源） |
| [IMPROVEMENTS.md](./IMPROVEMENTS.md) | 多轮体检与修复存档 |
| [CORRECTNESS-SPEC.md](./CORRECTNESS-SPEC.md) | 正确率与风险暴露规范 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 架构决策记录 |
| [PLAN.md](./PLAN.md) | 完整项目规划（偏早期） |
| [METHODOLOGY-DEEP-DIVE.md](./METHODOLOGY-DEEP-DIVE.md) | 金融 AI 方法论 |
| [PARADIGMS.md](./PARADIGMS.md) | 金融 Agent 范式参考 |

---

## 注意事项

- 本工具仅供投资研究参考，**不构成投资建议**
- LLM 分析存在固有局限；**优先看数据质量门禁与双打分是否冲突**
- 报告中的「数据置信度」、红/黄/绿门禁、双分偏差需优先阅读
- 若出现「价格为 0 / 数据真空」：见 `docs/DATA-QUALITY.md`；检查 opencode、Tavily、出站
- `calibrate` 建议积累 20 天以上**有效**金价；坏样本/红档会自动排除
- Tavily API 免费额度约 1000 次/月
- 主力：`flow --init` 回填 CFTC；**GLD/PBOC 优先东财新闻解析**（现网可用）；失败不编造
