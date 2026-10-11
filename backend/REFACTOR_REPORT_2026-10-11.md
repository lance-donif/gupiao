# 后端系统性重构报告（2026-10-11）

范围：`backend/src` 全模块。目标：DRY/SOLID、性能、行为等价。

## 验证结果

| 检查 | 重构前基线 | 重构后 |
|------|-----------|--------|
| `bun run typecheck` | ✅ 0 错误 | ✅ 0 错误 |
| `bun run test` | 566 通过 / 0 失败 / 76 跳过 | **566 通过 / 0 失败 / 76 跳过（完全一致）** |
| `bun run lint` | 4 警告 / 0 错误 | 4 警告 / 0 错误（存量，0 新增） |
| `bun run check:deps` (knip) | ❌ 21 导出 + 10 类型未使用 | ✅ 仅剩 2 个有意保留的 enum 成员 |
| 对外接口（API/路由/契约/错误码/日志格式） | — | 无任何变更 |

净变化：**25 个文件改动，+77 / −1142 行**（新增 3 个共享模块）。

## 改动明细（按原则归类）

### DRY（消除重复）

1. **`src/services/scoring/exposure-rank.ts`（新增，单一真源）**
   `stockInfoExposureSources` 白名单 + `stockInfoExposureRank` 排名函数在
   `temp-stock-recommendation-service.ts` 与 `strategy-runner.ts` 中逐字重复 43 行 ×2，现收敛为一个模块，两处改为导入。
2. **`src/services/scoring/contribution-signal-loader.ts`（新增）**
   两份近似重复的 `loadContributionSignals`（EvidenceContribution 按 keyword 聚合、分数降序+keyword 升序）统一为 `loadContributionSignalMap` 纯函数。
3. **北京日键统一**：`pipeline-utils.ts` 与 `tavily-news-provider.ts` 各有一份 `Intl` 格式化副本，统一委托 `lib/beijing-time.ts` 的 `toBeijingDayKey`；`getBeijingDateKey` 导出名保留（兼容）。

### SRP / 依赖解耦

4. **`src/services/scoring/market-signal-score.ts`（新增）**
   215 行的 `calculateMarketSignalScore` 及 `IMarketSignalScore` 接口从 1931 行的评分引擎中迁出为独立模块；`strategy-runner.ts` 不再为取这一个函数而依赖整个 `scoring-contribution-engine.ts`。原路径 re-export 保持兼容。
   ⚠️ 注意：函数内 reasons 文案即契约（temp 服务用正则反解析），已逐字符保持不变。

### 性能

5. **`sortByStableJson`**（limitup-evidence-initialization.ts）：排序比较器内 O(n log n) 次 `JSON.stringify` → Schwartzian transform 每行预计算一次键，结果一致。
6. **`getMarketSignalNumber/String/Boolean`**（temp service）：质量门槛对同一 recommendation 反复 `JSON.parse(marketSignal)` → `WeakMap` 记忆化，每对象只解析一次。
7. **`recordExtractionCache`**（causal-signal-extraction-service.ts）：循环内逐条 `await` ledger 写入且每轮 `filter`（O(n²)）→ 预按 newsId 分组（O(n)）+ `Promise.all` 并行写入（各 bucketKey 互异、upsert 幂等，语义不变）。

### 死代码清除（knip 驱动，全部经 grep 复核 0 引用）

- 函数/类：`createBackendRuntimeStore`、`buildDeleteClusterGraphCypher`、`FriendNetworkAgeGraphReadClient`、`PgAgeGraphClient`、`isCausalExtractionStageComplete`、`readAiWorkflowStatus`、`aiRequestTooLargeMessage`、`__privateAkToolsStockExposure`、`requireEnvironmentValue`、`invalidateKeywordDictionary`、`CoverageGapLoopService`、`CoverageLoopReportService`、`resolveStockStatusBatch`、`toNewsItems`、`buildRunKey`、`backfillPublish`、`getPublishedTraceIds`、`hasExplicitRuntimeBoundary`、`createServiceExecutionContext`、`isDateInsideRuntimeWindow`、`createServiceRuntimeContext`、`createServiceIdempotencyBoundary`、`toSourceFailure`，及仅被上述使用的私有辅助（`nextUtcDate`、`startOfUtcDate`、`ensureValidTimeWindow`、`formatTimeWindow`、`normalizeAgtypeScalar`、`average`）。
- 类型：`contracts.ts` 整段 stock/news source 死类型（`INewsSource`、`IStockSource`、`IStockSourceRequest/Quote`、`ISourceSuccessResult/FailureResult` 等）、`prisma-types.ts` 中 5 个 delegate/record 接口（保留其余测试在用的接口）、`service-types.ts`/`news-ingest-types.ts`/`stock-exposure-types.ts`/`rolling-walk-forward.ts` 的孤儿接口。

### 有意保留（非疏漏）

- `SourceFailureCategory.RateLimited/BadPayload` 两个 enum 成员：属于错误分类契约的值域，删除有远程数据映射风险，收益为零。
- `prisma-types.ts` 其余接口被集成测试引用，保留。

### 正确性标注（唯一一处行为变化，单独说明）

8. **`strategy-runner.ts` 补 asOf 可见性守卫**：两处 `candle.findMany` 此前只校验 `tradingDay <= asOf`，未校验可见时间；项目硬性规则要求经 `isCandleVisibleAsOf` 双重守卫（`scoring/market-signal-loader.ts`、`temp-stock-recommendation-service.ts` 均已如此）。已补齐。**理由**：消除 asOf 盘中/未来数据泄漏；**影响**：仅当存在 `visibleAt > asOf` 但 `tradingDay <= asOf` 的 K 线时结果不同——这本来就是规则要求排除的数据；现有 566 测试全绿说明常规数据不受影响。若不接受此修复，删除两处 `isCandleVisibleAsOf` 守卫即可回退。
9. **`loadContributionSignalMap` 归一**：原 temp 版用裸 `Number(row.finalContribScore)`，strategy 版用 `toNumber()`（NaN→0）。统一为 `toNumber`。仅影响 finalContribScore 为 NaN 的脏数据场景。

## 权衡取舍

- **backtest-engine.ts（1067 行）与 runtime-data-operations.ts（3792 行）未做深度拆分**：runBacktest 的 4 个 checkpoint 复用段结构差异大，强行抽取公共模板需要改写大量稠密代码，回归风险与收益不成比例；建议后续以「阶段执行器」模式分阶段迁移（项目已有 `PIPELINE_STAGE_EXECUTOR=registry` 基础设施）。
- **「评分组件」正则反解析的隐性耦合**（temp service 依赖 scoring reasons 文案）：本次仅通过迁移收敛文案为单一真源；彻底方案是 scoreBreakdown 增加结构化字段（涉及数据契约，需单独评审）。
- **knip 完全转绿**差最后 2 个 enum 成员：见上「有意保留」。

## 需要补充的回归测试点（证明行为等价 / 锁定修复）

1. `loadContributionSignalMap`：聚合、排序、`matchedExposureKeyword ?? keyword` 回退、NaN→0 归一（两调用方各 1 例）。
2. `stockInfoExposureRank`：SW1/2/3 分层、`movement_evidence` 排除、未知来源 −1。
3. 北京日键：`toBeijingDayKey` 在 UTC 15:59/16:01 边界（北京时间日切）两侧的取值。
4. `recordExtractionCache`：多新闻并行写入后 ledger 行数与 summary 内容；同 newsId 幂等。
5. `sortByStableJson`：等价元素的原顺序稳定性（Array.prototype.sort 稳定性依赖）。
6. **asOf 守卫**（新增行为）：构造 `visibleAt = asOf+1h`、`tradingDay <= asOf` 的 K 线，断言 strategy-runner 的市场信号不使用该 K 线。
7. market-signal-score 迁移等价：对同一 candle 集在旧实现（git 历史）与新模块上做快照对比。
