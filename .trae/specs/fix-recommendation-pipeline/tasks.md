# Tasks

- [x] Task 1: 实现调度执行器，替代 docker 无限循环
  - [x] SubTask 1.1: 在 `mvp-daily-scheduler.ts` 新增 `runSchedulerLoop()`，按 `getNextScheduledRunBeijing` 计算下次任务，sleep 到时点后用 child_process 执行 `commandHint`，跑完算下一个，禁止重跑当日已完成任务
  - [x] SubTask 1.2: 新建 `backend/scripts/run-scheduler.ts` 入口调用 `runSchedulerLoop()`
  - [x] SubTask 1.3: 修改 `docker-compose.yml` scheduler command 改为 `node dist/scripts/run-scheduler.js`
  - [x] SubTask 1.4: 验证：调度器启动后按北京时点串行执行，当日任务跑完 sleep 到次日，不立即重跑

- [x] Task 2: asOf 显式化 + Candle 前置校验
  - [x] SubTask 2.1: `run-daily-recommendation.ts` 的 `getAsOf` 默认值从 `Date.now()` 改为"北京日当日 16:00 +08:00"
  - [x] SubTask 2.2: 在 scoring 步骤前新增 Candle 校验：查最新 Candle tradingDay，若 != asOf 北京日 则抛 `PipelineStopError('candle_stale')`
  - [x] SubTask 2.3: 校验失败时输出诊断信息（最新 Candle 日、asOf 日、差值天数）
  - [x] SubTask 2.4: 验证：Candle 未同步时流程停止；同步后继续

- [x] Task 3: 市场信号重构为庄家低位吸筹验证
  - [x] SubTask 3.1: 在 `scoring-contribution-engine.ts` 的 `calculateMarketSignalScore` 新增"低位区"判定：latestClose < avgClose20 * 0.95 视为低位
  - [x] SubTask 3.2: 重构动量分量 `S_m5/S_m20`：低位区 + volumeRatio20d > 1.2 得高分；momentum5dPct > 0.1 时得分受限（追涨降权）
  - [x] SubTask 3.3: 保留 `momentum5dPct/momentum20dPct/breakout20d/volatilityCompression` 字段输出，reasons 文案更新
  - [x] SubTask 3.4: 单测：低位放量得高分、追涨股得低分、数据不足记0分三个场景

- [x] Task 4: 今日盘中下跌过滤
  - [x] SubTask 4.1: `temp-stock-recommendation-service.ts` 新增 `isTodayDropEligible`：读 asOf 当日 Candle，当日跌幅 > 3% 返回 false
  - [x] SubTask 4.2: 接入过滤链（在 `isPriceEligible` 之后），新增 `excludedByTodayDrop` 计数与原因
  - [x] SubTask 4.3: 更新 `ISelectionDiagnostics` 与 `formatShortageReasons`
  - [x] SubTask 4.4: 单测：当日跌 5% 剔除、当日涨 2% 保留、无当日 Candle 保留

- [x] Task 5: 预测与推荐分离
  - [x] SubTask 5.1: 确认 `ThemeForecast` 表已存档预测（含 direction/probability/horizon/asOf）
  - [x] SubTask 5.2: `run-daily-recommendation.ts` 新增模式：当 `--from-forecast` 传入时，跳过因果抽取，从近 N 日未过期 ThemeForecast + 当日 Candle 重排生成推荐
  - [x] SubTask 5.3: 默认每日推荐仍跑全量（保持向后兼容），调度表新增 `forecast_replay` 任务用 `--from-forecast` 做盘中重排
  - [x] SubTask 5.4: 验证：`--from-forecast` 模式能从预测生成推荐且遵守时间边界

# Task Dependencies
- Task 2 依赖 Task 1（调度器要先能跑起来才有 asOf 传入）
- Task 3、Task 4 可并行（互不依赖）
- Task 5 依赖 Task 2（需要 Candle 校验保证数据新鲜）
