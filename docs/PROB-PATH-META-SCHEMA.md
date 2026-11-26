# probPath 契约（report-meta sidecar）

> `schemaVersion` **仍为 1**：`probPath` 为 **可选** 扩展字段，不匹配时 Web 忽略。  
> 路径数据自身契约：`probPath.schemaVersion === 1`。

---

## 根字段

```jsonc
{
  "schemaVersion": 1,
  "probPath": { /* ProbPathMeta */ }
}
```

---

## ProbPathMeta

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `schemaVersion` | `1` | 是 | 路径子契约版本 |
| `asOf` | `string` | 是 | 决策日 `YYYY-MM-DD` |
| `spot` | `number` | 是 | 当日伦敦金收盘 |
| `degraded` | enum | 是 | 见下表 |
| `inSampleNote` | `string` | 是 | 固定提示「样本内统计参考，非 OOS 承诺」 |
| `gateHint` | `string \| null` | 是 | 红档/黄档附加句；可 null |
| `condition` | object | 是 | 样本条件说明 |
| `sampleSize` | `number` | 是 | 参与分位的路径条数 |
| `structure` | array | 是 | 结构位相对现价 % |
| `history` | array | 是 | 近 60 日累计 % 实线 |
| `horizons` | object | 是 | 键 `5` / `20` |
| `baseline` | object \| null | 否 | 无条件 P50@5 对照 |
| `svgRel` | object \| null | 否 | 相对 docs 的 SVG 文件名 |

### `degraded` 枚举

| 值 | 含义 | 未来扇形 | 图例 |
|----|------|----------|------|
| `full` | n ≥ 30 | 是 | 正常 |
| `sparse` | 10 ≤ n < 30 | 是 | 「样本偏少」 |
| `history_only` | n < 10 | 否 | 「待积累，仅历史线」 |
| `no_spot` | 无有效现价 | 否 | 不出图 |

### `condition`

```jsonc
{
  "bucket": "50-60",
  "score": 55,
  "bucketCount": 18,
  "similarAdded": 12,
  "method": "bucket_then_similar" // 固定 v1
}
```

### `structure[]`

```jsonc
{ "label": "布林上轨", "pctFromSpot": 3.2, "kind": "resistance" }
```

`kind`: `resistance` | `support`

### `history[]`

```jsonc
{ "date": "2026-07-01", "cumPct": -1.2 }
```

### `horizons."5" | "20"` → ProbPathHorizon

| 字段 | 类型 | 说明 |
|------|------|------|
| `h` | `number` | 交易日数 5 或 20 |
| `futureFan` | `boolean` | 是否画了未来扇形 |
| `points` | array | 长度 h，逐日分位 |

`points[]`:

```jsonc
{
  "h": 3,
  "p10": -0.8,
  "p50": 0.4,
  "p90": 1.6
}
```

### `baseline`

```jsonc
{ "horizon": 5, "p50": 0.35, "sampleSize": 120, "label": "无条件历史路径中位" }
```

---

## 验收边界用例（测试 / 手工）

| # | 场景 | 期望 `degraded` | 期望行为 |
|---|------|-----------------|----------|
| E1 | 新库 reports < 10 | `history_only` | 仅历史 %，无 P10/P90 |
| E2 | 分桶 8 + 相似日补到 15 | `sparse` | 扇形 + sparse 图例 |
| E3 | 决策日无 london_close | `no_spot` | probPath 省略或全空 |
| E4 | 门禁红档 | `full`/`sparse` + `gateHint` | 扇形可出，文案禁止操作建议 |
| E5 | 同日多 report | 去重日期 | 每日期一条路径 |

---

## 冷启动文案（CLI / Web）

```
概率路径：历史报告不足（n&lt;10），仅展示近 60 日涨跌走势；积累更多 analysis 后自动出现 5/20 日扇形。
```

---

## 文章页 UX（线框）

```
┌─────────────────────────────────────────────┐
│  📈 概率路径（统计）  [ 5日 | 20日 ]          │
├─────────────────────────────────────────────┤
│  [ SVG: 灰实线历史 + 彩扇形 + 水平结构线 ]    │
│  条件：分桶 50–60 · n=32 · 样本内统计参考      │
│  5日后：P50 +0.6%  P10~P90 -2.0% ~ +2.8%     │
│  压力 +3.2% 布林上轨 │ 支撑 -4.1% 布林下轨     │
│  ⚠ 红档：路径仅研究参考，不构成操作建议        │
└─────────────────────────────────────────────┘
```

（置于决策面板内、三期条之后；三情景段落 **在下文 MD**，不重写概率。）