# Chromium 研究阅读器

后台研究任务可以在 Chromium 中解析中文维基百科的文章 HTML，再把正文摘录交给模型。默认阅读器使用 MediaWiki 的纯文本摘要接口。启用 Chromium 后仍使用原有的检索计划、来源编号、任务进度和断点续跑。

## 启用

在能运行 Chromium 原生进程沙箱的普通用户账号下，从仓库根目录运行以下命令。

```bash
uv sync --extra browser
uv run --extra browser playwright install chromium
```

将以下配置放在根目录 `.env`，然后重启应用。若使用发行版提供的 Chromium，环境变量可填写本机可执行文件的绝对路径。

```dotenv
RESEARCH_READER=chromium
# RESEARCH_CHROMIUM_PATH=/usr/bin/chromium
```

创建联网研究任务，在任务进度中查看「阅读来源」。选用中文维基百科作为检索源时，研究流程读取至多两个来源。配置 SearXNG 时保留搜索结果的原始摘录。

## 数据流

1. 阅读器接受系统生成的中文维基百科 `?curid=` 数字条目编号。HTTP 客户端检查固定域名解析出的 IP，向官方 HTTPS API 请求该编号的 HTML，校验返回的条目编号、类型和大小，并拒绝重定向。部署使用 HTTPS 代理时，由管理员配置的代理负责上游连接和证书信任。
2. 每次阅读启动一个启用进程沙箱的 Chromium，创建临时离线上下文。阅读器仅向该页面提供已取回的 HTML。页面脚本、服务工作线程、子资源、下载和后续导航均被禁用或阻止。浏览器会话不共享登录状态。
3. Chromium 从正文段落提取最多 1,200 个字符，过滤导航、脚注、表格和菜单。结果保留原来源链接。条目缺失、网络异常、浏览器依赖或沙箱不可用时，任务记录错误，可以在恢复条件后重试。

可用以下命令单独验证阅读器。

```bash
uv run --extra browser pytest -q tests/test_browser_reader.py
```

单元用例使用受控 HTTP 响应。浏览器用例用真实 Chromium 读取测试 HTML，并用本地 HTTP 服务核实嵌入资源没有发起请求。缺少可选浏览器依赖时，pytest 显示相应用例跳过。
