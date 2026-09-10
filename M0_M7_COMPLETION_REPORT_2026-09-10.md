# M0–M7 推荐链路重写 · 完成报告（2026-09-10）

对象：当前工作区 + VPS（`110.42.34.12:/opt/gupiao`）。
结论：M0–M7 开发与验收均可执行，生产已切换 `SCORING_RECIPE=event-v2`、`PIPELINE_STAGE_EXECUTOR=registry`、`CAUSAL_PROTOCOL_MODE=items`，并完成一轮真实推荐。

## 交付内容

| 包 | 状态 | 关键实现 |
|---|---|---|
| M0 | 完成 | `version.ts` 常量进入 `createTraceId`/`buildRunKey`；`DEFAULT_BUSINESS_CONFIG` + `businessConfigHashSync`；14 阶段 ID + 七态状态机 |
| M1 | 完成 | `pipeline/stage-executor.ts`、`registry-pipeline.ts`（14 阶段适配器）、`RunArtifact/RunArtifactShard`、`RunLease` 独立表 + generation 租约；`--stop-after <StageId>`、`--recompute-from --source-trace-id` |
| M2 | 完成 | v3 逐条协议默认启用；`ContentCacheEntry` 跨日复用 + 并发领取租约；旧版本 trace 兼容执行器保留成功批次与预算 |
| M3 | 完成 | 批次规划器（分桶/稳定排序/防饥饿/观测窗/健康探测/240000 上限）+ `scripts/run-batch-benchmark.ts` 固定快照基准 |
| M4 | 完成 | `RecommendationPublish` 为唯一发布真源（`isPublished` 仅兼容位）；发布幂等；正式读路径全部按未取代发布记录过滤；`COMPLETE_EMPTY` 显式状态；后处理移到发布之后 |
| M5 | 完成 | `market-data-reader` 双时间边界（业务时间 ∧ 可见时间）；`MarketDatasetVersion`/`TradingCalendarDay`/`StockStatusHistory`/`YieldRecord`；严格口径准入（`strictDataAdmission`）+ 缺口报告；导入/回填脚本 |
| M6 | 完成 | `event-scoring/`：事件键聚合、top-3 独立事件 `1-∏(1-q)`、`E=max(0,E+-E-)`、暴露最高有效匹配去顺序依赖、平滑惩罚（全局先验 p0，半衰期 20，n<5 不惩罚）；评分与惩罚均接入 event-v2 |
| M7 | 完成 | `experiment/`：120/20/20 滚动窗口 + 5 日隔离 + 测试窗前移 20；分块 Bootstrap（块长 10、2000 次、固定种子）；成本/滑点 5/10/20bp；`run-m7-report.ts` + `export-m7-input.ts`（门槛不达标时输出 `overrideForced=true` 但按用户要求保留 event-v2） |

## 验证结果

- `cd backend && bun run check:fix`：typecheck + oxlint + vitest 全绿。
- 带 `AI_TEST_DATABASE_URL`（远程 `gupiao_test` 经 SSH 隧道）：**80 文件 / 605 用例全部通过，0 跳过**，含 `stage-executor`、`pipeline-consistency`、`m4-publish-isolation`、`m5-market-visibility`、`ai-workflow` 等真实 PostgreSQL 集成测试。
- `cd backend && bun run build`、`cd web && bun run build`：通过。
- 远程部署：`docker compose build migrate api web` → `migrate deploy`（应用 4 个迁移含 `contract_freeze`、`run_lease`）→ `up -d`，`api/web/postgres/redis/aktools` 全部 healthy。
- HTTP 冒烟：`/`、`/api/recommendations`、`/api/report/daily` 均 200，推荐接口返回批次 `batch-daily-global-2026-09-07-...`，状态 `COMPLETED`，30 条推荐。

## 真实推荐运行（用户指定 DeepSeek 配置）

- AI 配置：`deepseek-official/deepseek-flash`，`baseUrl=https://api.deepseek.com`，`reasoning_effort=max`，`max_tokens=380000`，上下文 `1000000`；本地 `.env` 与 VPS `.env` 均写入 `SCORING_RECIPE=event-v2`、`PIPELINE_STAGE_EXECUTOR=registry`、`CAUSAL_PROTOCOL_MODE=items`。
- 运行：`bun scripts/run-daily-recommendation.ts --as-of 2026-09-07T16:00:00+08:00`（最后一次有 Candle 的交易日）。
- 结果：trace `daily-global-2026-09-07-recipe-v1-43b2ed7f3c7bf113-2790da50`，状态 `SUCCESS`；11 个 AI 批次全部由 `deepseek-official/deepseek-flash` 完成；产出 545 个 `CausalSignalCandidate`、2839 条 `EvidenceContribution`、**30 条 `RecommendationSnapshot`**、1 条有效 `RecommendationPublish`。
- 前 5 名：603690 至纯科技、601328 交通银行、002224 三力士、601069 西部黄金、300021 大禹节水；评分理由包含 `事件证据聚合 [...] E+`，证明 event-v2 已生效。

## 数据状态与已知限制

- 生产 Candle 覆盖到 `2026-09-07`（5216 只）；`sync-stock-history.ts --mode incremental` 已在 VPS 后台运行补齐 `09-08 ~ 09-10`，脚本自身报告尚未写入完成。
- 现有 855,961 条 Candle 的 `adjType` 均为空：每日链路以 `marketDataAdmission='permissive'` 记录数据缺口并继续；严格成交回测必须显式 `strictDataAdmission=true`，会拒绝未知/前复权口径。
- `YieldRecord` 只在收益成熟后产生：当前 as-of 为最新交易日，1/3/5 日收益仍为待成熟。
- M7 统计门槛（≥60 测试交易日、≥200 有效成交、95% 置信区间下界 >0）当前数据量不足以证明，报告会输出 `overrideForced=true`；按用户明确要求保留 event-v2。
- `--resume-trace-id` 目前仅 legacy 执行器支持；registry 续跑需要独立的 registry 状态检查点设计。
- registry 运行的 `PipelineStepTrace` 使用阶段 ID 命名，HTTP 批次读取器里按旧名 `scoring_recommendation` 匹配的 `market_cached_done` 标记暂不生效（展示层字段，不影响推荐结果）。
- event-v2 证据组件中 `E-` 当前恒为 0：上游 `createExposureContributions` 仍只保留 `directionWeight > 0` 的信号；聚合函数已支持负向/混合，若要启用扣减需单独调整上游过滤（会改变 baseline 行为）。

## 复现命令

```bash
# 本地全量（含 PG 集成，经 SSH 隧道指向远程 gupiao_test）
cd backend && AI_TEST_DATABASE_URL=postgresql://gupiao:<pw>@127.0.0.1:25432/gupiao_test bun run test
cd backend && bun run check:fix && bun run build
cd web && bun run build

# 远程部署与运行
cd /opt/gupiao && docker compose -f docker-compose.production.yml build migrate api web
cd /opt/gupiao && docker compose -f docker-compose.production.yml run --rm migrate
cd /opt/gupiao && docker compose -f docker-compose.production.yml up -d
docker compose -f docker-compose.production.yml exec -T api bun scripts/run-daily-recommendation.ts --as-of 2026-09-07T16:00:00+08:00
```
