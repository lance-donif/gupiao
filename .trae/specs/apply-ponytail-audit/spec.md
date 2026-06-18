# 应用 ponytail-audit 削减过度工程 Spec

## Why

ponytail-audit 扫描出约 100 项可删除/简化项，覆盖后端依赖、重复代码、前端死代码、废弃脚本和配置。本次只处理**低风险、高收益**的子集，清理后立即跑一轮今日推荐验证系统仍正常工作。

## What Changes

- **删除未使用的后端依赖**：`playwright`、`cheerio`、`yahoo-finance2`、`tsx`、`dotenv`
- **删除未使用的前端依赖与配置**：`@playwright/test`、`markdownlint-cli2`、`autoprefixer`、`postcss-html`、`tw-animate-css`、`web/tailwind.config.cjs`、`web/playwright.config.ts`、`web/tests/setup.ts`
- **删除废弃脚本**：`backend/scripts/build-friend-network*.ts`、`backend/scripts/replay.ts`
- **删除废弃 Python 脚本**：`scripts/analyze_complexity.py`、`scripts/generate_*.py`
- **清理 `.env.example` 中无代码读取的环境变量**
- **清理 `.playwright-cli/` 调试产物**
- **合并后端重复工具函数**：`toNumber`、`clamp`、`normalizeBaseUrl`、`toNonEmptyString`、`extractJsonObject`、`hashJson`、`stableHash`、`dateKey`、`toNumberOrNull`、`toIsoText`
- **删除/合并前端死代码**：`api-types.ts` 未用类型、`api.ts` 未用方法、`useBatchProgress`、`startPerceivedInteraction`
- **修复 Makefile/scripts 中过时的 `pnpm`/`lint` 命令引用**
- **修复 docker-compose.yml 和 backend/tsconfig.json 中指向已删除脚本的引用**
- **BREAKING**：删除 `playwright`/`cheerio` 后，`fetch-newsnow.ts` 和 `public-news-source-orchestrator.ts` 需用 `fetch`/正则重写

## Impact

- Affected specs：新闻抓取、行情/暴露源解析、前端 Dashboard/Strategies、每日推荐流水线
- Affected code：
  - `backend/package.json`
  - `backend/scripts/fetch-newsnow.ts`
  - `backend/scripts/build-friend-network*.ts`
  - `backend/scripts/replay.ts`
  - `backend/src/services/public-news-source-orchestrator.ts`
  - `backend/src/services/*`（重复工具函数）
  - `web/package.json`
  - `web/src/lib/api-types.ts`
  - `web/src/lib/api.ts`
  - `web/tailwind.config.cjs`
  - `web/playwright.config.ts`
  - `web/tests/setup.ts`
  - `scripts/*.py`
  - `.env.example`
  - `.playwright-cli/`
  - `Makefile`
  - `docker-compose.yml`
  - `backend/tsconfig.json`

## ADDED Requirements

### Requirement: 依赖清理后系统仍能跑通今日推荐

The system SHALL 在删除上述依赖和脚本后，成功执行一轮 `2026-06-18` 的每日推荐，并生成 `RecommendationSnapshot`。

#### Scenario: 成功执行今日推荐

- **WHEN** 运行 `cd backend && bun run run-daily-recommendation --asOf 2026-06-18`
- **THEN** 流程完成且无未处理异常
- **AND** 数据库中存在 `asOf=2026-06-18` 的推荐快照

## MODIFIED Requirements

### Requirement: 新闻源解析不再依赖 cheerio

`public-news-source-orchestrator.ts` 原先使用 `cheerio` 解析 RSS/XML/HTML，修改后 SHALL 仅使用 Bun 原生的 `fetch` 和字符串/正则操作完成等效解析。

### Requirement: NewsNow 抓取不再依赖 playwright

`fetch-newsnow.ts` 原先使用 `playwright` 启动浏览器，修改后 SHALL 仅使用 HTTP `fetch` 获取 NewsNow 内容。

### Requirement: 工具函数去重

后端 SHALL 提供统一的 `number-utils.ts`、`hash-utils.ts`、`date-utils.ts`、`url-utils.ts`、`openai-utils.ts`，所有服务从中导入，不再各自实现 `toNumber`、`clamp`、`normalizeBaseUrl`、`toNonEmptyString`、`extractJsonObject`、`hashJson`、`stableHash`、`dateKey` 等。

## REMOVED Requirements

### Requirement: playwright 浏览器抓取

**Reason**：NewsNow 可通过 HTTP fetch 访问，playwright 引入数百 MB 依赖且仅在调试脚本使用。
**Migration**：`fetch-newsnow.ts` 改为 fetch 实现。

### Requirement: cheerio HTML/XML 解析

**Reason**：本项目解析场景简单，Bun 原生 fetch + 字符串处理足够。
**Migration**：`public-news-source-orchestrator.ts` 改为原生解析。

### Requirement: yahoo-finance2 行情获取

**Reason**：`scripts/sync-stocks.ts` 中 `fetchYahooBatchQuotes` 是唯一调用点，可改用直接 HTTP fetch 或 AKTools。
**Migration**：按需用 `fetch` 替换或直接删除该函数。
