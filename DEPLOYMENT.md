# VPS deployment

- URL: http://110.42.34.12:10000
- Directory: `/opt/gupiao`
- Git baseline: `925d539cd2c68113364fb7d4df48f29b25faa78d` (`main`), plus deployment changes in this workspace.
- Compose file: `docker-compose.production.yml`
- Only port 10000 is published. Existing host services are preserved.
- AI configuration is not installed and no scheduler is running.

Run these commands on the VPS:

```sh
cd /opt/gupiao
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml up -d
docker compose -f docker-compose.production.yml stop
docker compose -f docker-compose.production.yml logs --tail=100 api web
```

## Data

Persistent directories are `data/postgres`, `data/redis`, and `backend/tmp`.
The root-only `.env` holds database credentials. Do not commit or publish it.

Initialize the stock universe without AI:

```sh
docker compose -f docker-compose.production.yml exec -T api bun scripts/initialize-data.ts
```

Initial history range is 2026-01-01 through 2026-09-04, the last completed
trading session when initialization began. Logs are under `/opt/gupiao/logs`.
The existing Yahoo missing-history mode is used when Eastmoney disconnects:

```sh
docker compose -f docker-compose.production.yml exec -T api bun scripts/sync-stock-history.ts --mode yahoo-backfill-missing --start-date 20260101 --end-date 20260904 --yahoo-concurrency 5
```

The history script skips existing stock/day records. Its exit code alone does
not establish complete coverage: read its failure summary and database counts.

## Backup and restore

```sh
umask 077
docker compose -f docker-compose.production.yml exec -T postgres pg_dump -U gupiao -d gupiaodb -Fc > data/backups/gupiaodb.dump
tar -czf data/backups/runtime.tar.gz backend/tmp
```

To restore a backup, stop the API first and restore into a new empty database,
then point `DATABASE_URL` at that database and restart the API:

```sh
docker compose -f docker-compose.production.yml stop api
docker compose -f docker-compose.production.yml exec -T postgres createdb -U gupiao gupiaodb_restore
docker compose -f docker-compose.production.yml exec -T postgres pg_restore -U gupiao -d gupiaodb_restore --no-owner < data/backups/gupiaodb.dump
```

## Host routing

`gupiao-inbound-route.service` adds connection marking for TCP 10000 using the
host's existing Mihomo inbound routing convention. It depends on the existing
`mihomo-docker-inbound-route.service`. Neither service exposes database ports.
The additional service is enabled at boot; its source is in `scripts/`.

## AI configuration

Copy `backend/ai-config.example.json` to `backend/tmp/ai-config.json` and fill
in the providers' API prefixes, keys, and ordered model lists. The existing
`backend/tmp:/app/tmp` mount exposes it to the API container. Set
`AI_CONFIG_FILE=tmp/ai-config.json` in the VPS `.env`, then recreate the API
container. Subsequent JSON edits require restarting the API process. Every AI
function shares this list and moves to the next model on a request/output
failure; exhaustion stops the workflow. Old `LLM_SMART_*` / `OPENAI_*` AI
credentials are no longer read. Keep the real JSON file private and out of Git.

AI 环境变量（VPS `.env`）：

```sh
AI_CONFIG_FILE=tmp/ai-config.json
CAUSAL_SIGNAL_EXTRACTOR=llm
CAUSAL_PROTOCOL_MODE=items
SCORING_RECIPE=event-v2
PIPELINE_STAGE_EXECUTOR=registry
```

## Scheduler

`docker-compose.production.yml` 里的 `scheduler` 服务与 api 共用镜像和 `.env`，
入口是 `bun dist/scripts/run-scheduler.js`（构建步骤现在会把 `scripts/**/*.ts`
一起编译进 `dist/scripts/`，所以 `run-scheduler.js` 与全部命令脚本都在镜像内）。
调度表定义在 `backend/src/services/mvp-daily-scheduler.ts`，时区按北京时间。

```sh
# 状态与日志
docker compose -f docker-compose.production.yml ps scheduler
docker compose -f docker-compose.production.yml logs --tail=50 scheduler

# 暂停 / 恢复定时任务
docker compose -f docker-compose.production.yml stop scheduler
docker compose -f docker-compose.production.yml up -d scheduler
```

**每个自然日只在 20:00（北京时间）跑一次** `daily_recommendation`，一条命令按顺序串联：

```sh
bun dist/scripts/sync-stock-history.js --mode incremental   # 1. 日线增量（否则推荐预检会 candle_stale 停止）
  && bun dist/scripts/backfill-yield-records.js             # 2. 历史收益对账（关键词惩罚读到已成熟收益）
  && bun dist/scripts/run-daily-recommendation.js           # 3. 新闻/LLM 抽取 → 图谱评分 → 发布推荐
```

任一步失败即中断当日链路并保留上一份已发布快照，不降级、不折中。
调度是串行的：若某个任务运行超过下一次调度时间，该次会被顺延（不会补跑），
因此这里只保留一个任务、把所有步骤串在同一条命令里。
启动日志会打印 `[scheduler] next task=... beijing=...`，可直接确认下一次执行时间。
