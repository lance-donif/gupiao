# 修复推荐流水线 Spec

## Why
今日上午 1911 股上涨，但推荐股票全部下跌。根因排查发现：docker scheduler 无限循环且不同步 Candle；`asOf=Date.now()` 但行情是旧的；市场信号是趋势跟随（追涨）而非目标.md 要求的"发现弱信号/庄家低位吸筹"；预测与推荐耦合，无法独立验证。本 spec 一次性修复全部问题，使推荐行为对齐 `目标.md`。

## What Changes
- **新增调度执行器**：实现 `mvp-daily-scheduler` 的 runner，按北京时点串行执行调度表里的任务，替代 docker 的无限循环。
- **BREAKING** docker-compose scheduler 改为运行调度执行器，不再直接跑 `run-daily-recommendation.js`。
- **BREAKING** `run-daily-recommendation.ts` 默认 `asOf` 改为"北京日 16:00 当日收盘边界"，不再用 `Date.now()`；调度器显式传 `--as-of`。
- **Candle 前置校验**：`run-daily-recommendation.ts` 在 scoring 步骤前校验"最新 Candle 的 tradingDay 是否等于 asOf 北京日"，不等则报错停止（符合 AGENTS.md 严格停止原则）。
- **市场信号重构**：`calculateMarketSignalScore` 的动量分量从"奖励已涨"改为"奖励低位放量吸筹"：价格在 20 日低位区 + 量比放大得高分；纯追涨（已大涨）降权。
- **今日盘中下跌过滤**：`temp-stock-recommendation-service` 新增过滤——若 asOf 当日 Candle 已存在且当日跌幅超过阈值，剔除。
- **预测/推荐分离**：`ThemeForecastService` 产出的预测独立存档（已有 ThemeForecast 表），每日推荐从"未过期预测 + 当日 Candle 验证"重排，而非每次重跑全量因果抽取。

## Impact
- Affected specs: 今日推荐、时间回测、自选股网络分析
- Affected code:
  - `docker-compose.yml`（scheduler 命令）
  - `backend/src/services/mvp-daily-scheduler.ts`（新增 runner）
  - `backend/scripts/run-daily-recommendation.ts`（asOf 默认值、Candle 校验、调度入口）
  - `backend/src/services/scoring-contribution-engine.ts`（市场信号重构）
  - `backend/src/services/temp-stock-recommendation-service.ts`（今日下跌过滤）
  - `backend/src/services/theme-forecast-service.ts`（独立存档+重排）

## ADDED Requirements

### Requirement: 调度执行器按北京时点串行运行
系统 SHALL 提供一个调度执行器，按 `MVP_SCHEDULE_TABLE` 的北京时点依次执行任务，每个任务跑完等待下一个时点，禁止无限循环重跑。

#### Scenario: 当日任务依次执行
- **WHEN** 调度器启动
- **THEN** 按北京时点 16:10 同步 Candle → 16:30 抓新闻 → 16:40 去重 → 16:50 推荐 → 17:00 发布
- **AND** 每个任务只在该时点跑一次，跑完 sleep 到下一个时点

#### Scenario: 跨日等待
- **WHEN** 当日所有任务执行完毕
- **THEN** 调度器 sleep 到次日首个任务时点，不立即重跑

### Requirement: Candle 前置校验
`run-daily-recommendation` 在 scoring 步骤前 SHALL 校验最新 Candle 的 tradingDay 等于 asOf 北京日。

#### Scenario: Candle 未同步
- **WHEN** asOf 为今日北京日，但最新 Candle tradingDay < 今日
- **THEN** 抛 `PipelineStopError('candle_stale')` 停止流程

#### Scenario: Candle 已同步
- **WHEN** 最新 Candle tradingDay == asOf 北京日
- **THEN** 继续 scoring

### Requirement: 庄家低位吸筹市场信号
市场确认信号 SHALL 优先奖励"价格在 20 日低位区 + 成交量放大"的股票，而非"近 5 日已大涨"的股票。

#### Scenario: 低位放量
- **WHEN** latestClose 接近 20 日低点（如 < 20日均价 * 0.95）且 volumeRatio20d > 1.2
- **THEN** 市场信号得分高

#### Scenario: 已大涨追涨
- **WHEN** momentum5dPct > 0.1（5日已涨超10%）
- **THEN** 市场信号得分受限，避免追涨

### Requirement: 今日盘中下跌过滤
推荐生成时 SHALL 剔除"asOf 当日 Candle 跌幅超过阈值"的股票。

#### Scenario: 当日大跌剔除
- **WHEN** asOf 当日 Candle 存在且当日跌幅 > 3%
- **THEN** 该股票从推荐池剔除

## MODIFIED Requirements

### Requirement: asOf 时间边界
`run-daily-recommendation` 的 asOf SHALL 由调度器显式传入北京日收盘边界（当日 16:00 北京时间），不再默认 `Date.now()`。回测入口保留 `--as-of` 覆盖。

### Requirement: 预测与推荐分离
ThemeForecast SHALL 作为独立预测存档，每日推荐从"未过期预测 + 当日 Candle 验证重排"生成，而非每次重跑全量因果抽取链路。

## REMOVED Requirements

### Requirement: 市场信号趋势跟随打分
**Reason**: 与 `目标.md`"发现弱信号"背离，导致追涨杀跌。
**Migration**: 替换为庄家低位吸筹验证逻辑。
