# 概率路径扇形图 — 调研与判断依据（Research）

> 状态：调研定稿（与 [`PROB-PATH-FORECAST-V1.md`](./PROB-PATH-FORECAST-V1.md) 配套）  
> 日期：2026-11-26  
> 回答：**「大版本」指什么？结论是否来自基本面/技术面/情绪面？判断依据是什么？业界参考是什么？**

---

## 1. 「大版本」究竟指什么（避免歧义）

| 名称 | 当前值 | 含义 |
|------|--------|------|
| **npm 包 `goldrush`** | `0.1.0`（`package.json`） | 整个 CLI/Web 仓库的 semver；**本次不升级为 1.0.0** |
| **日报 `meta` 契约** | `schemaVersion: 1` | 机器可读 sidecar；实现概率路径时拟 **增字段** `probPath`（可仍用 v1 或 bump 为 2，**仅表示 meta 结构**，不是产品「大版本号」） |
| **本次所说的「大版本」** | **功能包 L — Prob Path Forecast v1.0** | `ROADMAP-FINENG.md` 中新增的规划包；用户口语里的「新建大版本」= **这一整块能力的首发版本** |
| **后续子版本** | v1.1 / v2 | 见 `PROB-PATH-FORECAST-V1.md` §6（相似日增强、Brier、walk-forward OOS 等） |

**结论（写清楚）**：

- 用户要的「大版本」**不是**把整个 GoldRush 打成 `1.0.0`，而是 **产品能力大版本：概率路径扇形图（Prob Path Fan）v1.0**。
- 它与现有 **analysis / 双打分 / 三期展望 / 仓位** 并行，落在 **Signals + Explain**，**不替换** 日报主流程。
- 编码落地后的可见版本号建议：文档与 meta 内 `probPath.schemaVersion: 1`（路径图数据契约），与 CLI 子命令 `goldrush path` 一并发布。

---

## 2. 核心结论：是不是「基本面 + 技术面 + 情绪面」算出来的？

### 2.1 直接回答（三层）

| 层级 | 是否用于画扇形图的**数值** | 说明 |
|------|---------------------------|------|
| **LLM 四维**（技术 / 基本面 / 情绪 + 资金） | **不直接** | 扇形线 **不由** LLM 再预测一遍未来点位；LLM 仍负责日报叙述与三情景文案 |
| **综合结论（overall.score）+ 量化分** | **间接** | v1 样本条件 **第一步**：按 **综合评分分桶** 选历史日；分桶里的分数本身已是四维 + 反驳 + 校准后的结果 |
| **结构化特征 `scenario_features`** | **间接（第二步扩样）** | 分桶样本不足时，用 **相似日**；特征向量**显式编码**技术/宏观/情绪/主力信息 |

因此：

- **对用户可说的话**：路径分布是 **「在与你今天综合判断相近的历史日子里，金价后来实际怎么走」** 的统计，**综合判断里已经吸收了基本面、技术面、情绪面（经 LLM 四维与量化因子）**，但扇形图 **不是** 把四个 Agent 的输出再做一次加权公式。
- **对研发可审计的话**：扇形 = **经验条件分布（empirical conditional distribution）**，条件变量 = **分桶分数 +（可选）特征相似度**，因变量 = **历史真实价格路径的累计涨跌 %**。

### 2.2 与 GoldRush 现有分析体系的对照

```
┌─────────────────────────────────────────────────────────────────┐
│ 当日 Signals（已有）                                              │
│  · LLM：技术 / 基本面 / 情绪 / 资金 → 四维分 → 反驳 → 校准 → overall │
│  · 量化：11 因子 → quantScore（趋势/RSI/MACD/布林/估值/flow/TIPS…） │
│  · 写入 scenario_features（美元/TIPS/偏离/VIX/联储/地缘/动量/CFTC/ETF）│
└────────────────────────────┬────────────────────────────────────┘
                             │ 仅作「找相似历史」的条件，不重新算分
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Prob Path Fan v1（拟新增）                                        │
│  1) 同 overall 分桶 → 取历史报告日集合 S                          │
│  2) |S|<30 → 用 scenario 余弦相似日扩样                           │
│  3) 对每条样本日 d：从 d 收盘起逐日算 cumPct(h)，h=1..5 或 1..20   │
│  4) 每个 h 对 {cumPct(h)} 取 P10/P50/P90 → 画扇形                  │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Gates + Explain（已有规则延伸）                                   │
│  样本<10 / 红档 → 降级；仓位仍看短期档 + resolveOperationalAdvice   │
│  LLM 三情景概率与统计分位 **并列展示**，不强行一致                    │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 特征向量 →「三面」映射（相似日扩样时用）

`scenario_features`（`src/db/scenario-features.ts`、`featureToVector`）字段与投研口径对应关系：

| 特征字段 | 投资维度归类 | 作用 |
|----------|--------------|------|
| `goldDeviation`, `momentumDirection`, `consecutiveDays` | **技术面** | 均线偏离、动量方向 |
| `dollarDirection/Magnitude`, `tipsDirection/Magnitude`, `fedStance` | **基本面 / 宏观** | 美元、实际利率、政策立场 |
| `vixLevel`, `geopoliticalRisk` | **情绪 / 风险** | 恐慌与地缘 |
| `cftcPercentile`, `etfFlow5d`, `flowScore` | **资金面 / 情绪结构** | 持仓拥挤、ETF、主力综合 |

量化因子中与三面重叠的部分（**进入 overall 语境、但不直接进入分位数公式**）见 `quant-score.ts`：`trend/rsi/macd/bollinger`→技术；`tips/dxy/us10y/regime`→宏观；`flow`→资金情绪。

### 2.4 明确不算进扇形的东西（v1）

| 输入 | 为何 v1 不用作路径公式 |
|------|------------------------|
| LLM 情景里的 `goldPrice` 字符串 | 不可复现、非结构化 |
| 长期 outlook 1/3/5 年 | 配置向，不做点位路径（`LONG-TERM-OUTLOOK.md`） |
| `event_heat` / 事件传导权重 | 刻意 0%，仅 Explain（`USER-VALUE.md`） |
| 未回填的 `scenario_features` | 无真实 5/20 日路径的样本剔除 |

---

## 3. 判断依据与方法论（为何称「相对科学」）

### 3.1 方法论家族

本功能采用的是央行与商品量化文献中 **Density Forecast / Fan Chart** 的一条 **务实分支**：

| 方法 | 本项目的用法 | 学术/实务来源 |
|------|--------------|---------------|
| **经验分位扇形（Fan Chart）** | P10/P50/P90 随 horizon 展开 | 英格兰银行货币政策报告；[BoE IEO 2024 评述](https://www.bankofengland.co.uk/-/media/boe/files/independent-evaluation-office/2024/forecasting-for-monetary-policy-making-and-communication-at-the-bank-of-england-a-review.pdf)；[Malta CB QR 2014 Box 4](https://www.centralbankmalta.org/site/Reports-Articles/Pre-2015/QR-2014-2-Box-4.pdf) |
| **历史预测误差校准带宽** | v1 简化为 **直接经验路径分位**；v1.1 可对标 **分 horizon 的 forecast error σ**（BoE 用历史误差向量平滑） | [NBS 斯洛伐克 fan chart 方法论 PDF](https://www.nbs.sk/_img/documents/biatec/bia05_05/19_21.pdf) |
| **历史相似态（Historical Analog / k-NN）** | 分桶不足 → `scenario-similarity` 余弦近邻 | [Session-Conditioned Gold Regime Forecasting](https://img1.wsimg.com/blobby/go/f1a5b452-1d8c-4015-8c61-1cbbf2930284/Session_Conditioned_Gold_Regime_Forecasting_Pu.pdf) §10 |
| **分桶条件收益（非参数）** | 先按 `SCORE_BUCKETS` 筛样本 | 与 `calibration-tearsheet`、`calibration.ts` 同源；类似 Alphalens **分位组合前瞻收益** 思路 |
| **分位数回归 / 提升法（黄金）** | **v1 不实现**；列为 v2+ 或对照基准 | [Energy Policy 2015 黄金分位回归](https://www.sciencedirect.com/science/article/abs/pii/S0301420715000653)；[Economics & Finance 2016 quantile boosting](https://ideas.repec.org/a/eee/ecofin/v35y2016icp38-55.html) |

**BoE 核心思想（提炼）**：扇形表达的是 **对未来结果的概率分布**，不是点预测；带宽可来自 **历史误差** 或 **随机模拟**；可含 **偏度（skew）** 表示上下行风险不对称。GoldRush v1 用 **历史真实路径分位** 代替央行「对宏观变量的预测误差」，因我们预测对象是 **金价收益** 而非 CPI。

**与 BoE 的差异（须对用户透明）**：

| BoE | GoldRush Prob Path v1 |
|-----|------------------------|
| 结构化宏观计量模型 + 专家判断调扇形 | **无结构化宏观 SDE**；条件于 **本仓库历史 analysis + 金价** |
| 官方对外承诺「90% 区间约覆盖 90% 实现」 | v1 **不承诺覆盖率**；v1.1 用 **walk-forward + 覆盖率诊断** 逼近 |
| 季度 horizon | **5 / 20 个交易日**（定投决策尺度） |

### 3.2 本仓库内的「单一会计」依据

| 规则 | 模块 | 作用 |
|------|------|------|
| 前瞻收益起点 = 报告日收盘，h 个 **有效交易日** | `forward-return.ts` | 与命中率、校准、IC **同一套账** |
| 方向与持平 | `decision-thresholds.ts` | 扇形 **不另设** 58/42 |
| 样本量与 Wilson | `prediction-track` 惯例 | 图例要求 n≥30 正常，n<10 不画未来扇形 |
| 数据红档 | `data-quality-gate.ts` | 图可灰显，文案禁止强烈操作建议 |

### 3.3 什么算「科学」、什么不算

| 算相对科学（v1 采用） | 不算科学承诺 |
|----------------------|--------------|
| 可复现：同样 DB + 同样日 → 同样分位线 | 「顶底必达」 |
| 假设：**马尔可夫近似** — 同类状态后验路径可类比（相似日/同分桶） | 黄金收益 i.i.d. 或恒定波动 |
| 用 **样本外历史路径** 作分布，而非 LLM 编造 | 以扇形命中率为对外 KPI |
| 后续可用 **CRPS / 覆盖率 / Brier** 评校准（v1.1，ROADMAP 包 G） | 未经 walk-forward 调参后自称 OOS |

### 3.4 评估指标（实现后应用，写入 v1.1）

| 指标 | 含义 | 参考实现方向 |
|------|------|--------------|
| **Empirical coverage** | 实现路径是否落在 P10–P90 之间（80% 名义带） | BoE fan chart 校准；[conformal-finance](https://pypi.org/project/conformal-finance/) 诊断模块 |
| **CRPS** | 分位路径对用户意图的综合评分 | MiQ-MCP 实践（[GitHub](https://github.com/sanjanbaitalik/MiQ-MCP)） |
| **Walk-forward** | 训练窗估条件 vs 测试窗实现 | 已有 `walk-forward.ts` |
| **Diebold–Mariano** | 分位路径 vs 朴素基准（永远涨 / 随机游走） | 黄金分位回归文献常用 |

---

## 4. 网上可参考的开源 / 学术项目（精选）

### 4.1 与「概率扇形 / 分位路径」直接相关

| 项目 | 链接 | 可借鉴点 | 与 GoldRush v1 关系 |
|------|------|----------|---------------------|
| **Bank of England Fan Charts** | [IEO 2024 PDF](https://www.bankofengland.co.uk/-/media/boe/files/independent-evaluation-office/2024/forecasting-for-monetary-policy-making-and-communication-at-the-bank-of-england-a-review.pdf) | 扇形语义、模式/均值/偏度、历史误差定宽 | **产品叙事与图例**范本 |
| **Neural-SDE (highlevel fan chart)** | [kdownie/Neural-Sde](https://github.com/kdownie/Neural-Sde) | `forecast()` → quantiles + `plot()` 扇形；强调 **分布非点预测** | **v2 可选**：GBM/OU 参数路径作对照带（需标注非平稳） |
| **EnCQR** | [FilippoMB/Ensemble-Conformalized-Quantile-Regression](https://github.com/filippomb/ensemble-conformalized-quantile-regression) · [arXiv:2202.08756](https://arxiv.org/abs/2202.08756) | 任意时序模型 + **保覆盖** 区间 | **v1.1+**：在分桶残差上做 conformal 扩宽 |
| **conformal-finance** | [PyPI](https://pypi.org/project/conformal-finance/) | 金融时序 conformal、regime 条件覆盖 | 覆盖诊断工具链参考 |
| **MiQ-MCP** | [sanjanbaitalik/MiQ-MCP](https://github.com/sanjanbaitalik/MiQ-MCP) | 分位回归 + Mondrian conformal + purged CV | 评估卫生流程模板 |
| **Session-Conditioned Gold Regime** | [PDF](https://img1.wsimg.com/blobby/go/f1a5b452-1d8c-4015-8c61-1cbbf2930284/Session_Conditioned_Gold_Regime_Forecasting_Pu.pdf) | **黄金**状态向量 + k-NN + 加权后续收益 | 与 **相似日扩样** 几乎同构 |
| **Quantile NN for gold (academic)** | [ondrejtobek/quantile-neural-networks](https://github.com/ondrejtobek/quantile-neural-networks) | 全球股指分位预测方法论 | **不做 v1**；数据与过拟合成本高 |

### 4.2 与「条件分桶 + 前瞻收益」相关的量化基建

| 项目 | 链接 | 可借鉴点 |
|------|------|----------|
| **Alphalens** | [quantopian/alphalens](https://github.com/quantopian/alphalens) | 因子分位 → **前瞻收益分布**、IC；与 `calibrate` 分桶哲学一致 |
| **Zipline + Alpha research** | [ai-alpha](https://github.com/yukit-k/ai-alpha) 等 | Pipeline 因子 → forward returns |
| **Gold quantile boosting** | [RePEc 2016](https://ideas.repec.org/a/eee/ecofin/v35y2016icp38-55.html) | 黄金收益 **分位** 预测、不对称损失 | 学术对照，非首版依赖 |

### 4.3 不建议照搬的反例

| 方向 | 原因 |
|------|------|
| 深度学习端到端金价 LSTM 单线预测 | 与「分布 + 可审计」目标冲突；样本短 |
| 以 RMSE 炫技的点预测库 | [conformal-finance](https://pypi.org/project/conformal-finance/) 自述：金融点预测 RMSE 常误导 |
| FT 批评的 BoE **主观拉宽扇形** 而不贴误差数据 | 我们 v1 **禁止 LLM 调扇形宽度**；仅样本量与门禁降级 |

---

## 5. GoldRush v1 相对业界方案的选型表

| 方案 | 科学成熟度 | 实现成本 | 可解释性 | v1 决策 |
|------|-----------|----------|----------|---------|
| 央行式 fan（误差 σ） | 高（宏观） | 中（需误差序列） | 高 | **部分采纳**（图例与分位语义）；误差 σ 放 v1.1 |
| 历史 analog k-NN | 中高（黄金文献） | 低（已有 `scenario_features`） | 高 | **采纳**（扩样瀑布） |
| 评分分桶经验路径 | 中（依赖样本量） | 低 | 高 | **采纳**（主条件） |
| Quantile boosting / QR | 中高（学术） | 高 | 中 | **不采纳 v1** |
| Neural SDE Monte Carlo | 中（假设稳态） | 中 | 中 | **可选 v2 对照** |
| Conformal 保覆盖 | 高（有限样本理论） | 中 | 高 | **v1.1 评估层** |

---

## 6. 用户可见的「判断依据」说明（图例 / 文档模板）

建议固定出现在图下与 MD（实现时照抄）：

1. **条件**：综合评分区间 **{bucket}**；样本 **n={n}**（含相似日扩样时注明）。  
2. **路径**：每条样本为历史上某日 **analysis 后** 的真实伦敦金 **累计涨跌 %**。  
3. **分位**：P10/P50/P90 为 **非参数经验分位数**，**非** LLM 或模型点预测。  
4. **与四面关系**：当日四面与量化分 **决定你是否落入该历史集合**；扇形 **展示该集合的事后路径分布**。  
5. **局限**：黄金结构突变时历史可失效；**5/20 日** 不覆盖长期配置；红档下仅供参考。  
6. **参考**：制图思想对标 **央行 density forecast / fan chart**；算法对标 **历史相似态 + 分桶校准**（见本文 §3–4）。

---

## 7. 与需求文档的衔接

| 文档 | 内容 |
|------|------|
| [`PROB-PATH-FORECAST-V1.md`](./PROB-PATH-FORECAST-V1.md) | 已锁定：Fan + 5/20 日 + 分桶→相似日 |
| **本文** | 大版本定义、三面关系、方法论、外部参考、评估路线 |
| [`ROADMAP-FINENG.md`](./ROADMAP-FINENG.md) | 包 **L** 登记；包 **G**（Brier）对接 v1.1 |

---

## 8. 变更记录

| 日期 | 说明 |
|------|------|
| 2026-11-26 | 初稿：大版本界定、三面映射、方法论、外部项目调研、评估指标 |