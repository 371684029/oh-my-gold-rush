# 概率路径扇形图 — 调研与判断依据（Research）

> 状态：调研定稿（v2.0 金融学升级修订，与 [`PROB-PATH-FORECAST-V1.md`](./PROB-PATH-FORECAST-V1.md) 配套）  
> 日期：2026-11-26  
> 回答：**「大版本」指什么？为何要从原始分桶升级到 FHS + 分轨条件化？金融学与统计学依据是什么？业界参考是什么？**  
> **架构图（Mermaid）**：[`PROB-PATH-FORECAST-ARCHITECTURE.md`](./PROB-PATH-FORECAST-ARCHITECTURE.md)

---

## 1. 「大版本」究竟指什么（避免歧义）

| 名称 | 当前值 | 含义 |
|------|--------|------|
| **npm 包 `goldrush`** | `0.1.0`（`package.json`） | 整个 CLI/Web 仓库的 semver；**本次不升级为 1.0.0** |
| **日报 `meta` 契约** | `schemaVersion: 1`（顶层） | 机器可读 sidecar；内部 `probPath.schemaVersion` 由 v1 骨架升级为 **`2`** |
| **本次所说的「大版本」** | **包 O — Prob Path Forecast v2.0** | `ROADMAP-FINENG.md` 中的概率路径主线（修正原与三期尺度重复的包号 `L`） |
| **后续闭环版本** | **v2.1** | Purged Walk-Forward 样本外评估（覆盖率 / Pinball Loss / CRPS 对标无条件 FHS 基准） |

---

## 2. 核心判断依据：v2.0 如何与「基本面 / 技术面 / 情绪面 / 波动率」衔接？

### 2.1 为什么放弃「单靠 LLM 综合分桶同时预测 5 日与 20 日」？

仓库实证（`docs/goldrush-stats-latest.json`、`docs/OPTIMIZATION-2026-11.md`）给出了清晰证据：

- **LLM `overall.score`** 近 90 日 5 日方向命中仅 **45.5%（5/11）**，与「永远看涨」基准（45%）几乎无差异；LLM 情景概率 Brier 技巧分为 **-0.2**（差于气候学）。
- 真正展示出显著或较强信息量的信号是 **量化分（66.7%）** 与 **中期慢变量分 `mid_term_score`（20 日命中 86.7% vs 基准 12%）**。
- 此外，`HORIZONS.md` 已明确短期（5 日）与中期（1～3 个月）的驱动机制不同——拿日线短期分去画 20 日路径在金融学上属于**时间尺度错配**。

因此 v2.0 确立 **三层分工**：

| 层级 | 在 v2.0 扇形图中的角色 | 原因 |
|------|------------------------|------|
| **LLM 四维与三情景** | **不直接驱动扇形数值**，保留作文字解读与结构化风险提示 | 不可复现且历史 Brier 弱于气候学 |
| **5 日轨条件（短期）** | `quantScore` + 当前波动率 $\sigma_0$ + Z-score 标准化特征相似日 | 对齐短期节奏与波动率聚类 |
| **20 日轨条件（中期）** | `mid_term_score` + 宏观 `macroRegime` + 多年度客观慢变量池 | 对齐黄金定价慢变量（TIPS/DXY/结构/持仓） |

### 2.2 黄金定价因子在相似距离中的权重倾斜（修正余弦偏置）

v1 使用 `scenario-similarity.ts` 的等权余弦相似度存在数学缺陷：`vixLevel / 40 ∈ [0,1]` 与 `geoNum ∈ [0.3,1]` **恒为正值**，当其它维度接近 0 时，任意两个平庸交易日的余弦相似度都会虚高，导致无关样本被放进样本池。

v2.0 改用 **标准化（Z-score）加权欧氏距离 + 同宏观 Regime 优先**：

| 维度 | 特征来源 | 黄金定价经济学地位 | 权重倾向 |
|------|----------|--------------------|----------|
| **实际利率（TIPS）** | `tips_yield` 水平与 60 日趋势 | 黄金机会成本第一定价锚 | **最高** |
| **美元（DXY）** | `dollar_index` 相对均线偏离 | 计价货币核心逆风/顺风 | **高** |
| **波动率 & 趋势结构** | 20 日实现波动率 $\sigma$、MA20/MA50 偏离、近一年分位 | 决定风险带宽与均值回归压力 | **高** |
| **资金面 / 拥挤度** | CFTC 净多头分位、GLD / 央行综合 `flowScore` | 识别极端拥挤与官方买盘支撑 | **中高** |
| **情绪 / 地缘** | VIX、地缘风险等级 | 脉冲式影响大但持续性弱、易均值回归 | **辅助（不主导）** |

---

## 3. 金融学与统计学方法论（为何 v2.0 更严谨）

### 3.1 方法论组合

| 方法 | v2.0 具体落地 | 金融学 / 学术来源 |
|------|---------------|-------------------|
| **滤波历史模拟（FHS, Filtered Historical Simulation）** | 样本路径先除以样本日波动率 $\sigma_d$，再乘今日波动率 $\sigma_0$，最后取分位数 | Barone-Adesi, Giannopoulos & Vosper (1999) *VaR without correlations for portfolios of derivative securities*；机构市场风险标准方法，同时捕捉**波动率聚类（GARCH）**与**厚尾偏度** |
| **央行式密度扇形图（Fan Chart）** | 双层渐变带（P25–P75 核心带 + P10–P90 外沿带 + P50 中位线） | 英格兰银行货币政策报告；[BoE IEO 2024 评述](https://www.bankofengland.co.uk/-/media/boe/files/independent-evaluation-office/2024/forecasting-for-monetary-policy-making-and-communication-at-the-bank-of-england-a-review.pdf) |
| **历史相似态（Historical Analog k-NN）** | Z-score 加权距离 + 同宏观 Regime 优先 + 多年度客观特征池 | [Session-Conditioned Gold Regime Forecasting](https://img1.wsimg.com/blobby/go/f1a5b452-1d8c-4015-8c61-1cbbf2930284/Session_Conditioned_Gold_Regime_Forecasting_Pu.pdf) |
| **重叠样本卫生（Effective Sample Size）** | 严格 `pathEndDate <= asOf` 防前视泄漏 + 连续重叠日降权 + 报告 Kish $N_{\text{eff}}$ | 金融计量经典重叠前瞻窗口自相关问题（Hansen & Hodrick 1980; Newey-West 1987） |
| **经验贝叶斯收缩（Empirical Bayes Shrinkage）** | $Q^{\text{final}} = (1-\lambda) Q^{\text{cond}} + \lambda Q^{\text{uncond\_fhs}}$，$\lambda = K/(N_{\text{eff}}+K)$ | James-Stein / 贝叶斯收缩思想：小样本时压制方差，自动向稳健的无条件 FHS 基准靠拢 |
| **路径级风险指标（Path-Dependent Risk）** | 从缩放路径直接计算期内最大回撤（MaxDD P50/P90）与结构位首达概率 | 贴合定投/波段用户的真实痛点（「中途最大浮亏」比单看终点更有风控意义） |

### 3.2 为什么 FHS 是黄金趋势扇形的「性价比之王」？

对比三类常见金融预测模型：

1. **纯原始历史分位（v1 方案）**：把高波和低波混为一谈，违反金融时间序列最稳健的经验事实（波动率聚类），高波期必然频繁击穿下沿。
2. **参数化正态/GBM 模拟**：假设收益服从正态分布，严重低估黄金的肥尾暴涨暴跌与不对称偏度。
3. **FHS（v2.0 采用）**：**零复杂黑盒参数**，只需 20 日实现波动率 $\sigma$ 缩放，既能实时反映当前市场恐慌/平静程度，又 100% 保留黄金历史真实路径的厚尾、跳空与偏度。

### 3.3 什么算「科学」、什么不算

| 科学且可验证（v2.0 坚持） | 伪科学（明确拒绝） |
|---------------------------|-------------------|
| 可复现：相同 DB + 相同 `asOf` → 完全一致的曲线与数值 | 「顶底必达」「下周精准到 $XXXX」 |
| 严格因果：任何样本路径终点 `<= asOf`，零前视泄漏 | 用未来金价或重叠样本伪造高胜率 |
| 严苛基准：用 **Pinball Loss / CRPS** 对比「无条件 FHS 随机游走」 | 只展示样本内漂亮曲线，不对比朴素基准 |
| 诚实降级：样本不足或跑输基准时自动收缩并明确提示 | 小样本硬画尖锐方向结论 |

### 3.4 样本外评估指标（v2.1 落地，详见 `PROB-PATH-V1.1-EVAL.md`）

| 指标 | 含义 | 对标基准 |
|------|------|----------|
| **Empirical Coverage（80% / 50%）** | 实际终点落入 P10–P90 / P25–P75 的比例 | 名义 80% / 50%（偏离 >15pp 报警） |
| **Pinball Loss（分位数损失）** | 逐分位（10/25/50/75/90）非对称损失 | **无条件 FHS 随机游走扇形** |
| **CRPS Skill Score** | $1 - \text{CRPS}_{\text{cond}} / \text{CRPS}_{\text{uncond}}$ | $> 0$ 才说明条件化有净信息增益 |
| **MaxDD 尾部击穿率** | 实际路径最大回撤跌破 `maxDdP90` 的比例 | 名义 10% |
| **Diebold–Mariano** | CRPS 差值的统计显著性检验 | 非重叠 Purged 测试窗 |

---

## 4. 开源 / 学术参考（精选）

| 项目 / 文献 | 可借鉴点 | 与 GoldRush v2.0 关系 |
|-------------|----------|-----------------------|
| **Barone-Adesi et al. (1999) FHS** | 波动率标准化历史模拟 | **v2.0 核心算法支柱** |
| **Bank of England Fan Charts** ([IEO 2024](https://www.bankofengland.co.uk/-/media/boe/files/independent-evaluation-office/2024/forecasting-for-monetary-policy-making-and-communication-at-the-bank-of-england-a-review.pdf)) | 双层扇形语义、透明图例、校准审计 | **产品表达与视觉范本** |
| **EnCQR / conformal-finance** ([arXiv:2202.08756](https://arxiv.org/abs/2202.08756)) | 有限样本保覆盖校准诊断 | **v2.1 OOS 覆盖率审计参考** |
| **MiQ-MCP** ([GitHub](https://github.com/sanjanbaitalik/MiQ-MCP)) | Purged CV + CRPS 卫生评估流程 | **v2.1 评估框架参考** |
| **Session-Conditioned Gold Regime** | 黄金状态向量 k-NN 加权路径分布 | **v2.0 相似态加权分位参考** |

---

## 5. 用户可见的「判断依据」说明（图例模板）

建议固定呈现在 Web 面板与 MD 报告中：

1. **分轨条件**：5 日看量化/波动相似态，20 日看中期慢变量与宏观阶段；有效独立样本 $N_{\text{eff}}=\{N_{\text{eff}}\}$（收缩权重 $\{\lambda\}\%$）。
2. **波动适配**：历史路径已按当时与今日的 20 日波动率做 FHS 归一化缩放（当前波动 $\sigma_0=\{vol\}\%/日$）。
3. **分位与风险**：深带为 P25–P75 核心区间，浅带为 P10–P90 外沿区间，同步给出期内最大回撤分位与结构位历史触达频率；**非 LLM 编造点位**。
4. **局限声明**：宏观范式突变时历史类比可能失效；红档或校准偏离时仅供研究，仓位仍以短期操作建议为准。

---

## 6. 变更记录

| 日期 | 说明 |
|------|------|
| 2026-11-26 | 初稿：大版本界定、三面映射、方法论、外部项目调研、评估指标 |
| 2026-11-26 | **v2.0 修订**：补充自家统计实证（为何 5/20 分轨）、引入 FHS（Barone-Adesi）波动率归一化理论、指出余弦相似度恒正偏置并改为 Z-score 加权距离、补充 $N_{\text{eff}}$ 重叠卫生、经验贝叶斯收缩与 Pinball Loss / CRPS 基准检验 |