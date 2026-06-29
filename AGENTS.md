## Project Context
使用 codebase-memory-mcp
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
- 运行服务前需要看看有没有已经在运行的服务，避免重复运行
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
- `backend/src/repositories/`：仓储层
- `backend/src/algorithms/`：text、graph、series 算法
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

每日推荐主链路：

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

`RecommendationSnapshot.scoreBreakdown` 需要能追溯到 `contributionId/newsId/exposureFactId/marketSignal`。

## Commands

后端：

```bash
cd backend && PORT=8000 HOST=127.0.0.1 bun run dev:http
cd backend && bun run build
cd backend && bun test
cd backend && bun run typecheck
cd backend && bun run lint
cd backend && bun run check:fix
```

前端：

```bash
cd web && bun run dev
cd web && bun run build
cd web && bun test
cd web && bun run lint
cd web && bun run check:all
```

基础设施：

```bash
docker compose up -d
docker compose down
```

## Tech Stack

- Backend：TypeScript 6, Bun 1.3, Prisma 7, Vitest 4
- Frontend：React 19, Vite 8, TypeScript 6, Radix UI, ECharts, AntV G6
- Database：PostgreSQL, Redis, Apache AGE 图扩展
- AI：LangChain, deepagents

## Testing

- 单元测试：纯逻辑，无外部依赖。
- 集成测试：真实外部服务，必须明确依赖。
- 前端变更：需要浏览器页面验证。
- 后端交接：禁止带 lint error。

## Frontend Layout Rules

- 严禁对包含动态内容的容器卡片硬编码固定高度（如 `h-[150px]`、`h-[174px]`）。这类卡片必须使用弹性高度或自适应高度（如 `h-auto`、`min-h-[xxxpx]`）。
- 工作台堆叠布局规范：若侧边栏或主栏底部组件为带滚动条的弹性区域（如带有 `ScrollArea` 且设为 `flex-1 min-h-0`），则其上方所有普通卡片组件必须设为 `h-auto shrink-0` 弹性高度，使其根据内容自动撑开，严禁设死固定高度。
- 动态文本应具备折行容错性。如果对行数有限制，请显式采用 `line-clamp-x` 或 `truncate` 进行防御性限高截断，避免超出父容器边界。
