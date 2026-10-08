# GoldRush 数据质量：事故复盘与防线

> 更新：2026-07-15（含门禁、锚定、东财 GLD/PBOC、Web 色点）  
> 关联：`IMPROVEMENTS.md` 第六～十三轮、`AGENTS.md`、`docs/DUAL-SCORE.md`、`docs/POSITION-AND-TRACK.md`（红档→仓位上限）、`docs/ROADMAP-FINENG.md`（新鲜度 SLA 规划）、`CORRECTNESS-SPEC.md`

---

## 1. 事故摘要（2026-07-15）

当日 `docs/goldrush-analysis-2026-07-15.md` / manifest 出现：

| 现象 | 表现 |
|------|------|
| 价格真空 | 伦敦金 / 上海金 / ETF / DXY / 10Y / TIPS 被标为 0 或 N/A |
| 假宏观信号 | 「偏离 MA20 **−100.0%**」→ 误判 `oversold_repair` |
| 置信度崩溃 | 数据置信度 ~59%，大量 🔴 校验警告 |
| 分析失真 | 技术面/基本面自称「无法给出有效结论」，但流水线仍产出 35 分报告 |

**用户影响**：定投建议若基于该日报，可能被「极度超卖/真空数据」误导。

---

## 2. 根因链

```
LLM/schema 把「缺失」写成 value=0, source=N/A
        ↓
saveSnapshot / upsert 写入 gold_prices.london_close = 0
        ↓
forwardFillCloses 把 0 当作有效收盘价
        ↓
deviationFromMA ≈ (0 - MA) / MA = -100%
        ↓
macro-regime / 因果链 / 置信度 / 叙事全部失真
```

叠加因素：

1. **Yahoo Finance 在生产机超时** → 历史回填、GLD 份额、旧版实时锚定失败  
2. **采集时段**（UTC 凌晨）现货流动性差，搜索提取更易空  
3. **校验层**对 `value != null` 把 `0` 当成「有值」继续交叉验证  

---

## 3. 防线（已落地）

### 3.1 解析层

- `isValidMarketNumber(v)`：拒绝 `null` / `NaN` / **恰好为 0**（允许负 TIPS）  
- `isMissingPrice(p)`：`source === 'N/A'` 或非法数值  
- `parseMarketData`：0 价不进入有效 `SourcedPrice` 语义  

### 3.2 入库层

- `saveSnapshot`：N/A 与 0 不写库  
- `GoldPricesRepo.upsert`：sanitize 后 `COALESCE(excluded, existing)`，**无效值不覆盖有效历史**  
- `mapRow`：读库时将历史 `0` 映射为 `null`  

### 3.3 指标层

- `forwardFillCloses`：仅 `londonClose > 0` 更新 last  
- `listMissingLondonDates` / `countLondonRowsInWindow`：0 计为缺失  

### 3.4 锚定层（零 LLM）

| 优先级 | 源 | 模块 |
|--------|-----|------|
| 1 | Yahoo（短超时） | `yahoo-live` / `yahoo-gold-history` |
| 2 | gold-api.com XAU | `live-anchors.fetchGoldApiLive` |
| 3 | 新浪 `hf_GC` / `gds_AU9999` / `sh518880` | `live-anchors.fetchSinaHq`（自动识别贵金属/A股格式） |
| 4 | LBMA 定盘历史 | `fetchLbmaGoldHistory`（回填） |
| 5 | FRED（常超时） | 10Y / TIPS / 宽美元 |

**每个价格字段都必须有零 LLM 直连锚定**（伦敦金 / 上海金 Au99.99 / 黄金ETF 518880），
搜索+LLM 只能作补充，不能作唯一来源——Tavily snippet 常是 SEO 聚合页，**没有数字可抽**。

采集后：`DataCollectorAgent.enrichWithLiveAnchors`：
1. 缺失/0 → 锚定填充；
2. LLM 抽价与锚定**偏差 >3%** → **锚定优先**（LLM 原值进 `altPrices` 供审计），
   防止「垃圾 snippet → 错价写库」（如 2026-10-07 `london_close=5158.7` vs 锚定 4147.6 污染案例）。

> 上海金换算自检（10-08 实测）：USDCNY≈6.70 → 理论 887 元/克，新浪 `gds_AU9999`=890.75 偏差 0.4%；校验时勿再用旧假设「汇率≈7.1」。

### 3.5 校验层

- Validator 跳过 missing 价  
- `checkPriceConsistency`：金价 ≤0 直接告警并返回，**不算日波动 −100%**  

### 3.6 主力数据

| 维度 | 策略 |
|------|------|
| CFTC | 官方 ZIP，现网可用 |
| GLD | Yahoo 双通道；失败 → null，信号中性 50，**不估假吨数** |
| PBOC | `pboc-grabber` 启发式；失败 → null |

---

## 4. 运维手册

### 4.1 检查是否仍有脏 0

```bash
cd /root/git/goldRush
sqlite3 data/goldrush.db \
  "SELECT date, london_close FROM gold_prices WHERE london_close=0 OR london_close IS NULL ORDER BY date DESC LIMIT 20;"
```

### 4.2 清理脏 0（幂等）

```sql
UPDATE gold_prices SET london_close=NULL WHERE london_close=0;
UPDATE gold_prices SET shanghai_close=NULL WHERE shanghai_close=0;
UPDATE gold_prices SET dollar_index=NULL WHERE dollar_index=0;
UPDATE gold_prices SET us10y_yield=NULL WHERE us10y_yield=0;
UPDATE gold_prices SET tips_yield=NULL WHERE tips_yield=0;
UPDATE gold_prices SET etf_nav=NULL WHERE etf_nav=0;
```

### 4.3 补历史与当日

```bash
npm run build
node dist/index.js init-history --days 60   # Yahoo → LBMA
node dist/index.js price                    # 采集 + 锚定（需 opencode + 可选 Tavily）
node dist/index.js flow                     # CFTC/GLD/PBOC（纯本地算分）
node dist/index.js analysis --md            # 重出日报（耗时）
```

### 4.4 快速探针（不跑 LLM）

```bash
node --input-type=module -e "
import { fetchGoldApiLive, fetchSinaHq, fetchLbmaGoldHistory } from './dist/data/live-anchors.js';
console.log(await fetchGoldApiLive());
console.log(await fetchSinaHq('hf_GC'));
const h = await fetchLbmaGoldHistory(30);
console.log('lbma', h.length, h.slice(-2));
"
```

---

## 5. 报告可信度判读

阅读 `docs/goldrush-analysis-*.md` 或 Web 仪表盘时：

1. 先看 **数据置信度** 与 **validationWarnings**  
2. 若出现「价格缺失 / 均为零值 / 偏离 MA20 −100%」→ **丢弃当日叙事**，先修数据再分析  
3. 对比 **LLM 分 vs 量化分**：偏差 >15 且数据警告多时，以量化与主力（CFTC）为辅证  
4. `flow` 中 GLD/PBOC「暂无法判断」是诚实降级，不是中性结论本身  

---

## 6. 置信度与门禁（2026-07-15 修订）

### 6.1 计分

| 规则 | 值 |
|------|-----|
| A 级单源字段 | **72**（原 55） |
| B / C 级单源 | 50 / 35 |
| 字段加权 | **伦敦金 50%** + 其余字段平均 50% |
| LLM 权重 | 锚定一致时 **0.2**，否则 0.4 |

### 6.2 分档门禁（`evaluateDataQualityGate`）

| 档 | 条件 | 操作结论 |
|----|------|----------|
| 🔴 red | 无有效金价 **或** 锚定偏差&gt;3% **或** conf&lt;**35** | **关闭**（勿加减仓） |
| 🟡 yellow | 35≤conf&lt;60 / 单源 / 可选字段缺失 | 可出报告，顶栏黄条 |
| 🟢 green | conf≥70 且锚定偏差&lt;1%（或无锚定） | 正常 |

**不再**使用「综合置信度 &lt; 55 整份作废」。

### 6.3 采集顺序

```
直连锚定（gold-api/新浪/…）→ 搜索+LLM 补全 → 再 merge 锚定
```

### 6.4 Web 展示（`server.cjs`）

| 位置 | 行为 |
|------|------|
| 文章首屏 | `dq-banner` 红/黄/绿条 + 置信度 |
| 速读卡 / 预测仪表盘 | 门禁徽章；红档覆盖「定投建议」文案 |
| 首页列表 / 英雄卡 | 色点 + 置信度；红档显示「勿据此加减仓」 |
| 仓位推荐 | 红档 → 目标仓上限 35%（见 [POSITION-AND-TRACK.md](./POSITION-AND-TRACK.md)） |
| 旧日报无门禁小节 | 按 conf 推断：&lt;35 红，≥70 绿，其余黄 |

解析函数：`extractDataQualityGate` / `renderQualityBanner`。

---

## 7. 已知缺口（未关闭）

| 项 | 状态 | 建议 |
|----|------|------|
| GLD 持仓吨数 | ✅ 东财新闻解析 SPDR 吨数（现网） | 样本少时粗判；可继续扩历史 |
| PBOC 月度吨数 | ✅ 东财搜索「中国央行黄金储备」 | 月更，连续增持月数可再校准 |
| FRED 利率序列 | 常超时 | 国内镜像或新浪/东方财富利率接口；**已修**：`timestamp` 用观测日，不再伪装「刚刚验证」 |
| 搜索原文存档 | ✅ `docs/search-raw/`（30 天） | snippet 自动对账见 ROADMAP-FINENG 包 H |
| 数据新鲜度 SLA | 规划 | 金价/快照年龄 → 门禁（ROADMAP-FINENG 包 D） |
| 当日错误 MD 报告 | 旧稿仍在 docs/ | 跑完 `analysis --md` 覆盖 |
| 历史回填脏 0 | ✅ `upsertBackfill` 与 `upsert` 同 sanitize | 见 `test/gold-prices-sanitize.test.ts` |

决策质量相关数据项总览：**[DECISION-QUALITY.md](./DECISION-QUALITY.md)** §1.5。

---

## 8. 相关代码索引

| 路径 | 职责 |
|------|------|
| `src/schemas/market.ts` | 合法数值 / 缺失判定 |
| `src/data/live-anchors.ts` | 多源锚定 |
| `src/agents/data-collector.ts` | **先锚定后搜索**、merge、入库 |
| `src/utils/source-rank.ts` | 单源分 / 加权置信度 |
| `src/utils/data-quality-gate.ts` | 红黄绿门禁 |
| `src/db/gold-prices.ts` | CRUD + 净化 |
| `src/utils/price-series.ts` | forwardFill |
| `src/utils/price-consistency.ts` | 程序化一致性 |
| `test/data-quality-gate.test.ts` | 门禁与计分回归 |
