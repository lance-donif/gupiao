"""Bootstrap a single private workspace or serve it."""

import argparse
import os
import secrets
from pathlib import Path

import uvicorn

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(prog="python -m assistant")
    cmds = parser.add_subparsers(dest="command", required=True)
    cmds.add_parser("init", help="在仓库根目录创建带随机工作区令牌的 .env")
    serve = cmds.add_parser("serve")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", default=8000, type=int)
    args = parser.parse_args()
    if args.command == "init":
        source = (ROOT / ".env.example").read_text()
        text = source.replace("WORKSPACE_TOKEN=\n", f"WORKSPACE_TOKEN={secrets.token_urlsafe(32)}\n", 1)
        try:
            fd = os.open(ROOT / ".env", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            parser.exit(1, "根目录 .env 已存在，工作区令牌保存在该文件。\n")
        with os.fdopen(fd, "w") as f:
            f.write(text)
        print("已创建 .env。登录 Web 时请使用其中的 WORKSPACE_TOKEN。")
    else:
        uvicorn.run(
            "assistant.app:create_app", factory=True, host=args.host, port=args.port, access_log=False
        )


if __name__ == "__main__":
    main()
