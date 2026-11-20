# 模型费用与独立核账

网页「额度」与 `assistant.provider` CLI 共用 `ASSISTANT_DB` 指向的 SQLite 文件。每个 Web、QQ、后台任务模型请求都先执行同一预留事务。SQLite 保存本地请求号、供应商响应 ID、模型、单价、用量和核账引用。备份时请包含整个数据库。

## 配置预算

在根目录配置文件或进程环境中设置下表各项。管理员核账密钥单独注入核账进程。

| 变量 | 用途 |
| --- | --- |
| `ASSISTANT_BUDGET_USD` | 此 SQLite 账本的累计额度，允许 0 至 50000 美元。 |
| `MODEL_BASE_URL`、`MODEL_NAME` | OpenAI Chat Completions 兼容端点及模型名称。 |
| `MODEL_API_KEY` | 外部模型推理密钥。 |
| `MODEL_INPUT_USD_PER_MILLION`、`MODEL_OUTPUT_USD_PER_MILLION` | 每百万 token 的美元单价。远程调用必须填正数，按合同中可能适用的最高档计入缓存、长上下文和推理计费。自托管回环端点允许填 0。 |
| `MODEL_MAX_OUTPUT_TOKENS`、`MODEL_MAX_TOKENS_FIELD` | 生成上限与协议字段，字段可选 `max_completion_tokens`、`max_tokens`。 |
| `MODEL_BILLABLE_OUTPUT_CEILING_TOKENS` | 含隐藏推理的每次请求计费输出上界，至少为生成上限。供应商允许额外推理时请填写该模型的总 token 上界。直连 xAI 时必填。 |

本地按请求 UTF-8 字节数、消息包装开销、计费输出上界及单价预留。输入上界适用于字节级分词的文本消息。该机制依赖供应商实际执行对应模型与价格，包括对 token 上界的约束。把外部提供商项目限额和告警按合同另行配置，可覆盖其他客户端和供应商附加费用。SDK 延迟、云主机与平台订阅费需要在项目财务台账中另核。

## 读取与对账

在仓库根目录执行，数据库路径需与运行服务一致。

```bash
uv run python -m assistant.provider --db data/echo.sqlite3 status
uv run python -m assistant.provider --db data/echo.sqlite3 list
```

`status` 中各金额以美元表示。`held` 是尚待结算的预留，`estimated` 来自供应商返回的用量或 xAI 报告的金额，`reconciled` 是凭证核对后录入的实额。`booked` 等于 `estimated + reconciled`。`free` 从本地额度扣除已记账和待结算预留，最低显示零。`list` 逐行打印请求，其中 `reserved`、`estimated` 和 `reconciled` 的单位为百万分之一美元。查看 `provider_id`、`created_at` 和 `id` 可与供应商日志交叉核对。

请求超时、异常响应或缺少用量时保留预留，直到有结算依据。逐笔核实供应商凭证后录入实际费用，凭证引用应唯一，可用发票号、行号及请求号组合。如果供应商只提供项目总额，请保留汇总报告，逐笔金额仍显示为待核或预估。相同凭证与金额重复提交仅生效一次。

```bash
uv run python -m assistant.provider --db data/echo.sqlite3 reconcile REQUEST_ID ACTUAL_USD BILLING_LINE_ID
```

如果进程崩溃留下 `pending` 记录，先停止工作进程，确认远端计费已完成，再为该条记录追加 `--recover-pending`。已确认未扣款的记录可按凭证录入 0。

## 独立读取 OpenAI 项目成本

将具有读取组织成本权限的管理员密钥通过密钥管理工具注入独立审计进程的环境变量 `OPENAI_ADMIN_KEY`。传入专用于本次工作的真实项目 ID、起始 UTC 日期和结束 UTC 日期（不含结束日）。

```bash
uv run python -m assistant.billing --project proj_EXAMPLE --start 2026-11-01 --end 2026-11-21
```

命令只向 OpenAI 官方组织 Costs API 发起 GET 请求，逐页核对项目 ID、日期和币种。输出含各时间桶费用、汇总美元金额、请求标识和查询时间。用 `provider_reported_usd` 与同周期、同项目的账本记录及结算凭证交叉核对。项目中其他客户端的请求会纳入该报告，近期费用可能延迟出现。其他提供商可从其计费后台导出相同周期的账单。部署测试中的模拟账单与免费回环调用均不能证明付费额度消耗。[OpenAI 官方 Costs API 规范](https://github.com/openai/openai-openapi/blob/master/openapi.yaml) · [xAI Chat Completions 用量字段](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions)

## 开发额度估算

`assistant.project_budget` 在 `data/project-budget.sqlite3` 中保留开发额度的人工记录。新建文件仅允许当前系统用户读写。首次报告累计用量时使用 `baseline`，后续有明确金额和估算依据的增量使用 `estimate`。以下命令中的大写变量需替换为实际金额、时刻和来源。

```bash
uv run python -m assistant.project_budget baseline AMOUNT --ref REPORT_ID --at UTC_TIMESTAMP --source "累计金额的来源"
uv run python -m assistant.project_budget estimate AMOUNT --ref ESTIMATE_ID --at UTC_TIMESTAMP --source "用量、单价及计算依据"
uv run python -m assistant.project_budget status
uv run python -m assistant.project_budget list
```

估算余额等于额度减去最近一次用户报告的累计金额，再减去该时刻之后登记的增量估算。累计金额覆盖其对应时刻及以前的估算。重复提交同一编号和内容仅记一笔，较早记录仍可在历史中查阅。金额以美元显示，支持六位小数。用 `status --at UTC_TIMESTAMP` 可按指定时间复算，也可在子命令前加 `--limit AMOUNT` 查看较低额度下的余额。

首次登记累计金额前，余额显示为 `null`。`verified_supplier_usd` 始终为空，供应商费用需在上面的独立核账流程中查证。这份开发估算不会触发外部请求，不改动应用的模型调用额度。缺少开发平台计费依据时，后续平台费用仍待更新。

工作台登录后的额度页面会在服务数据库旁查找同目录的 `project-budget.sqlite3`。对于自定义服务数据库路径，可在上述命令的子命令前指定 `--db /path/to/project-budget.sqlite3`。Web 端以只读方式查看汇总；缺少文件时，页面仅展示应用侧费用。累计开发用量可能已包含部分模型费，合并项目成本前应对齐核算期间并排除两边覆盖的同一笔费用。
