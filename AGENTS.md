# 回声工作台

- Python 3.12+，使用 uv.lock 同步依赖。应用配置示例集中在根目录 .env.example。
- 运行 uv run ruff check assistant desktop scripts tests 和 uv run pytest。修改 Web 后用桌面和移动浏览器验证。
- 每次提供商调用前检查请求体长度（不超过 240000 字符），并在 SQLite 中原子预留费用。上游异常要告知用户。
- 区分本地估算、待核费用和供应商账单。测试使用临时数据库。QQ 应使用独立测试应用或签名模拟事件。
- 工作区令牌、机器人密钥、对话和知识文件不得提交。
