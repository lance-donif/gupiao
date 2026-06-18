# Tasks

- [x] Task 1: 清理后端未使用依赖
  - [x] SubTask 1.1: 从 `backend/package.json` 移除 `playwright`、`cheerio`、`yahoo-finance2`、`tsx`、`dotenv`
  - [x] SubTask 1.2: 运行 `cd backend && bun install` 更新 lockfile
  - [x] SubTask 1.3: 运行 `cd backend && bun run typecheck` 确认无类型错误

- [x] Task 2: 重写新闻源解析，移除 cheerio
  - [x] SubTask 2.1: 读取 `backend/src/services/public-news-source-orchestrator.ts` 当前实现
  - [x] SubTask 2.2: 用 `fetch` + 字符串/正则替换 `cheerio.load` 的 HTML 去标签和 RSS 解析逻辑
  - [x] SubTask 2.3: 运行相关单元测试或通过临时脚本验证解析输出不变

- [x] Task 3: 重写 NewsNow 抓取，移除 playwright
  - [x] SubTask 3.1: 读取 `backend/scripts/fetch-newsnow.ts` 当前实现
  - [x] SubTask 3.2: 用 `fetch` 替换 `chromium.launch()` 流程
  - [x] SubTask 3.3: 运行脚本验证能拿到预期内容

- [x] Task 4: 删除废弃脚本和调试产物
  - [x] SubTask 4.1: 删除 `backend/scripts/build-friend-network*.ts`
  - [x] SubTask 4.2: 删除 `backend/scripts/replay.ts`
  - [x] SubTask 4.3: 删除 `scripts/analyze_complexity.py` 和 `scripts/generate_*.py`
  - [x] SubTask 4.4: 删除 `.playwright-cli/` 下 YAML 快照
  - [x] SubTask 4.5: 更新 `backend/tsconfig.json` 移除已删除脚本的 include

- [x] Task 5: 合并后端重复工具函数
  - [x] SubTask 5.1: 新建/复用 `backend/src/lib/number-utils.ts` 统一 `toNumber`/`clamp`
  - [x] SubTask 5.2: 新建/复用 `backend/src/lib/hash-utils.ts` 统一 `hashJson`/`stableHash`
  - [x] SubTask 5.3: 新建/复用 `backend/src/lib/date-utils.ts` 统一 `dateKey`/`toIsoText`
  - [x] SubTask 5.4: 新建/复用 `backend/src/lib/url-utils.ts` 统一 `normalizeBaseUrl`/`toNonEmptyString`
  - [x] SubTask 5.5: 新建/复用 `backend/src/lib/openai-utils.ts` 统一 `extractJsonObject`
  - [x] SubTask 5.6: 替换所有服务中的本地实现并运行 `bun run typecheck`

- [x] Task 6: 清理前端死代码与未使用依赖
  - [x] SubTask 6.1: 从 `web/package.json` 移除 `@playwright/test`、`markdownlint-cli2`、`autoprefixer`、`postcss-html`、`tw-animate-css`
  - [x] SubTask 6.2: 删除 `web/tailwind.config.cjs`、`web/playwright.config.ts`、`web/tests/setup.ts`
  - [x] SubTask 6.3: 清理 `web/src/lib/api-types.ts` 未使用类型
  - [x] SubTask 6.4: 清理 `web/src/lib/api.ts` 未使用方法
  - [x] SubTask 6.5: 运行 `cd web && bun install && bun run typecheck`（或等价命令）

- [x] Task 7: 修复 Makefile/docker/配置引用
  - [x] SubTask 7.1: 修复 `Makefile` 中 `lint-web`/`complexity-web`/`format-backend` 的无效目标
  - [x] SubTask 7.2: 修复 `scripts/release_gate_ci_light.sh` 使用 `bun` 替代 `pnpm`
  - [x] SubTask 7.3: 修复 `docker-compose.yml` scheduler 指向不存在的 `run-mvp-daily-scheduler.js`
  - [x] SubTask 7.4: 清理 `.env.example` 中无读取点的变量

- [x] Task 8: 后端格式与类型检查
  - [x] SubTask 8.1: 运行 `cd backend && bun run check:fix`
  - [x] SubTask 8.2: 运行 `cd backend && bun run typecheck`
  - [x] SubTask 8.3: 运行 `cd backend && bun test`

- [x] Task 9: 跑一轮 2026-06-18 今日推荐
  - [x] SubTask 9.1: 确认基础设施（PostgreSQL/Redis/AGE）已启动
  - [x] SubTask 9.2: 运行 `cd backend && bun run run-daily-recommendation --asOf 2026-06-18`
  - [x] SubTask 9.3: 验证数据库中存在 `asOf=2026-06-18` 的 `RecommendationSnapshot`

# Task Dependencies
- Task 2 依赖 Task 1
- Task 3 依赖 Task 1
- Task 5 依赖 Task 1
- Task 8 依赖 Task 2、Task 3、Task 5
- Task 9 依赖 Task 8
