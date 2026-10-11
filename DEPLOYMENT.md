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

## 离线重建（宿主无外网时）

宿主出网依赖 Mihomo（`127.0.0.1:7890`）。当它的上游节点不可用时，
`docker compose build` 会因无法 pull `oven/bun:1`、`nginx`、`docker/dockerfile:1` 而失败，
表现为 `failed to resolve source metadata ... EOF`。

此时不要修改 Dockerfile，改用**补丁式构建**：以线上正在运行的镜像为底座，只替换源码或产物。

后端（在容器内跑 `tsc`，能完整复现类型检查）：

```dockerfile
FROM gupiao-backend:<当前tag>
WORKDIR /app
RUN rm -rf src scripts dist          # 必须先清空！COPY 只覆盖不删除
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json prisma.config.ts package.json ./
RUN bun run build
```

前端（vite 依赖只存在于本地，服务器无 `web/node_modules` 且无法联网安装）：
本地 `cd web && bun run build`，上传 `dist/` 后 `COPY` 进 nginx 镜像。

两处共同的坑：**`COPY` 不会删除目标目录中已存在、但源里没有的文件**。
本次删除了 29 个源文件，若不清空 `/app/src`，旧模块仍会被 `tsc` 编译并报“导出不存在”。

自检要点（构建后必须确认）：

```sh
# 新模块在、已删模块无残留、入口齐全
docker run --rm --entrypoint sh gupiao-backend:<tag> -c \
  'ls /app/dist/src/lib/beijing-time.js /app/dist/scripts/run-scheduler.js; \
   ls /app/dist/src/services/service-di.js 2>&1 | tail -1'
```

部署后确认 web 服务已改为显式 `image:`（否则 compose 会尝试联网 rebuild）：

```yaml
web:
  build: ./web
  image: gupiao-web:<tag>
```


## 代理（Mihomo）故障排查

宿主出网完全依赖 Mihomo TUN（`/etc/mihomo/config.yaml`，API `127.0.0.1:9090`）。
一旦它失效，表现为：`docker compose build` 无法 pull、容器内 HTTPS 全部
`unknown certificate verification error`、`sync-stock-history` 熔断
（`aktools_unavailable_fail_fast`）导致当日推荐链路在第 1 步就中断
（**此时不会写入 RunTrace**，所以「某天没有推荐记录」往往意味着失败发生在落库之前）。

**关键坑：节点域名必须用订阅自带的 DoH 解析。**

节点 server 是 `*.huaweidns.cn` 这类动态域名。若 `proxy-server-nameserver`
填公共 DNS（如 `223.5.5.5`），会解析到一个连不通的 IP，表现为所有节点
`dial tcp <ip>:<port>: i/o timeout`、API 探活全部 503/504。
必须使用订阅下发的专用 DoH：

```yaml
dns:
  default-nameserver: [223.5.5.5, 119.29.29.29, 114.114.114.114]
  proxy-server-nameserver: ['https://sh.dns44.cn:44443/dns-query', 'https://hk.dns44.cn:44443/dns-query']
  nameserver: [223.5.5.5, 119.29.29.29, 114.114.114.114]
```

`nameserver` 也不要用 `1.1.1.1/8.8.8.8` 的 DoH —— 它们本身需要经代理才能到达，
代理故障时会连域名解析一起拖垮，形成死锁。

修改后的标准流程（顺序不可省）：

```sh
mihomo -t -d /etc/mihomo -f /etc/mihomo/config.yaml   # 先测语法，避免起不来失去 SSH
systemctl restart mihomo
# 验证：18/18 节点可用、gstatic 经 7890 返回 204
S=$(grep '^secret:' /etc/mihomo/config.yaml | awk '{print $2}')
curl -s -o /dev/null -w '%{http_code}\n' -x http://127.0.0.1:7890 http://www.gstatic.com/generate_204
```

排查节点可用性：

```sh
curl -s -H "Authorization: Bearer $S" http://127.0.0.1:9090/proxies | \
  python3 -c "import sys,json; d=json.load(sys.stdin)['proxies']; \
  print([g for g,v in d.items() if v.get('type')=='Selector'])"
# 单节点延迟：GET /proxies/<urlencoded name>/delay?timeout=5000&url=http://www.gstatic.com/generate_204
```

配置文件是**手写内联节点**（非 proxy-provider 订阅），订阅更新后需手动同步
`proxies:` 段。修改前务必备份：`cp config.yaml config.yaml.bak-$(date +%F)`。


## 数据库漂移记录

- `StrategyPerformanceReport`：模型存在于 `schema.prisma`，但**从未生成 migration**，
  导致生产库缺表（多策略实验阶段 `upsert` 直接 P2021 报错）。2026-10-11 已手工按
  模型定义补建（含唯一索引 `(strategyId, asOf)`、clusterKey 索引、外键级联）。
  **待办：在本地用 `prisma migrate dev --create-only` 补一份迁移，否则新环境部署仍会缺表。**

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

AI 只读根目录 `.env`（模板与字段说明见 `.env.example`，注释为中文）。
提供商用 `AI_PROVIDER_IDS` 列出（逗号分隔，顺序即优先级），每个提供商按
`AI_PROVIDER_<ID大写>_BASE_URL/_API_KEY/_MODELS` 填写，模型级超时/参数/限流用
`AI_PROVIDER_<ID大写>_MODEL_<序号>_*` 覆盖，全局调度用 `AI_SCHEDULING_*`，批量打包用
`AI_BATCHING_*`，配额组用 `AI_QUOTA_GROUPS` + `AI_QUOTA_GROUP_<组名>_*`。子目录不再存放
任何配置文件（`backend/ai-config.*.json` / `backend/.env` 已删除，`AI_CONFIG_FILE` 不再读取）。
改完 `.env` 后重建 API 容器。Every AI function shares this list and moves to the next
model on a request/output failure; exhaustion stops the workflow. Old `LLM_SMART_*` /
`OPENAI_*` AI credentials are no longer read. Keep the real `.env` private and out of Git.

AI 环境变量（VPS `.env`，完整字段见 `.env.example`）：

```sh
AI_PROVIDER_IDS=deepseek-official,grok-heavy
AI_PROVIDER_DEEPSEEK_OFFICIAL_BASE_URL=https://api.deepseek.com
AI_PROVIDER_DEEPSEEK_OFFICIAL_API_KEY=<secret>
AI_PROVIDER_DEEPSEEK_OFFICIAL_MODELS=deepseek-flash
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

**每个交易日前一晚 20:00（北京时间）跑一次** `daily_recommendation`（周日~周四；周五/周六不跑，
周四晚已生成周五推荐），asOf 取「下一工作日 16:00」（节假日由 TradingCalendarDay 修正到下一开市日）。
即周日 20:00 跑出周一的推荐，周一开盘前已可查看。一条命令按顺序串联：

```sh
bun dist/scripts/sync-stock-history.js --mode incremental   # 1. 日线增量（否则推荐预检会 candle_stale 停止）
  && bun dist/scripts/backfill-yield-records.js             # 2. 历史收益对账（关键词惩罚读到已成熟收益）
  && bun dist/scripts/run-daily-recommendation.js           # 3. 新闻/LLM 抽取 → 图谱评分 → 发布推荐（asOf=下一交易日）
```

任一步失败即中断当日链路并保留上一份已发布快照，不降级、不折中。
调度是串行的：若某个任务运行超过下一次调度时间，该次会被顺延（不会补跑），
因此这里只保留一个任务、把所有步骤串在同一条命令里。
启动日志会打印 `[scheduler] next task=... beijing=...`，可直接确认下一次执行时间。
