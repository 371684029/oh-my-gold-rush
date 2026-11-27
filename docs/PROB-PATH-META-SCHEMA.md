# probPath 契约（report-meta sidecar）

> `report-meta` 顶层 `schemaVersion` **仍为 1**：`probPath` 为 **可选** 扩展字段，不匹配时 Web 优雅忽略。  
> 路径数据自身契约：v1 骨架为 `probPath.schemaVersion === 1`；**v2.0 升级为 `probPath.schemaVersion === 2`**（Web 面板兼容读取 v1/v2）。

---

## 根字段

```jsonc
{
  "schemaVersion": 1,
  "probPath": { /* ProbPathMeta (v2) */ }
}
```

---

## ProbPathMeta（v2 契约）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `schemaVersion` | `2` | 是 | 路径子契约版本（v1 仅含三分位且 5/20 共用条件） |
| `asOf` | `string` | 是 | 决策日 `YYYY-MM-DD` |
| `spot` | `number` | 是 | 当日伦敦金收盘（全图 **0% 统一锚点**） |
| `vol20dPct` | `number` | 是 | 当日 20 日实现日波动率 / ATR%（FHS 缩放基准 $\sigma_0$） |
| `degraded` | enum | 是 | 整体降级状态（见下表） |
| `inSampleNote` | `string` | 是 | 固定提示或最新 OOS 校准摘要（不承诺预测准确率） |
| `gateHint` | `string \| null` | 是 | 来自真实 `data-quality-gate` 的红/黄档附加句；绿档为 `null` |
| `structure` | array | 是 | 结构位相对现价 %（含动态支撑/压力分类与可选触达概率） |
| `history` | array | 是 | 近 60 日相对 **`spot`** 的走势 %（`asOf` 当日严格为 `0`） |
| `horizons` | object | 是 | 键 `"5"` / `"20"`，**各自独立持有条件、样本、FHS 参数、分位与基准** |
| `svgRel` | object \| null | 否 | 相对 `docs/` 的**按日期命名** SVG 文件名（禁止指向 `-latest.svg`） |

### `degraded` 枚举

| 值 | 含义 | 未来扇形 | 图例 |
|----|------|----------|------|
| `full` | 有效独立样本 $N_{\text{eff}} \ge 25$ | 是（正常条件权重） | 正常 |
| `sparse` | $8 \le N_{\text{eff}} < 25$ | 是（自动向无条件 FHS 收缩） | 「有效样本偏少，已向波动率基准收缩」 |
| `unconditional_only` | 条件样本不足但历史行情池充足 | 是（退回无条件 FHS 扇形） | 「条件样本不足，当前展示波动率基准扇形」 |
| `history_only` | 历史行情池均不足 $n < 10$ | 否 | 「待积累，仅历史走势」 |
| `no_spot` | 无有效现价 | 否 | 不出图 |

---

### `history[]`（修复原点跳空）

每个历史日 $t$ 的纵轴值必须以**今日收盘 `spot`** 为 0% 基准：`pctFromSpot = (close(t) / spot - 1) * 100`，保证 `asOf` 当日精确落在 `0%`，与未来扇形平滑衔接：

```jsonc
{ "date": "2026-11-05", "pctFromSpot": -0.62 }
// ...
{ "date": "2026-11-06", "pctFromSpot": 0 }
```

### `structure[]`（动态支撑/压力 + 触达概率）

`kind` 必须按 `pctFromSpot >= 0 ? 'resistance' : 'support'` 动态判定（不再把 MA20 硬编码为 resistance）：

```jsonc
{
  "label": "布林上轨",
  "pctFromSpot": 3.2,
  "kind": "resistance",
  "touchProb5d": 0.24,   // 5 个交易日内触及该结构位的历史经验频率（可选）
  "touchProb20d": 0.58   // 20 个交易日内触及该结构位的历史经验频率（可选）
}
```

### `horizons["5"] | horizons["20"]` → `ProbPathHorizonV2`

5 日与 20 日**彻底解耦**，各自拥有独立条件、样本池、去重叠有效样本数、收缩权重与路径级风险：

```jsonc
{
  "h": 5,
  "futureFan": true,
  "degraded": "full",
  "condition": {
    "track": "short_quant_vol_analog", // 5d: short_quant_vol_analog | 20d: mid_regime_analog
    "label": "量化 50–60 · 同宏观阶段 + 相似态",
    "score": 54,
    "regime": "real_rate_headwind",
    "rawSampleSize": 48,               // 去重前满足 endDate <= asOf 的样本条数
    "effectiveSampleSize": 29.4,       // 去重叠/权重折算后的有效独立样本数 N_eff
    "shrinkageWeight": 0.18,           // 向无条件 FHS 基准收缩的比例 λ ∈ [0, 1]
    "poolSource": "reports+market_history" // 标明是否引入多年度客观行情特征池
  },
  "fhs": {
    "enabled": true,
    "currentVolPct": 1.15,             // 今日 σ_0（20日实现日波动率%）
    "volRatioMedian": 1.08             // σ_0 / σ_d 中位数（>1 说明今日波动高于历史均值）
  },
  "points": [
    { "h": 1, "p10": -1.45, "p25": -0.62, "p50": 0.08, "p75": 0.79, "p90": 1.62 }
    // ... h = 1..H
  ],
  "pathRisk": {
    "maxDdP50": -1.35,                 // H 日路径内最大回撤中位数 %
    "maxDdP90": -3.40,                 // H 日路径内 90% 分位不利回撤 %
    "upEndProb": 0.54                  // 终点 > 0% 的经验概率
  },
  "baseline": {
    "method": "unconditional_fhs",
    "sampleSize": 520,
    "endP10": -2.60,
    "endP50": 0.25,
    "endP90": 3.10,
    "label": "无条件 FHS 波动率基准"
  }
}
```

### `svgRel`（防覆盖契约）

```jsonc
{
  "path5d": "goldrush-prob-path-5d-2026-11-06.svg",
  "path20d": "goldrush-prob-path-20d-2026-11-06.svg"
}
```

> 仍可额外生成 `goldrush-prob-path-{5,20}d-latest.svg` 供 CLI 快捷查看，但 **`meta.svgRel` 必须永久指向带日期的文件名**，避免历史报告图被覆盖。

---

## 验收边界用例（测试 / 手工）

| # | 场景 | 期望行为 |
|---|------|----------|
| E1 | 新库 `reports < 10`，但 `gold_prices` 有 2 年行情 | 退回 `unconditional_only`（客观 FHS 基准扇形），不强行捏造条件偏置 |
| E2 | 全库历史行情不足 10 天 | `history_only`，仅历史走势，无未来扇形 |
| E3 | 决策日无有效 `london_close` | `no_spot`，省略 `probPath` |
| E4 | 门禁红档（含 `goldrush path` CLI） | 真实读取门禁，写入 `gateHint`；扇形可出，文案禁止操作建议 |
| E5 | 历史回放 `asOf = 2026-09-15` | 严格校验所有入选样本的 **路径终点日期 `<= 2026-09-15`**（零前视泄漏） |
| E6 | 历史走势衔接验证 | `history[last].pctFromSpot === 0`，与 `points` 起点 `(0, 0%)` 连续无跳空 |
| E7 | 连续 5 个交易日同分桶 | $N_{\text{eff}}$ 显著低于 `rawSampleSize`，且不会因连续日重复采样导致假高置信 |
| E8 | 现价高于 MA20 | `MA20` 的 `kind === 'support'`（不再误标为 `resistance`） |
| E9 | 连续生成两天报告 | 昨日 `.meta.json` 的 `svgRel` 仍指向昨日 SVG，不被今日覆盖 |

---

## 文章页 UX（线框）

```
┌──────────────────────────────────────────────────────────────┐
│  📈 黄金概率路径（FHS 条件扇形）        [ 5交易日 | 20交易日 ] │
├──────────────────────────────────────────────────────────────┤
│  [ 浅色主题图：历史实线无缝过 0% → P25–P75 深带 + P10–P90 浅带 │
│    + 无条件 FHS P50 虚线对照 + 动态支撑/压力水平线 ]          │
│  条件：量化 50–60 · 同宏观阶段 · 有效样本 N_eff=29（收缩 18%） │
│  5日终点：P50 +0.6% · 核心带 -0.8%～+1.7% · 外沿 -2.0%～+2.8% │
│  路径风险：期内最大回撤中位 -1.4%（90% 不利 -3.4%）            │
│  结构触达：压力 +3.2% 布林上轨（24%）│ 支撑 -2.1% MA20（41%）  │
│  ⚠ 门禁提示 / 校准读数（红档时仅研究，不构成操作建议）          │
└──────────────────────────────────────────────────────────────┘
```