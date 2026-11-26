# 概率路径扇形图（Prob Path Fan）— 架构图

> 功能包：**L — Prob Path Forecast v1.0**  
> 配套：[`PROB-PATH-FORECAST-V1.md`](./PROB-PATH-FORECAST-V1.md) · [`PROB-PATH-FORECAST-RESEARCH.md`](./PROB-PATH-FORECAST-RESEARCH.md) · [`PROB-PATH-META-SCHEMA.md`](./PROB-PATH-META-SCHEMA.md)  
> 图例：实线框 = 已有模块；虚线框 = v1 拟新增；`[(DB)]` = SQLite 表

---

## 1. 总览：在 GoldRush 四层中的位置

下图为 **端到端架构**：从当日 `analysis` 产出的信号，到 **经验条件分位路径**，再经 **门禁** 到 **Explain 出图**。  
**Portfolio 层 v1 不接入**（仓位仍只由 `recommendPosition` / 短期档决定）。

```mermaid
flowchart TB
  subgraph ingest["数据采集（已有）"]
    DC[data-collector / live-anchors]
    DC --> GPR[(gold_prices)]
  end

  subgraph analysis_day["analysis 当日流水线（已有）"]
    direction TB
    A1[技术面 Agent]
    A2[基本面 Agent]
    A3[情绪面 Agent]
    A4[资金面 Agent]
    QS[quant-score 本地 11 因子]
    RB[rebuttal + calibration-adjust]
    ORC[orchestrator 合成]
    A1 & A2 & A3 & A4 --> ORC
    QS --> ORC
    RB --> ORC
    ORC --> AR[(analysis_reports)]
    ORC --> SF[(scenario_features)]
    ORC --> MD[docs/*.md + *.meta.json]
  end

  GPR --> QS
  GPR --> analysis_day

  subgraph signals["Signals 层 — Prob Path v1（新增）"]
    direction TB
    PP_IN[prob-path-forecast.ts]
    BKT[score-buckets 分桶选样]
    SIM[scenario-similarity 相似日扩样]
    FR[forward-return / 逐日 cumPct]
    PCT[P10 / P50 / P90 分位序列]
    BKT --> PP_IN
    SIM --> PP_IN
    FR --> PP_IN
    PP_IN --> PCT
  end

  AR --> BKT
  ORC -->|overall.score| BKT
  SF --> SIM
  GPR --> FR

  subgraph gates["Gates 层（已有 + 延伸）"]
    DQ[data-quality-gate 红档/陈旧]
    SAM{样本 n ≥ 10<br/>且金价有效?}
    PCT --> SAM
    DQ --> SAM
  end

  subgraph portfolio["Portfolio 层（已有，v1 不改动）"]
    POS[recommendPosition]
    DUAL[evaluateDualScore]
    ADV[resolveOperationalAdvice]
    POS --> ADV
    DUAL --> ADV
  end

  ORC -.->|仅并列展示| POS

  subgraph explain["Explain 层 — Prob Path v1（新增）"]
    CHART[prob-path-chart.ts → SVG]
    PATH_CMD[CLI: goldrush path]
    META_EXT[meta.probPath 5d/20d]
    WEB[web/prob-path-panel.cjs]
    SAM -->|通过| CHART
    SAM -->|不足/红档| CHART
    CHART --> PATH_CMD
    CHART --> META_EXT
    META_EXT --> WEB
    MD -.-> META_EXT
  end

  style signals fill:#f6f8fa,stroke:#0969da,stroke-width:2px
  style explain fill:#f6f8fa,stroke:#0969da,stroke-width:2px
```

**读图要点**

| 箭头含义 | 说明 |
|----------|------|
| 四面 LLM → `overall` | 进入 **分桶条件**，不直接画扇形数值 |
| `scenario_features` → 相似日 | 分桶 \|S\| &lt; 30 时扩样；特征含技术/宏观/情绪/资金 |
| `gold_prices` → cumPct | 扇形 **唯一价格真相源**；LLM 情景价 **不进** 主图 |
| Gates → Chart | n&lt;10：**仅历史 % 线**；红档：**扇形 + 降级图例** |
| Portfolio 虚线 | 概率路径 **不修改** 仓位公式；与操作建议 **并列** |

---

## 2. 算法流水：样本瀑布与双视野（5d / 20d）

```mermaid
flowchart LR
  subgraph today["决策日 T"]
    SC[overall.score]
    FE[今日 scenario_feature]
  end

  subgraph pool["历史样本池 S"]
    S1[同分桶报告日]
    S2[相似日补充]
  end

  SC --> S1
  S1 -->|"|S| < 30"| S2
  FE --> S2
  S1 --> MERGE[(合并去重 S)]
  S2 --> MERGE

  MERGE --> LOOP["每条 d ∈ S:<br/>收盘(T_d) → 日 h=1..H 累计 %"]
  LOOP --> H5[H = 5 分位折线]
  LOOP --> H20[H = 20 分位折线]

  H5 --> SVG5[SVG 5 日主图]
  H20 --> SVG20[SVG 20 日副图/Tab]

  MERGE --> CHECK{n ≥ 10?}
  CHECK -->|否| HIST[仅渲染历史 60 日 % 实线]
  CHECK -->|是| H5
```

常量（与 [`PROB-PATH-FORECAST-V1.md`](./PROB-PATH-FORECAST-V1.md) 一致）：

- `TARGET_SAMPLE = 30`（分桶不足则扩相似日）  
- `MIN_SAMPLE = 10`（低于此不画未来扇形）  
- 分位：**P10 / P50 / P90**（每个交易日 h 一组）

---

## 3. 模块与文件映射（实现清单）

```mermaid
flowchart LR
  subgraph util["src/utils/（拟新增）"]
    PPF[prob-path-forecast.ts]
    PPC[prob-path-chart.ts]
  end

  subgraph cmd["src/commands/（拟新增）"]
    PC[path.ts]
  end

  subgraph existing["src/（已有依赖）"]
    SB[score-buckets.ts]
    SS[scenario-similarity.ts]
    FWR[forward-return.ts]
    RMT[report-meta.ts]
  end

  subgraph web["web/（拟新增）"]
    PPP[prob-path-panel.cjs]
  end

  PC --> PPF
  PPF --> SB & SS & FWR
  PPF --> PPC
  PC --> PPC
  RMT --> PPP
  PPC --> PPP
```

| 产出路径 | 说明 |
|----------|------|
| `docs/goldrush-prob-path-5d-latest.svg` | CLI 默认 5 日扇形 |
| `docs/goldrush-prob-path-20d-latest.svg` | 20 日扇形 |
| `docs/goldrush-analysis-YYYY-MM-DD.meta.json` | 字段 `probPath`（双视野序列 + n + 条件说明） |

---

## 4. 与「三面 + 量化」的信息边界（防误读）

```mermaid
flowchart TB
  subgraph dimensions["当日研判（已有）"]
    TECH[技术面]
    FUND[基本面]
    SENT[情绪面]
    FLOW[资金面]
    TECH & FUND & SENT & FLOW --> OVERALL[overall.score]
    QF[quant 因子] --> QSC[quantScore]
  end

  subgraph condition["条件化（非加权公式）"]
    OVERALL --> BUCKET[历史同分桶日子集合]
    FEAT[feature 向量] --> ANA[相似日 k-NN]
    BUCKET --> ANA
  end

  subgraph outcome["因变量（纯事实）"]
    ANA --> REAL[历史真实金价路径 %]
    REAL --> FAN[P10/P50/P90 扇形]
  end

  LLM_TXT[LLM 三情景文案] -.->|不驱动数值| FAN

  style outcome fill:#dafbe1,stroke:#1a7f37
  style LLM_TXT stroke-dasharray: 5 5
```

---

## 5. 变更记录

| 日期 | 说明 |
|------|------|
| 2026-11-26 | 初版：总览四层图、样本瀑布、模块映射、信息边界图 |
| 2026-11-26 | 链入 V1 / RESEARCH / ROADMAP |