# M0–M7 重写计划 开发完成度复核（2026-09-10 · 复核版）

对象：当前本地工作区（含未提交改动）。方法：实跑测试套件 + 对 8 个开发包的计划要求逐条做代码取证。
替代/修正 `PLAN_M0_M7_AUDIT_2026-09-10.md` 中已过时的判断（该审计写成于 A1 修复与 M0 部分落地之前）。

## 结论

**计划整体未完成，不可按"开发完成"验收。** 8 包中无任何一包达到可交接状态；最靠前的 M1/M2 仍在中间态，且工作区尚未形成可提交的开发包。

| 包 | 状态 | 完成度（本次复核） | 旧审计 |
|---|---|---|---|
| M0 基线/版本常量/夹具 | 部分完成 | ~40%（旧审计 ~10%） | 未开始 |
| M1 阶段执行器/检查点/租约/幂等 | 部分完成 | ~30% | ~40% |
| M2 抽取缓存/逐条协议/旧任务兼容 | 部分完成 | ~30% | ~45% |
| M3 批次规划/模型选路/指标/故障隔离 | 部分完成（调度层 70% / 规划器 12%） | ~30% | ~45% |
| M4 原子发布/读取隔离/后处理拆分 | 部分完成 | ~30% | ~45% |
| M5 时间可见性/交易日历/行情契约/对账 | 未开始 | ~15% | ~15% |
| M6 事件证据/归一化评分/惩罚候选 | 未开始 | ~20% | ~20% |
| M7 滚动实验/性能基准/迁移与部署 | 未开始 | ~5% | ~5% |

## 0. 基线实测（必须先纠正数字）

- 实跑 `bun run test`（vitest）：**401 通过 / 0 失败 / 17 跳过**（65 个测试文件：63 通过、2 跳过）。
- 计划写的"384 通过、2 失败、10 跳过"与旧审计写的"393 通过 / 1 失败 / 17 跳过"**均已过时**。
- **旧审计的 A1（mock 回归）已修复**：`causal-signal-extraction-service.test.ts` 已改，套件全绿；不得再按"有 1 个失败用例待修"交接。
- **M0 计划项"修正两个 Windows/POSIX 路径失败测试"前提已失效**：全 `tests/` 无此类失败用例，路径已是 `os.tmpdir()`/`path.join` 跨平台写法。M0 范围需重定义。
- `backend/package.json` **有独立 lint**：`"lint": "oxlint src scripts"`，`check:fix = typecheck && lint && test`。计划里"没有独立 lint 命令"的表述错误。
- 测试运行器是 vitest（`bun run test`）；`bun test` 无法识别用例。

## M0 · 部分完成（~40%）

- 已建 `backend/src/version.ts`：`RECIPE_VERSION` / `SCHEMA_VERSION` / `EXTRACTION_SEMANTIC_VERSION` / `PROMPT_SCHEMA_VERSION` / `CAUSAL_PROTOCOL_VERSION(_ITEMS)` / `DEFAULT_BUSINESS_CONFIG` / `canonicalize` / `sha256Hex` / `businessConfigHash`。
- 已建测试夹具工厂 `backend/tests/unit/fixtures/pipeline-fixtures.ts`（内存 Prisma + 事务快照回滚）+ `m0-baseline.test.ts`（7 用例）。
- **未完成**：`version.ts` **全仓零引用**（`src/` 无 `from '...version'`），常量未接入任何调用点；无路径测试修复项（前提失效）；14 阶段标识、七态枚举、版本常量消费方均缺。

## M1 · 部分完成（~30%）

- 已有：`pipeline-checkpoint.ts` 的 `inputFingerprint`（键排序 + UTC ISO + bigint→string + SHA-256）与 `runArtifactStage`（输入指纹 ∧ 产物指纹双匹配）；60s 租约 + 10s 续租 + 1h 上限；`--resume-trace-id` / `--publish-only` / `--from-forecast`；新增 `pipeline-consistency.integration.test.ts`（5 用例，**当前全部 skip**）。
- **未完成**
  1. 无 `PipelineStage<I,O>` 接口（`buildInput`/`fingerprint`/`execute` 零命中），编排仍是 `run-daily-recommendation.ts` 顺序硬编码。
  2. 14 个阶段标识未代码化（现仅散落字面量：`news_fetch`、`graph_snapshot`、`reconciliation`），**无依赖声明表**；现状命名与计划不一致。
  3. 七态状态机未集中定义：step 仅 `PENDING/RUNNING/SUCCESS/FAILED`；`PAUSED/NEEDS_ATTENTION/WAITING` 只以 SQL 字面量存在于 AI 队列表。
  4. 无递增租约代次（generation/epoch）；两套租约（`ai-causal-workflow` owner UUID 租约 vs `pipeline-run-lease` pg advisory lock）未统一。
  5. `createTraceId`（`pipeline-utils.ts:129`）仍缺 `recipeVersion` + `businessConfigHash`。
  6. `--recompute-from` / `--source-trace-id` 未实现；`--stop-after` 仅支持 `dedup`。
  7. 中断恢复测试未覆盖 14 阶段端到端与 `AiWorkflowSession` 执行中中断。

## M2 · 部分完成（~30%）

- 已有：缓存指纹 = SHA-256(title+content+source)（不含 newsId/trace/批次）；跨日复用；`no_signal` 与证据偏移已存；逐条协议校验严格（遗漏/重复/未知 ID/非法证据 → 整次抛错不部分提交）。
- **未完成**
  1. 响应协议仍为 `{signals, noSignalNewsIds}`，未对齐计划的 `{items:[{newsId,status,signals}]}`；`version.ts` 里声明的 `CAUSAL_PROTOCOL_VERSION_ITEMS=3` 未被解析逻辑使用。
  2. 无按缓存键的并发领取租约（并发重复付费风险）。
  3. 原文未持久化（仅指纹 + 证据片段）。
  4. 旧版本 trace 兼容执行器未实现：版本不符直接抛错要求新 trace，旧 trace 无法完成，其成功批次/累计预算未保留。
  5. 下游恢复仍以 `PipelineStepTrace.status=SUCCESS` 为闸，未按实际产物判完整性。

## M3 · 部分完成（调度层较完整，规划器差距最大）

- 已有（调度/故障隔离）：PG 统一调度器、供应商并发 2/最高 5/全局 10、共享额度组优先、AIMD、遵守 `Retry-After`、45/45/180 秒超时、根批次与拆分共享 24 次预算、预算预扣与租约原子提交、全部不可用→`NEEDS_ATTENTION`；真实 usage 已保存并标来源。
- **未完成（`ai-batch-planner.ts`，12 项中 11 未实现 + 1 部分）**

| 计划项 | 现状 |
|---|---|
| 长度分桶 + 桶内按发布时间/ID 稳定排序 + 枚举 1..64 前缀 | 无分桶、无稳定排序（`:54` 直接遍历） |
| 等待 >3 分钟优先最老桶（防饥饿） | 未实现 |
| 输出预估 = 256 + n×单条，再 ×1.25 | 无 256 基值；单条 `max(128, observed×1.5)`，系数与计划不符 |
| 观测窗口 7 天 / 最多 50 次 / 供应商+模型+抽取版本+批次区间四维隔离 | 仅 `.slice(-20)` |
| ≥5 条真实 usage 后 P90×1.2 校准输入估计 | 未实现 |
| 预测耗时 = 首内容 P80 + 输出量/生成速度 P20，缺省 90s | 未实现 |
| 合法完成率 = (合法+2)/(有效+3) | 现为 EMA |
| 选择 = 新闻数×完成率/(等待＋请求耗时) | 现为 `latency/validRate×(1+active/capacity)` |
| 最近成功批量 +25% 硬封顶 | 增长因子 0.5–2（可达 +100%） |
| 每 10 次成功探测最久未服务健康模型 | 未实现（仅做容量 +1） |
| 字符上限 240000 | 规划器硬编码 **220000**，与 `ai-chat-client.ts` 的 240000 不一致 |
| 发送参数与计划一致 | 部分：有 `min(outputTokenBudget, …)` 封顶与下限，但发送值取模型配置 max，不等于计划估计 |

## M4 · 部分完成（~30%）

- 已有：`isPublished` 字段；`RecommendationSnapshot` 的日报 / Dashboard 读取已硬过滤；迁移 `20260908000002_pipeline_consistency` 按 `status=SUCCESS` 回填发布。
- **未完成**
  1. 无独立发布记录实体（仅布尔位翻转，无版本/审计）。
  2. `COMPLETE_EMPTY` 全仓零命中；"证据存在但候选全被过滤"无状态与原因记录。
  3. 后处理未拆分且发布语义相反：主题对账 / 关键词惩罚 / 自提升建议仍内联在每日入口，策略实验仍内联在 `backtest-engine.ts`；`completeRunTrace` 位于全部后处理之后 → 后处理失败会阻断发布（计划要求"对账失败不能撤销已完成的发布"）。
  4. 四条未发布数据泄漏路径仍在：`contribution-reader.ts`（`/api/batches/contribution` 任意 traceId 无过滤）、`routes.ts` trace overview/steps/events 无发布过滤、`runtime-data-operations.ts` 执行历史展示当日 FAILED/未发布 trace、策略推荐事件（`StrategyRecommendationEvent` 表无 `isPublished`，仅 trace 级软门控）。
  5. 旧数据迁移仅按 trace 状态回填，无完整性校验。

## M5 · 未开始（~15%），且**未来数据泄漏仍在**

- ⚠️ `scoring-contribution-engine.ts` 行情读取（~1271/1451/1982）**无 `dailyCloseVisibleAt` 守卫** → 盘中运行会把当日未收盘的完整日线纳入评分特征。
- ⚠️ `backtest-engine.ts` 的 `marginAfter` 仍可回退到 `now`（已新增 `dailyCloseVisibleAt` 过滤 visibleCandles，仅缓解）。
- 未开始：统一市场数据读取接口（asOf + 数据集版本 + 业务时间 ∧ 可信可见时间双检）、数据修订版本固定与恢复、交易日历版本化（仍硬编码 2024–2025 假期，"非周末非假期即交易日"，缺年份不返回数据缺口）、Candle 契约（缺 tradingStatus/涨跌停/复权口径/corporateAction/可见时间）、JSONL 版本化导入校验、前复权口径校验开关、股票历史状态（isST/上市退市/行业历史）、收益元数据（status/plannedExitDay/actualExitDay/maturityAt/computeVersion）。

## M6 · 未开始（~20%）

- 无 `baseline-v1` / `event-v2` 常量与开关（生产默认即现行引擎，未显式标注基线）。
- 事件证据模型整体缺失：无"转载组+规范关键词+经营变量"事件键、无同（事件/股票/关键词/极性）取最大贡献、无 `1−∏(1−q)` 最强 3 独立事件聚合、无 E+/E−/E 净证据分离（仍为 `1−exp(−x/1.8)` + 多样性奖励）。
- 权重网格 `{45,50,55,60}` / `{0,5,10}` / `{15,20,25}` / 市场 20–35 全为硬编码。
- 平滑惩罚未实现：无 `p0`、20 日半衰期、责任权重分配、`p=(L+20p0)/(n+20)`、`n<5→1`，无三配置比较框架；现行惩罚仍硬编码 `factor=0.6 / cooldown=7 / threshold=-0.03 / lookback=30`。
- 遍历顺序依赖：`deduplicateContributions` 已改取最大贡献、`loadActiveKeywordPerformancePenalties` 已改取更强惩罚（平手仍保留先到者）；**`createExposureContributions` 的 `seen` 去重仍只取首个 exposure**，未实现"多重匹配取最高有效匹配"。
- 已符合：归一化加权总分 0–100、质量门槛比较原始特征、证据<10 且图谱≥12 等价门槛、暴露<4、行业动量惩罚、市场宽度、平手按股票代码。

## M7 · 未开始（~5%）

- 无滚动窗口（`trainWindow`/`rolling`/`walkForward`/`outOfSample` 零命中）；120/20/20 划分、间隔 5 日、测试窗口前移 20 日均未实现。
- 无统计算法（`blockBootstrap`/`confidenceInterval` 零命中）；上线门槛（≥60 测试交易日、≥200 有效成交、块长 10 日 ×2000 次 × 固定种子、95% CI 下界 >0、回撤与最差 5% 日收益不劣于基线）全未实现。
- 无交易成本模型（`slippage`/`basisPoints`/`corporateAction` 零命中）；无实验独立命名空间（`namespace` 零命中）。
- 无批次性能基准（固定新闻快照 + 固定模拟供应商 + 随机种子，对比固定 3 条/当前算法/新算法，报告覆盖率/耗时/请求数/Token/重试量）；现有 `ai-batch-planner.test.ts` 仅 6 用例。
- 集成测试未使用独立测试库/Schema（`AI_TEST_DATABASE_URL` 零命中，默认 `schema=public`）→ 17 个跳过用例无法计入通过；无 skip 单列报告机制；无 HTTP 发布筛选专门集成验证。

## 待开发项汇总（按执行顺序）

### 立即（当前中间态收尾，否则现有改动无法交接）
- **A1 ✅ 已完成**：mock 回归已修，套件 401 通过 / 0 失败。
- **A2** M0 范围重定义：把 `version.ts` 常量接入 `pipeline-utils`（traceId）、`causal-signal-extraction-service`（缓存键）、`scoring-contribution-engine` / `temp-stock-recommendation-service`（配置读取），并补消费方测试。
- **A3** 实现 `PipelineStage<I,O>` 接口 + 14 阶段依赖表；统一七态枚举；合并两套租约并引入递增代次。
- **A4** 运行键加入 `recipeVersion` + `businessConfigHash`；补 `--recompute-from` / `--source-trace-id`，扩展 `--stop-after` 到全部阶段。
- **A5** 因果响应协议对齐 `{items:[{newsId,status,signals}]}`，并让 `CAUSAL_PROTOCOL_VERSION_ITEMS` 真正生效。
- **A6** `pipeline-consistency.integration.test.ts` 5 个用例当前全 skip，需在真实测试库跑通。

### 短期（M4 之前，可靠续跑是首个可上线价值点）
- B1 建立发布记录实体，替换 `isPublished` 布尔位。
- B2 堵住 4 条未发布数据泄漏读取路径。
- B3 实现 `COMPLETE_EMPTY` 与"候选全过滤"分支。
- B4 后处理从每日入口与 `BacktestEngine` 拆出，发布提交前移，保证对账失败不撤销发布。
- B5 旧版本 trace 兼容执行器（保留其成功批次与预算）；下游恢复按实际产物判完整性。

### 中期（数据与算法正确性；M5 是 M7 的前置）
- C1 修 `scoring-contribution-engine.ts` 三处盘中未来数据泄漏；`backtest-engine` 的 `marginAfter` 去掉 `now` 回退。
- C2 版本化交易日历（开闭市、来源、数据缺口）。
- C3 行情数据契约扩展 + JSONL 版本化导入 + 前复权口径校验开关。
- C4 股票历史状态（ST/上市退市/行业）建模；收益元数据字段补齐。
- C5 M6 事件证据模型 + `baseline-v1`/`event-v2` 开关 + 权重网格 + 平滑惩罚 + 消除 `createExposureContributions` 的遍历顺序依赖。

### 后期（M3 规划器 + 验收与切换）
- D1 `ai-batch-planner` 12 项算法要求（分桶/排序/前缀枚举/防饥饿/预估公式/观测窗口/耗时预测/完成率/选择公式/25% 封顶/健康模型探测/240000 上限对齐）。
- D2 批次性能基准（固定快照 + 模拟供应商 + 种子）。
- D3 滚动实验框架 + 分块 Bootstrap + 上线门槛判定。
- D4 集成测试独立库/Schema；skip 单列；HTTP 发布筛选集成验证 + Dashboard/推荐历史页面验证。
- D5 迁移演练与部署脚本（启动前检查已有进程；按开发包提交后部署同一提交到 VPS）。

## 验收时不可跳过

- `bun run check:fix` = typecheck + **oxlint** + vitest（lint 命令存在，不能报告不存在的检查已通过）。
- 计划要求的"PostgreSQL 集成测试用独立库/Schema""skip 单列不计通过""HTTP 发布筛选集成验证""Dashboard 与推荐历史页面验证"目前**均无对应产物**。
- 始终保留的硬约束（新闻失败停止、LLM 不降级、证据为空停止、严格时间边界、选股硬限制）现状保留，但 M5 泄漏说明"严格时间边界"在评分路径上并未真正成立。
