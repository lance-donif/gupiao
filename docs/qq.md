# QQ 机器人接入

服务使用腾讯 QQ 机器人开放平台的 HTTP Webhook。单聊和群内 @ 消息调用与 Web 相同的对话引擎；每个群中的每位成员和机器人单聊分别拥有独立会话。群内回复对群成员可见。默认情况下 Web 和 QQ 拥有各自的身份与资料。

## 配置与验收

1. 在 QQ 开放平台注册并创建机器人，在开发管理页取得 AppID 和 AppSecret。把测试用户和测试群加入该机器人的沙箱配置。生产使用需要开放平台授予相应发布状态和权限。[启动接入](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/getting-started.html)
2. 在应用进程的环境中设置 `QQ_APP_ID` 和 `QQ_APP_SECRET`，同时按根目录 README 配置模型和 SQLite 持久存储。依赖包括 FastAPI、HTTPX 和 cryptography。单进程启动应用时会同时启动投递线程。配置修改后重启。
3. 将 HTTPS 公网地址下的 `POST /qq/webhook` 转发给应用。反向代理须保留原始请求体以及 `X-Bot-Appid`、`X-Signature-Ed25519`、`X-Signature-Timestamp` 标头。开放平台列出的可用端口包括 80、443、8080 和 8443，建议用 443。让服务器时钟保持同步。[订阅与回调](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)
4. 在开放平台的事件配置中填入完整 HTTPS 回调地址，验证成功后订阅 `C2C_MESSAGE_CREATE` 和 `GROUP_AT_MESSAGE_CREATE`。选择相应的单聊和群聊事件及消息发送能力，按应用管理页面要求配置公网出口 IP。出站需能连接 `https://api.bot.qq.com`。[获取访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html) · [API 调用指南](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html)
5. 从测试 QQ 单聊发送「记下这次对话的主题是茶」，再发送「刚才的主题是什么」。在测试群 @机器人 发送不同的问题，验证对话彼此隔离。发送 `/搜索 关键词` 可触发资料检索，回复末尾带来源标题。单聊支持 `/记住 内容`、`/记忆` 和 `/忘记 编号`。群聊当前处理 @ 机器人的文字消息。
6. 要让单聊读取自己的 Web 工作区，在 Web 工作区生成绑定码后私聊机器人发送 `/绑定 绑定码`。绑定码在入队前转换为摘要。双方绑定后可共享显式记忆及资料，在 Web 查看该 QQ 会话。在任一端解除绑定后，尚待发送的已绑定工作区答复会在下一次发送检查时取消。QQ 单聊的解除命令为 `/解绑`。

## 回调与交付

系统用 Ed25519 验证原始事件体。有效事件先写入 SQLite 收件箱，再向平台返回 `{"op":12,"d":0}`。消息 ID 和身份共同用于去重，完成回复前的入队记录跨重启保存。QQ 地址验证使用平台指定的令牌签名握手；无签名握手只接受对应 AppID、短时有效的秒级时间戳和受限的令牌字符集。[签名算法](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html) · [腾讯 BotGo 签名参考](https://github.com/tencent-connect/botgo/blob/master/interaction/signature/interaction.go)

发送使用 v2 的被动回复接口，附原始 `msg_id` 和稳定的 `msg_seq`。每条最多拆为四段，每段上限 1,000 字符，超长回复带截断标记。暂时性网络错误会复用已保存的答案和段号，最多尝试五次。模型错误会返回失败提示；平台拒绝、超时或用户解绑会记录在本地数据库。授权状态、AppSecret、机器人审核以及平台对内容和链接的限制都会影响真实投递。[单聊回复](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html) · [群聊回复](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)

运维人员可在项目数据库中执行下面的只读查询。状态包括 `ready`（待领取、处理中或待重试）、`sent`、`canceled` 和 `failed`。收到回调不等于在 QQ 客户端成功显示答复，应以测试账号实际收到为准。

```sql
SELECT status, error, COUNT(*) FROM qq_jobs GROUP BY status, error;
```

离线验证可运行 `python -m pytest -q tests/test_qq.py`。用例覆盖腾讯公开签名向量、地址验证、失效签名、持久去重、群成员隔离、绑定码摘要、解除绑定后的待发答复、凭证缓存，以及回复重试。真实验收需要有效测试机器人、可访问的 HTTPS 域名、模型配置和平台订阅。

## 使用本地模型验证整条消息流程

启动项目提供的本机 Qwen 服务（端点 `http://127.0.0.1:18081/v1`，模型名 `qwen-local`），随后从仓库根目录运行：

```sh
uv run python -m scripts.check_qq_local
```

诊断在临时数据库上启动应用和 QQ 投递线程，使用临时密钥签署两次相同的单聊事件，经过真实 ASGI 回调、验签、去重、SQLite、对话引擎、本地模型推理和 QQ REST 报文序列化。它验证两次回调收到 ACK、只有一次推理和一条待发答复，并核对答案、接收 OpenID、消息 ID、段号及账本记录。输出包含本次模型报告的输入与输出 token 数。

此诊断由脚本生成入站事件，并在进程内模拟腾讯的换取凭证和发送回复端点；这些请求不会到达腾讯。脚本固定使用回环地址、零单价和零预算，使用的身份与数据库独立于应用实例。公网域名、平台订阅和 QQ 客户端收信仍需按前面的步骤实测。

2026-11-20 的验证中，脚本询问法国首都，Qwen 回答「巴黎」。本地模型报告 125 个输入 token 和 2 个输出 token，SQLite 记录一笔零美元估算。两次签名回调收到两次 ACK，模拟腾讯接收方收到一条回复。

## 从 QQ 单聊运行任务

在机器人单聊中发送以下命令。绑定后，命令操作的是同一个 Web 工作区。未绑定的单聊使用自己的任务空间，之后绑定会切换到 Web 工作区。回复只发给主动发来命令的用户；后台任务结束后发送 `/进度` 或 `/成果` 即可查询。

| 操作 | 发送示例 |
| --- | --- |
| 创建一次性任务 | `/任务 写作 草拟会议邀请`、`/任务 研究 城市公共交通的趋势`、`/任务 文件 生成 预算.csv` |
| 列出本工作区任务 | `/任务列表`，发送 `/任务列表 2` 翻到下一页 |
| 查看状态和最近步骤 | `/进度 任务编号` |
| 暂停或恢复 | `/暂停 任务编号`、`/恢复 任务编号` |
| 阅读报告和已生成文件名称 | `/成果 任务编号` |
| 阅读单个文本文件 | `/成果 任务编号 预算.csv` |

创建回复会显示完整任务编号，可复制后查询。绑定的用户还可以从 Web 工作区下载原文件、Word 或 Excel。长文本按 QQ 单次被动回复的长度限制展示；群消息只用于对话和搜索，任务操作请使用单聊。
