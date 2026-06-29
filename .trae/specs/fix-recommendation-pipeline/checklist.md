# Checklist

## 调度执行器
- [x] `mvp-daily-scheduler.ts` 存在 `runSchedulerLoop()` 实现，按北京时点串行执行
- [x] `backend/scripts/run-scheduler.ts` 入口存在并可被 `bun run` 执行
- [x] `docker-compose.yml` scheduler command 指向 `run-scheduler.js`，不再直接跑 `run-daily-recommendation.js`
- [x] 调度器当日任务跑完 sleep 到次日，不立即重跑（无无限循环）

## asOf + Candle 校验
- [x] `run-daily-recommendation.ts` 默认 asOf 为北京日 16:00，不再用 `Date.now()`
- [x] scoring 前有 Candle tradingDay 校验，不等则抛 `PipelineStopError('candle_stale')`
- [x] 校验失败输出最新 Candle 日 / asOf 日 / 差值诊断

## 市场信号重构
- [x] `calculateMarketSignalScore` 新增低位区判定（latestClose < avgClose20 * 0.95）
- [x] 低位区 + volumeRatio20d > 1.2 得高分
- [x] momentum5dPct > 0.1 时得分受限（追涨降权）
- [x] `momentum5dPct/momentum20dPct/breakout20d/volatilityCompression` 字段保留
- [x] 单测覆盖：低位放量高分 / 追涨低分 / 数据不足0分

## 今日盘中下跌过滤
- [x] `isTodayDropEligible` 实现：asOf 当日 Candle 跌幅 > 3% 剔除
- [x] 接入过滤链，`excludedByTodayDrop` 计数与原因输出
- [x] `ISelectionDiagnostics` 与 `formatShortageReasons` 已更新
- [x] 单测覆盖：跌5%剔除 / 涨2%保留 / 无当日Candle保留

## 预测推荐分离
- [x] `ThemeForecast` 表存档字段完整（direction/probability/horizon/asOf）
- [x] `run-daily-recommendation.ts` 支持 `--from-forecast` 模式
- [x] `--from-forecast` 模式遵守时间边界（不读 asOf 之后数据）
- [x] 调度表新增 `forecast_replay` 任务

## 全局
- [x] `cd backend && bun run check:fix` 通过（无 lint error）
- [x] `cd backend && bun test` 通过（vitest 273/273）
- [x] 推荐股票不再出现"1911股上涨但推荐全跌"的背离（趋势跟随已移除）
