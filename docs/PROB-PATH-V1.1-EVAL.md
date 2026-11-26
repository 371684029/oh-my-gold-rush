# Prob Path v1.1 — 校准与样本外评估（规划）

> v1 **刻意不做** 对外覆盖率承诺；本文定义 **内部** 验收路线。

## 指标

| 指标 | 定义 | 工具入口（拟） |
|------|------|----------------|
| **Empirical coverage** | 实现路径是否落在 P10–P90 | `calibrate --path-coverage` |
| **CRPS** | 分位路径 vs 实现 | 同命令 |
| **Walk-forward** | 训练窗估条件 / 测试窗不重叠 | 复用 `walk-forward.ts` |
| **对照基准** | 无条件 P50 vs 条件 P50 | `probPath.baseline` 已有字段 |

## 图例（v1.1 新增）

当 walk-forward 测试窗覆盖率偏离 80% 超过 15pp 时，扇形标注 **「校准偏离，仅供研究」**。

## 参考

- [`PROB-PATH-META-SCHEMA.md`](./PROB-PATH-META-SCHEMA.md)
- [`PROB-PATH-FORECAST-RESEARCH.md`](./PROB-PATH-FORECAST-RESEARCH.md) §3.4