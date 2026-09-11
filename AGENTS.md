## Project Context
股票预测系统：新闻聚合 + 因果关键词网络 + 行情确认，生成可解释推荐。

当前主线：

- 今日推荐：新闻 -> LLM 因果抽取 -> Evidence -> 图谱/行情评分 -> Snapshot。
- 历史回测：严格按 `asOf` 时间边界重放。
- 自选股：关键词关系网络分析。
- 前端页：Dashboard、Strategies、Trace、RecommendationHistory。

## Work Style

- 回复尽量短，先说结论。
- 开始较大任务前，先看哪些 Skill 能用。
- 后端改动后优先跑 `cd backend && bun run check:fix`。
- 不要回滚用户已有改动，除非用户明确要求。
- 运行服务前需要看看有没有已经在运行的服务，避免重复运行。
## Architecture

```text
gupiao/
├── backend/  # TypeScript 后端，HTTP shell + OOP 服务/算法层
├── web/      # React 19 + Vite + TypeScript 前端
└── data/     # 本地数据存储
```

后端重点目录：

- `backend/src/services/`：业务服务和流水线
- `backend/src/http/`：本地 HTTP shell
- `backend/src/repositories/`：仓储层（当前仅 `News`/`Stock`/`FriendNetworkGraph`/覆盖率初始化走仓储；其余领域表由 service 直连 Prisma，为已知现状）
- 算法散落于：`backend/src/services/scoring/`（评分）、`services/event-scoring/`（事件惩罚）、`services/market-data/`（行情读取）、`services/friend-network-*`（图谱）、`services/backtest-engine.ts`（series 回测）
- `backend/prisma/schema.prisma`：数据库模型
- `backend/scripts/run-daily-recommendation.ts`：每日推荐主入口

前端重点目录：

- `web/src/pages/`：页面
- `web/src/features/`：功能模块
- `web/src/components/ui/`：通用 UI
- `web/src/lib/api.ts`：接口调用

## Core Rules

- 但凡用到 LLM，不允许降级处理；LLM 报错、超时、返回非法结构时直接抛错并停止流程。
- LLM 请求前必须检查 prompt/body 长度，最大 `240000` 字符。
- AI 第一阶段只做结构化抽取 `CausalSignalCandidate`，不直接推荐股票，不直接给股票加分。
- 新闻失败、LLM 失败、`EvidenceContribution` 为空，都必须停止后续推荐。
- 推荐不得用无 `EvidenceContribution` 的股票补位。
- 直接股票名新闻只能作为 `directMentionContext`，不能绕过因果关键词到暴露事实链路。
- 所有推荐和回测必须遵守时间边界，不能读取 `asOf` 之后的数据。

## Recommendation Pipeline

每日推荐主链路（调度顺序：`sync-stock-history --mode incremental` → `backfill-yield-records` → `run-daily-recommendation`）：

0. 收益对账：`backfill-yield-records` 回填未对账快照的 1/3/5 日收益并置 `isReconciled`，惩罚只读快照表，不读 `YieldRecord`。
1. 抓取新闻：AKTools + NewsNow
2. 清洗、去重、转载降权
3. LLM 因果抽取：生成 `CausalSignalCandidate`
4. 图谱快照：生成关键词关系网络
5. 刷新关键词表现惩罚：`KeywordPerformancePenalty`
6. 评分：`ScoringContributionEngine`
7. 生成推荐：`RecommendationSnapshot`
8. 多策略实验：`StrategyExperimentRunner`

关键表：

- `RawNewsRecord` / `NormalizedNewsRecord`
- `CausalSignalCandidate`
- `EvidenceContribution`
- `GraphSnapshot`
- `StockFeatureSnapshot`
- `MarketSignalSnapshot`
- `RecommendationSnapshot`
- `KeywordPerformancePenalty`

## Recommendation Rules

- 默认推荐目标为 30 只。
- 排除 `688` 开头股票。
- 排除 `ST/*ST` 股票。
- 排除最近 5 个可见交易日涨幅超过 20% 的股票。
- 排除收盘价超过 40 元的股票。
- 今天推荐过的股票，明天不能再推荐。
- 今天推荐用过的关键词，明天不能再推荐。
- 推荐不足 30 时输出原因，不硬凑。
- 推荐生成前会执行质量门槛：过滤行情快照过期、弱证据靠图谱补分、暴露过宽、过热追涨、无量弱反弹的候选。

关键词表现惩罚：

- 每天生成推荐前执行。
- 读取已对账的 `RecommendationSnapshot`。
- 如果推荐股票任一可用收益 `yield1Day/yield3Day/yield5Day <= -3%`，惩罚该股票当时命中的关键词。
- 惩罚系数默认 `0.6`。
- 惩罚有效期默认 7 天。
- 评分时在 `finalContribScore` 上乘惩罚系数，并写入 reasons。

## Scoring

推荐分数使用 0-100：

- 证据贡献：45
- 图谱弱信号：20
- 暴露精确度：15
- 市场确认信号：20

市场确认信号只能读取 `tradingDay <= asOf` 的 `Candle`，包括 5/20 日涨跌、成交量放大、波动压缩/突破。

质量治理执行时机：

- `ScoringContributionEngine.execute()` 执行评分时生效：统一 `45/20/15/20` 权重、限制单关键词证据刷分、计算市场信号。
- 评分时会检查 `MarketSignalSnapshot` 是否落后于 asOf 前最新 Candle；过期则重算并更新当前 trace 的市场快照。
- `TempStockRecommendationService.generatePhysicalRecommendations*()` 生成 `RecommendationSnapshot` 前生效：只从有 `EvidenceContribution` 且通过质量门槛的候选里选股。
- 这些规则只影响之后新跑的推荐/回测评分；不会自动改历史 `RecommendationSnapshot`。

`RecommendationSnapshot.scoreBreakdown` 需要能追溯到 `contributionId/newsId/exposureFactId/marketSignal`。

## Commands

后端：

```bash
cd backend && PORT=8000 HOST=127.0.0.1 bun run dev:http
cd backend && bun run build
cd backend && bun run test
cd backend && bun run typecheck
cd backend && bun run lint
cd backend && bun run check:fix
cd backend && bun run scripts/audit-recommendation-quality.ts --date 2026-06-29
cd backend && bun run scripts/audit-recommendation-quality.ts --trace-id <traceId>
```

注意：后端测试运行器是 **Vitest**（`bun run test` = `vitest run`）。`bun test` 是 Bun 原生运行器，无法识别用例，禁止使用。`check:fix` = typecheck + lint(`oxlint src scripts`) + test，三个独立命令都存在。

前端：

```bash
cd web && bun run dev
cd web && bun run build  # 内含 tsc --noEmit
cd web && bun run test   # vitest run，禁止 bun test
cd web && bun run check:all  # 仅 lint:style + check:deps，不含 typecheck/test
```

注意：web 没有 `lint` 脚本，不要跑 `bun run lint`。

基础设施：

```bash
docker compose up -d
docker compose down
```

## Tech Stack

- Backend：TypeScript 6, Bun 1.3, Prisma 7, Vitest 4
- Frontend：React 19, Vite 8, TypeScript 6, Radix UI, ECharts, AntV G6
- Database：PostgreSQL, Redis, Apache AGE 图扩展
- AI：自研客户端直调模型 provider（`backend/src/services/ai-transport.ts`、`ai-chat-client.ts`），无 LangChain 依赖

## Testing

- 单元测试：纯逻辑，无外部依赖。
- 集成测试：真实外部服务，必须明确依赖。
- 后端测试用 `bun run test`（Vitest）；当前基线 535 通过 / 0 失败 / 75 跳过（81 文件：76 通过、5 跳过），2026-09-11 实测（无 `AI_TEST_DATABASE_URL` 时集成测试跳过）。
- 前端变更：需要浏览器页面验证。
- 后端交接：禁止带 lint error；跳过的测试必须单列，不得计为通过。

## Rewrite Status

- M0–M7 开发已落地，完成情况见 `M0_M7_COMPLETION_REPORT_2026-09-10.md`。
- 生产默认：`SCORING_RECIPE=event-v2`、`PIPELINE_STAGE_EXECUTOR=registry`、`CAUSAL_PROTOCOL_MODE=items`。
- 验收基线：`cd backend && bun run check:fix` 全绿；带 `AI_TEST_DATABASE_URL` 时 80 文件 / 605 用例全部通过（0 跳过）；后端与前端构建通过。
- 评测门槛是"报告"而非"开关"：M7 报告会输出 bootstrap 置信区间与回撤对比，未达门槛时标记 `overrideForced=true` 并保留 `event-v2`。

## Frontend Layout Rules

- 严禁对包含动态内容的容器卡片硬编码固定高度（如 `h-[150px]`、`h-[174px]`）。这类卡片必须使用弹性高度或自适应高度（如 `h-auto`、`min-h-[xxxpx]`）。
- 工作台堆叠布局规范：若侧边栏或主栏底部组件为带滚动条的弹性区域（如带有 `ScrollArea` 且设为 `flex-1 min-h-0`），则其上方所有普通卡片组件必须设为 `h-auto shrink-0` 弹性高度，使其根据内容自动撑开，严禁设死固定高度。
- 动态文本应具备折行容错性。如果对行数有限制，请显式采用 `line-clamp-x` 或 `truncate` 进行防御性限高截断，避免超出父容器边界。


