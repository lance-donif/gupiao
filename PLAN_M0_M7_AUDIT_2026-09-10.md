# M0–M7 重写计划开发完成度审计

审计日期：2026-09-10。对象：当前本地工作区（含未提交改动）。
替代 `PLAN_COMPLETION_AUDIT.md`（2026-09-08）中已被本轮实现覆盖的部分。

## 结论

**计划整体未完成，不可按"开发完成"验收。** 八个开发包中：

| 包 | 状态 | 完成度估算 |
|---|---|---|
| M0 基线/版本常量/夹具 | 未开始 | ~10% |
| M1 阶段执行器/检查点/租约/幂等 | 部分完成 | ~40% |
| M2 抽取缓存/逐条协议/旧任务兼容 | 部分完成 | ~45% |
| M3 批次规划/模型选路/指标/故障隔离 | 部分完成（调度 70% / 规划器 25%） | ~45% |
| M4 原子发布/读取隔离/后处理拆分 | 部分完成 | ~45% |
| M5 时间可见性/交易日历/行情契约/对账 | 未开始 | ~15% |
| M6 事件证据/归一化评分/惩罚候选 | 未开始 | ~20% |
| M7 滚动实验/性能基准/迁移与部署 | 未开始 | ~5% |

工作区当前有 14 个未提交改动文件 + 1 个新增测试文件，说明正处在 **M1/M2 开发中间态**，尚未形成可提交的开发包。

## 0. 计划中两处基线描述与现实不符，需先修正

1. **测试基线数字过时。** 实测（vitest）：**393 通过 / 1 失败 / 17 跳过**（61 文件通过、1 失败、2 跳过）。计划写的"384 通过、2 失败、10 跳过"已不成立。
   - 当前唯一失败：`tests/unit/services/causal-signal-extraction-service.test.ts:16`，`Cannot read properties of undefined (reading 'extractorType')`，是未提交改动引入的 **mock 回归**，与路径无关。
   - **计划 M0 要求"修正两个 Windows/POSIX 硬编码路径失败测试"——当前工作区不存在这两个失败用例。** 该验收项前提已失效，需重新界定 M0 范围。
2. **lint 命令存在。** `backend/package.json`：`"lint": "oxlint src scripts"`，`check:fix = typecheck && lint && test`。计划里"没有独立 lint 命令"的说法错误，交付时不能按此描述报告。

另外注意：测试运行器是 **vitest**（`bun run test`），`bun test` 无法识别用例；引用时应写 `bunx vitest run`。

---

## M0 · 未开始

- 无集中版本常量模块：`recipeVersion` / `schemaVersion` / `promptVersion` / `extractionSemanticVersion` 全仓零命中，均为散落字面量（`ai-causal-workflow.ts:11` `AI_WORKFLOW_VERSION='causal-workflow-v2'`、`causal-signal-extraction-service.ts:362`、`stock-exposure-types.ts:11`）。
- 无通用测试夹具工厂，仅 `tests/unit/http/http-fixtures.ts`。
- 路径测试已普遍跨平台化（`os.tmpdir()`/`path.join`），实测无 POSIX 路径失败。

## M1 · 部分完成

**已完成**
- `pipeline-checkpoint.ts:5` `inputFingerprint`：键排序 + `Date.toISOString()`（UTC）+ bigint→string + SHA-256，符合稳定序列化要求。
- `pipeline-checkpoint.ts:38` `runArtifactStage`：输入指纹与产物指纹双匹配才复用。
- `ai-causal-workflow.ts:69-78`：60s 租约 + 10s 续租；`ai-causal-workflow.ts:204` 已尝试根任务保留预算与身份（恢复不重置预算）。
- 两处 lease 均有 1 小时上限。
- CLI：`--resume-trace-id`、`--publish-only`、`--from-forecast` 已支持。
- `tests/integration/pipeline-consistency.integration.test.ts`（新增）覆盖租约互斥、总时限中止、阶段失败回滚+幂等跳过、发布与 SUCCESS 原子、未完成 run 不展示。

**未完成**
1. 无 `PipelineStage<I,O>` 接口（`buildInput`/`fingerprint`/`execute` 零命中）；编排仍是 `run-daily-recommendation.ts` 顺序硬编码调用。
2. 计划定义的 14 个阶段标识未代码化。现状命名（`normalize`/`deduplicate`、`stock_exposure_*`、`scoring_recommendation`、`autopilot_evaluation`）与计划（`news_prepare`、`exposure_refresh`、`market_features`、`evidence_score`、`recommendation_select`、`strategy_evaluation` 等）不一致，且无依赖声明表。
3. 七态状态机未集中定义：step 仅 `PENDING/RUNNING/SUCCESS/FAILED`（`trace-manager.ts`），`PAUSED`/`NEEDS_ATTENTION`/`WAITING` 仅存在于 `AiWorkItem`。
4. **无递增租约代次（generation/epoch）**：`ai-causal-workflow.ts:247` 靠 `owner` UUID + `leaseUntil>now()` 拦截过期提交；`pipeline-run-lease.ts` 是 pg advisory lock，无 60s 租约语义。两套租约机制未统一。
5. 运行键 `createTraceId`（`pipeline-utils.ts:129`）= `daily-${clusterKey}-${dateKey}-${suffix}`，**缺 `recipeVersion` 与 `businessConfigHash`**。
6. `--recompute-from <stage>` / `--source-trace-id` 未实现；`--stop-after` 仅支持 `dedup`（`pipeline-utils.ts:162`）。
7. 中断恢复测试未覆盖 14 阶段端到端 `--resume-trace-id`/`--recompute-from`，也未测 `AiWorkflowSession` 执行中中断。

## M2 · 部分完成

**已完成**
- 缓存指纹 = SHA-256(title+content+source)（`causal-signal-extraction-service.ts:320`），不含 newsId/trace/批次 ✓；跨日复用 ✓（`seedContentCache` 按 fingerprint+asOf）；`no_signal` 结果已存（`ai-causal-workflow.ts:161`）；证据偏移已存（`:431`）。
- 逐条协议校验严格：遗漏/重复/未知 ID/非法证据 → 整次抛错不部分提交（`:381-398`、`:558`），测试用例已覆盖 bad-evidence 与 wrong-keyword。

**未完成**
1. 响应结构仍是 `{signals, noSignalNewsIds}`（`:340`/`:380`），**未对齐计划要求的 `{items:[{newsId,status,signals}]}`**。
2. **无按缓存键的并发领取租约**（等待者消费已提交结果），存在并发重复付费风险。
3. 原文未持久化，仅存指纹哈希 + 证据片段。
4. **旧版本 trace 兼容执行器未实现**：`readAiCheckpoint`（`:46`）版本不符直接抛错要求新 trace，旧 trace 无法被完成，也未保留其成功批次与累计预算。
5. 下游恢复仍以 `PipelineStepTrace.status=SUCCESS` 为闸（`trace-manager.ts:122`），未按实际产物判定完整性。

## M3 · 部分完成（调度较好，规划器差距大）

**已完成**：调度与故障隔离主体 —— PG 统一调度器、供应商并发 2/最高 5/全局 10、共享额度组优先、AIMD、Retry-After 遵守、45/45/180 秒超时、根批次与拆分共享 24 次预算、预算预扣与租约原子提交、全部不可用→`NEEDS_ATTENTION`（`ai-adaptive-scheduler.ts:56-135`、`ai-scheduler-store.ts`、`ai-transport.ts:13-14`、`ai-causal-workflow.ts:237`）；上下文常量 16000/64000/8192/128000 与安全余量 2048（`ai-batch-planner.ts:40-47`）；真实 usage 保存并标来源（`ai-transport.ts:67-68`）。

**未完成（`ai-batch-planner.ts`）**

| 计划项 | 现状 |
|---|---|
| 按长度分桶 + 桶内按发布时间/ID 稳定排序 + 枚举 1..64 前缀 | 无分桶、无稳定排序（`:54`） |
| 等待 >3 分钟优先最老新闻桶（防饥饿） | 未实现 |
| 输出预估 = 256 + n×单条，再 ×1.25 | 缺 256 基值；单条用 P90×1.5（`:49`）/×1.25（`:228`），与计划 1.25 不一致 |
| 观测窗口 7 天 / 最多 50 次 / 四维隔离 | 现为 `slice(-20)`（`:42`） |
| ≥5 条真实 usage 后 P90×1.2 校准输入估计 | 未实现 |
| 预测耗时 = 首内容 P80 + 输出量/生成速度 P20，缺省 90s | 未实现 |
| 合法完成率 = (合法+2)/(有效+3) | 现为 EMA（`:118`） |
| 选择 = n×完成率/(等待+请求耗时) | 现为 `latency/validRate`（`:71`） |
| 批量增长硬性封顶 25% | 未实现（因子 0.5–2，`:46`） |
| 每 10 次成功探测最久未服务健康模型 | 未实现 |
| 字符上限 240000 | 现硬编码 **220000**（`:59`），与全局 240000 规则不一致 |

## M4 · 部分完成

**已完成**：`schema.prisma:203` `isPublished` 字段；日报（`daily-report-reader.ts:221,246`）与 Dashboard（`runtime-data-operations.ts:2724,2810,3108`）硬过滤 `isPublished=true`；迁移 `20260908000002_pipeline_consistency` 对 `status=SUCCESS` 的推荐 trace 回填发布（失败 trace 残留不发布）；`publishLatestSnapshot`（`run-daily-recommendation.ts:127-166`）按 `completedAt desc` 取最新成功 trace。

**未完成**
1. **无独立发布记录表**，发布仅布尔位翻转，无版本/审计实体。
2. **`COMPLETE_EMPTY` 全仓零命中。** 空证据仅 `run-daily-recommendation.ts:1304` 抛 `PipelineStopError`；"证据存在但候选全被过滤"无状态与原因记录。
3. **后处理未拆分，且违背发布语义**：主题对账（`:1243`）、关键词惩罚（`:1256`）、自提升建议（`:1332`）仍内联在每日入口；`backtest-engine.ts:381-387` 仍内联执行策略实验；`completeRunTrace`（`:1473`）位于**全部后处理之后**，后处理失败会阻断/撤销发布 —— 与计划"对账失败不能撤销已完成的发布"相反。
4. **仍可读到未发布数据的路径（高风险）**：
   - `contribution-reader.ts:61` → `/api/batches/contribution`（`routes.ts:223`）：任意 traceId 的 `EvidenceContribution`，无发布过滤。
   - `runtime-data-operations.ts:2663-2712`：策略推荐读 `StrategyRecommendationEvent`（该表无 `isPublished`），仅靠 trace 级 EXISTS 软门控。
   - `routes.ts:404-490`：trace overview/steps/events 暴露未发布 RunTrace，无草稿标记。
   - `runtime-data-operations.ts:2762-2780`：Dashboard 执行历史展示当日 FAILED/未发布 trace。
5. 旧数据迁移仅按 trace 状态回填，无完整性校验环节。

## M5 · 未开始（且存在未来数据泄漏）

**已有基础**：`yield-visibility.ts:2` `dailyCloseVisibleAt`（交易日 15:00 北京时间）；`backtest-engine.ts:312` 盘中不可见当日收盘守卫；`:483-488` 仅 `futureCandles.length>=5` 才填 yield5Day（未用短周期填充 ✓）；`keyword-performance-penalty-service.ts:30-35` 只读已成熟收益 ✓。

**⚠️ 现存未来数据泄漏点**
- `scoring-contribution-engine.ts:1271 / 1451 / 1982`：行情读取仅 `tradingDay <= asOf`，**无 `dailyCloseVisibleAt` 守卫**。asOf 为盘中时刻时会把当日未收盘的完整日线（含 close/high/low）纳入评分特征。
- `backtest-engine.ts:303`：`marginAfter = min(evaluationAsOf ?? new Date(), asOf+20d)`，未传 `evaluationAsOf` 时可见边界回退到 **now**，盘中运行纳入尚未可见的收盘价。

**未开始项**
1. 统一市场数据读取接口（asOf + 数据集版本 + 业务时间 ∧ 可信可见时间双检）。`src/sources/contracts.ts:7` 的 `ISourceRequestBase` 仅 `asOf?`。
2. 数据修订版本固定与恢复沿用（全仓无 revision/dataset version 概念）。
3. 交易日历版本化：`src/types/value-objects/trading-calendar.ts:1-65` 仍硬编码 2024–2025 假期，`isTradingDay` = 非周末且非假期即交易日（正是"工作日即交易日"反模式），缺覆盖年份不返回数据缺口。
4. 行情数据契约：`schema.prisma:72-89` Candle 仅 OHLCV + capturedAt，缺 tradingStatus、历史涨跌停价、复权口径、corporate actions、可见时间。
5. 版本化数据集导入与校验入口（JSONL）；现有来源缺字段标"未知"。
6. 前复权旧数据禁入严格成交回测的开关（现仍直接读取算收益，`backtest-engine.ts:481`）。
7. 历史状态建模：`schema.prisma:52-70` Stock 仅当前 industry/exchange，无 isST、listedAt、delistedAt、行业历史；`backtest-engine.ts:292` 按 asOf 用当前 industry，会把今天名单套到过去。
8. 收益元数据字段：缺 status、plannedExitDay、actualExitDay、maturityAt、computeVersion。

## M6 · 未开始

- **无 `baseline-v1` / `event-v2` 常量与配置开关**（全 src 零命中）。生产默认即现行引擎，但未显式标注 baseline。
- **事件证据模型整体未实现**：无"转载组 + 规范关键词 + 经营变量"事件键；无同（事件/股票/关键词/极性）取最大贡献 + 证据 ID 平手选择；无 `1−∏(1−q)` 最强 3 独立事件聚合；无 E+/E−/E 净证据分离（`calculateEvidenceComponentScore:747` 仍用 `1−exp(−x/1.8)` + 多样性奖励）。
- **权重搜索网格未实现**：`{45,50,55,60}` / `{0,5,10}` / `{15,20,25}` / 市场 20–35 全为硬编码常量（`scoring-contribution-engine.ts:148-151`）。
- **平滑惩罚未实现**：无 `p0`、20 日半衰期、责任权重分配、`p=(L+20p0)/(n+20)`、`n<5→1`、无"现行/无/平滑"三配置比较框架。现行惩罚硬编码 `factor=0.6 / cooldown=7 / threshold=-0.03 / lookback=30`（`keyword-performance-penalty-service.ts:24-28`）。
- **已符合项**：归一化加权总分 0–100；质量门槛比较原始特征（`temp-stock-recommendation-service.ts:462-497`）；证据 <10 且图谱 ≥12 等价门槛（`:483`）；暴露 <4（`:486`，但被附加 `!(evidenceScore>=18 && marketSignalScore>=8)` 条件，与计划措辞偏离）；行业动量惩罚（`:677-710`）、市场宽度（`:714-731`）、平手按股票代码（`:749`）。

**⚠️ 评分依赖输入遍历顺序的三处（本包核心风险）**
1. `deduplicateContributions`（`scoring-contribution-engine.ts:1923-1933`）：平手保留先遇到者，未按证据 ID 稳定选择。
2. `createExposureContributions` 的 `seen` 去重（`:1858-1862`）：键 `${newsId}:${symbol}:${exposureKeyword}`，同关键词仅取首个 exposure，违反"多重匹配取最高有效匹配"。
3. `loadActiveKeywordPerformancePenalties`（`:1696-1699`）：`current.factor<=factor` 时保留先到者。

## M7 · 未开始

- `strategy-experiment-core.ts`（546 行）是**权重参数实验**，无滚动窗口：全仓 `trainWindow`/`testWindow`/`rolling`/`walkForward`/`outOfSample` 零命中。120/20/20 划分、区间隔离 5 日、测试窗口前移 20 日均未实现。
- **无统计算法**：`blockBootstrap`、`confidenceInterval` 零命中（`bootstrap` 仅 `src/index.ts` 无关命中）。上线门槛（≥60 测试交易日、≥200 有效成交、块长 10 日 ×2000 次 × 固定种子、95% CI 下界 >0、回撤与最差 5% 日收益不劣于基线）全部未实现。
- **无交易成本模型**：`slippage`、`basisPoints`、`corporateAction` 零命中。
- **无实验独立命名空间**：`namespace` 零命中。
- **无批次性能基准**：无"固定新闻快照 + 固定模拟供应商 + 随机种子，对比固定 3 条/当前算法/新算法"的基准测试，无覆盖率/耗时/请求数/Token/重试量报告。现有 `tests/unit/services/ai-batch-planner.test.ts` 仅 6 个用例。
- **测试基建**：集成测试未使用独立测试库/Schema（`DATABASE_URL`/`schema=`/`search_path` 在 vitest 配置与测试 setup 中零命中）；无把 skip 单列报告的机制。
- **HTTP 发布筛选**无专门集成验证，仅 `pipeline-consistency.integration.test.ts` 间接涉及。

---

## 待开发项汇总（按建议执行顺序）

### 立即（当前开发包收尾，否则现有改动无法交接）
- A1 修复 `causal-signal-extraction-service.test.ts:16` 的 mock 回归，使测试回到全绿。
- A2 补齐 M1 的 `PipelineStage<I,O>` 接口与 14 阶段依赖表，统一七态枚举，合并两套租约并引入递增代次。
- A3 运行键加入 `recipeVersion` + `businessConfigHash`（依赖 M0 的集中版本常量）。
- A4 因果响应协议对齐 `{items:[{newsId,status,signals}]}`。

### 短期（M4 之前，可靠续跑是首个可上线价值点）
- B1 建立发布记录实体，替换 `isPublished` 布尔位。
- B2 补齐 4 条未发布数据泄漏读取路径（contribution 接口、策略推荐事件、trace 调试接口、Dashboard 执行历史）。
- B3 实现 `COMPLETE_EMPTY` 与"候选全过滤"分支。
- B4 后处理从每日入口与 BacktestEngine 拆出，发布提交前移，保证对账失败不撤销发布。

### 中期（数据与算法正确性，M5 是 M7 的前置）
- C1 修 `scoring-contribution-engine.ts:1271/1451/1982` 的盘中未来数据泄漏。
- C2 版本化交易日历（含开闭市、来源、数据缺口）。
- C3 行情数据契约扩展 + JSONL 版本化导入 + 前复权口径校验开关。
- C4 股票历史状态（ST/上市退市/行业）建模。
- C5 M6 事件证据模型 + `baseline-v1`/`event-v2` 开关 + 权重网格 + 平滑惩罚 + 消除 3 处遍历顺序依赖。

### 后期（验收与切换）
- D1 批次性能基准（固定快照 + 模拟供应商 + 种子）。
- D2 滚动实验框架 + 分块 Bootstrap + 上线门槛判定。
- D3 集成测试独立库/Schema；skip 单列。
- D4 迁移演练与部署脚本（启动前检查已有进程）。

## 验收时不可跳过

- `bun run check:fix`（= typecheck + **oxlint** + vitest，lint 命令是存在的）。
- 计划要求的"PostgreSQL 集成测试用独立库/Schema""skip 单列不计通过""HTTP 发布筛选集成验证""Dashboard 与推荐历史页面验证"目前**均无对应产物**。
- 始终保留的硬约束（新闻失败停止、LLM 不降级、证据为空停止、严格时间边界、选股硬限制）现状保留，但 M5 泄漏说明"严格时间边界"在评分路径上并未真正成立。
