# 产品与技术选型

调研日期为 2026 年 11 月 20 日（UTC）。用三个名称及 “personal agent” 检索网页后，逐项打开厂商产品页、帮助中心和开发文档。三家都展示了能在对话之外持续工作的个人助手。下表将厂商公开能力与这个项目可以验证的具体行为联系起来。

| 产品 | 官网展示的具体用法 | 对本项目的设计启发 |
| --- | --- | --- |
| Meta Muse | 用户交代目标后，助手用专属 Linux 云电脑和浏览器执行。用户可以从 WhatsApp 发起对话，查看行动记录，在代发邮件或购买前确认。 | QQ 应能真正接收和回复消息，重投事件应复用同一次请求。对外部服务的调用和成本应可追踪。[Muse 产品页](https://muse.ai/) |
| OpenAI Dots | 2026 年 9 月 29 日发布。用户给 dot 一个项目和上下文，它能在会话之间继续推进、学习偏好、产出材料。用户可以审阅、调整或暂停任务。 | 把用户记忆和单次聊天历史分开存储，让用户能查看和删除记忆。持续运行的任务需要独立的状态和可审阅的结果。[发布说明](https://openai.com/index/introducing-dots/) · [使用说明](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot) |
| Grok Bot | 一个有云电脑的工作助手，可接入 Slack 或 Teams，在应用之间完成任务并交付文件。文档分别说明了技能、例行任务、访问权限和审批。 | Web 与 QQ 共用对话引擎，渠道账号有独立身份。研究结果保留出处，便于用户自行查阅。[产品文档](https://docs.x.ai/grok-bot/overview) · [文件与成果](https://docs.x.ai/grok-bot/files-and-results) · [例行任务](https://docs.x.ai/grok-bot/skills-routines-and-automations) |

专属云电脑、任意第三方应用操作、企业身份和语音属于单独的产品能力。要验证与商业产品的等价性，需要实际演示这些操作。公开产品描述本身只能用来确定对标方向。

## 开源实现对比

用 GitHub 仓库搜索定位项目，并核对维护仓库的 README、许可证与 Releases。以下版本是调研时的公开发布记录，表内的参考项目可以帮助评估独立开发与引入依赖的取舍。

| 参考项目 | 查到的发布版本与许可证 | 与本项目相关的取舍 |
| --- | --- | --- |
| OpenClaw | v2026.11.6，MIT | 在一个 Gateway 内管理会话、工具和多个消息渠道。它适合作为多渠道架构参考，引入完整 Gateway 还会带来插件运行时和额外配置。[仓库与说明](https://github.com/openclaw/openclaw) · [发布记录](https://github.com/openclaw/openclaw/releases/tag/v2026.11.6) |
| AstrBot | v4.29.4，AGPL-3.0。发布列表还有 v4.30.0-beta.1 | 面向 QQ 等即时通信平台，已经提供模型与插件适配。直接采用其运行时需考虑插件运维和软件许可证；小范围的官方 QQ 回调适配可以单独验证。[仓库](https://github.com/AstrBotDevs/AstrBot) · [版本](https://github.com/AstrBotDevs/AstrBot/releases/tag/v4.29.4) |
| Tencent BotGo | v0.1.8，Apache-2.0 | 腾讯维护的协议参考，可与平台文档交叉核对签名验证和回包。QQ BotPy 的 v1.2.1 是 2024 年发布的版本。实际可用事件、回调配置以管理端和现行平台文档为准。[BotGo](https://github.com/tencent-connect/botgo) · [BotPy](https://github.com/tencent-connect/botpy) · [事件协议](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html) |
| Letta | 0.16.8，Apache-2.0 | 面向有持久记忆的代理，适合评估复杂记忆管理。显式保存的少量偏好可以先用数据库记录，并按身份读取。[仓库](https://github.com/letta-ai/letta) |
| OpenAI Agents SDK for Python | v0.25.0，MIT | 提供代理编排和工具调用。单一研究流程能直接调用检索与模型；拓展到多个可选工具、代理交接时可评估引入 SDK。[仓库](https://github.com/openai/openai-agents-python) |
| OpenSandbox | release-1.2.1，Apache-2.0 | 面向隔离的代码、浏览器与桌面执行环境，支持 Docker、Kubernetes 和网络访问控制。部署这种沙箱需要独立的计算与运维资源。[仓库](https://github.com/opensandbox-group/OpenSandbox) |

## 实现栈与版本依据

单机 Web 服务选用 Python、FastAPI、HTTPX 和 SQLite。FastAPI 处理 Web API 与 QQ 回调，HTTPX 可将模型和渠道的网络传输替换成本地测试传输。SQLite 让服务和测试都能在同一台机器上验证持久性及事务，不依赖额外开通的云数据库。前端使用浏览器标准模块，聊天、记忆与引用等核心交互可直接在浏览器中验收。

按 PyPI JSON API 的文件上传时间、撤回状态和版本号检查，截至调研日的最高正式版本为 FastAPI 0.165.0、Uvicorn 0.54.0、HTTPX 0.28.1、Pydantic 2.14.4、PyNaCl 1.6.2、cryptography 50.0.2 和 pytest 9.2.0。这个快照供选型复核，实际安装版本以项目依赖文件为准。[FastAPI](https://pypi.org/project/fastapi/0.165.0/) · [Uvicorn](https://pypi.org/project/uvicorn/0.54.0/) · [HTTPX](https://pypi.org/project/httpx/0.28.1/) · [Pydantic](https://pypi.org/project/pydantic/2.14.4/) · [PyNaCl](https://pypi.org/project/PyNaCl/1.6.2/) · [cryptography](https://pypi.org/project/cryptography/50.0.2/) · [pytest](https://pypi.org/project/pytest/9.2.0/)

可用下列只读命令抽查上面的来源。查询不包含模型推理和购置云资源。

```sh
gh search repos --match name --limit 5 openclaw
gh api repos/openai/openai-agents-python/releases/tags/v0.25.0 --jq '.published_at'
gh api repos/tencent-connect/botgo --jq '.license.spdx_id'
curl -fsSL https://pypi.org/pypi/fastapi/0.165.0/json | python -c 'import json,sys; print(json.load(sys.stdin)["urls"][0]["upload_time_iso_8601"])'
```
