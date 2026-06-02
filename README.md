# 股票预测系统

新闻聚合 + 因果关键词网络 + 行情确认 → 可解释股票推荐。

## 技术栈

- **后端**：TypeScript + Bun + Prisma + Vitest
- **前端**：React + Vite + Radix UI + ECharts + AntV G6
- **数据库**：PostgreSQL（含 Apache AGE 图扩展）+ Redis
- **AI**：LangChain + deepagents

## 实现思路

```
抓新闻 → LLM 因果抽取 → 关键词关系图谱 → 行情确认 → 综合评分 → 生成推荐
```

每天跑一次：从新闻里用 LLM 提取因果信号，建关键词关系网，结合 K 线数据打分，选出 30 只推荐股票。

## 需要配置

复制 `.env.example` 为 `.env`，主要填 LLM 的 API Key：

- `LLM_SMART_BASE_URL` / `LLM_SMART_API_KEY` / `LLM_SMART_MODEL` — 主 LLM
- `LLM_CHEAP_BASE_URL` / `LLM_CHEAP_API_KEY` / `LLM_CHEAP_MODEL` — 廉价 LLM

其他按需修改。

## Docker 一键运行

```bash
# 启动所有服务（数据库 + 后端 API + 前端 + 定时任务）
docker compose up -d

# 停止
docker compose down
```

启动后：前端 `http://localhost:3000`，后端 API `http://localhost:8000`。

## 本地开发

```bash
# 1. 启动数据库
docker compose up -d postgres redis

# 2. 安装依赖
make install-dev

# 3. 初始化数据库表
make migrate

# 4. 启动服务
make backend-http   # 后端
make web            # 前端
```
