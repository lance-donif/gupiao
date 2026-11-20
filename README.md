# 回声 · Echo

回声是可自托管的中文个人 AI 工作台。你可以在 Web 上传资料、交给它持续执行的任务，也可以在 QQ 私聊或群内 @ 它。从本机开始即可体验真实模型推理。

## 在本机启动

需要 Python 3.12–3.14、带 FTS5 的 SQLite 和 uv。在仓库根目录运行：

```sh
uv sync --frozen
uv run python -m assistant init
python scripts/local_model.py
```

默认本地模型为 Qwen3.5-2B。首次启动会下载并校验约 1.28 GB 的量化权重。内存较少的设备可运行 `python scripts/local_model.py --profile lite` 使用 0.5B 模型。保持它运行，在第二个终端启动工作台。

```sh
uv run python -m assistant serve
```

打开 <http://127.0.0.1:8000>，用根目录 `.env` 的 `WORKSPACE_TOKEN` 登录。访问令牌代表这个私人 Web 工作区，持有者可以读取其中的数据。应用默认使用本机模型。接入云端时，在 `.env` 设置兼容 Chat Completions 的地址、模型标识、密钥和实际价格，再重启。文件工作和多步研究需要模型支持 JSON Schema 结构化输出。[本机模型与其他平台](docs/local-model.md) · [云模型费用配置](docs/budget.md)

## 可以交付什么

| 入口 | 可操作的实例 |
| --- | --- |
| 对话、记忆与知识文件 | 在「长期记忆」保存「用中文回答」。上传含有会议安排的 Markdown，再问会议是哪一天。文档按工作区索引，可删除。 |
| 联网研究 | 对话切到联网模式，询问一个概念并查看来源。后台研究会把主题拆成最多三项查询，保存检索进度、阅读资料并生成带来源的报告。默认检索中文维基百科，设置 SearXNG 后可查更多站点。 |
| 后台任务 | 委托撰写、研究或文件工作，可设单次、每天或每周执行。任务显示步骤、错误和下一次运行时间，支持暂停、恢复与下载结果。 |
| 文件工作 | 上传销售表并委托「计算每列合计，生成简报」，或让助手创建新表。文件随任务一起保存，表格工具计算数字，助手使用工具结果撰稿。可下载原始文件或转换为 Word、Excel。报告也可单独下载为 Markdown 或 Word。 |
| QQ | 支持单聊和群聊 @。可用 `/搜索` 联网，或私聊 `/记住` 保存偏好。私聊还支持委托写作、研究和文件任务，查询进度与成果。在 Web 的「服务连接」签发一次码，私聊绑定后即可访问同一工作区的记忆和知识文件。群聊使用独立上下文。 |
| 用量与额度 | 模型调用先预留费用，完成后记录用量和估算。可按请求号核账，管理员可独立读取专用 OpenAI 项目的成本报表。 |

任务由工作台服务运行，关闭浏览器后仍会继续。暂停在步骤之间生效，已经提交的模型请求可能完成并计费。定期任务在本轮完成后安排下一轮。任务失败会保留可查看的原因，等待用户恢复。内容和检索质量取决于模型、资料和上下文窗口，阅读报告时可打开原始来源。[文件工具、恢复和限制](docs/office.md) · [可选只读浏览器](docs/browser.md) · [可选隔离计算容器](docs/table-tools.md)

## QQ 与部署

QQ 需要开放平台 AppID、AppSecret、公网 HTTPS 回调，以及平台启用的事件权限。未开通 QQ 账号的开发者可使用签名诊断脚本验证消息从接收到回答的全链路。测试过程中，腾讯收发端点由本地传输模拟。[QQ 接入和复验](docs/qq.md)

应用使用单机 SQLite，建议每个实例持久保存 `data/` 并只运行一个 Web 服务进程。备份活动数据库可使用 SQLite backup API。公开部署时由 HTTPS 反向代理转发，QQ 的回调路径为 `/qq/webhook`。容器内可使用云端 HTTPS 模型；Linux 上使用宿主机回环模型时，可按下面的方式共享网络并将 Web 服务限制在本机。

```sh
docker build -t echo-assistant .
docker volume create echo-data
docker run --rm --network host --env-file .env -v echo-data:/app/data \
  echo-assistant python -m assistant serve --host 127.0.0.1 --port 8000
```

如果构建环境要求自定义 TLS 根证书，构建命令还支持 `--secret id=ca_bundle,src=/path/to/ca-bundle.pem`。工作区数据和配置文件独立于镜像保存。

## 验证

```sh
uv run --frozen ruff check assistant scripts tests
uv run --frozen pytest -q
# 先启动本机模型，再运行签名消息穿过整个 QQ 和模型链路的诊断。
uv run python -m scripts.check_qq_local
```

[产品与开源技术调研](docs/research.md) · [独立额度监督与核账](docs/budget.md) · [交付验证记录](docs/verification.md)
