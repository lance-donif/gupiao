"""FastAPI composition root for the private Web workspace and signed QQ events."""

import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .engine import ConversationBusy, Engine
from .exports import docx, xlsx
from .linking import Linking
from .provider import Provider
from .qq import QQBot
from .search import WebSearch
from .tasks import TaskQueue

ROOT = Path(__file__).resolve().parents[1]
WEB_OWNER = "web:workspace"


class ConversationInput(BaseModel):
    title: str | None = Field(None, max_length=128)


class MessageInput(BaseModel):
    text: str = Field(min_length=1, max_length=16000)
    mode: Literal["chat", "research"] = "chat"
    request_id: str | None = Field(None, min_length=1, max_length=160)


class MemoryInput(BaseModel):
    content: str = Field(min_length=1, max_length=2000)


class DocumentInput(BaseModel):
    name: str = Field(min_length=1, max_length=140)
    content: str = Field(min_length=1, max_length=262144)


class TaskFileInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    content: str = Field(min_length=1, max_length=24576)


class TaskInput(BaseModel):
    files: list[TaskFileInput] = Field(default_factory=list, max_length=4)
    request_id: str | None = Field(None, min_length=1, max_length=160)
    prompt: str = Field(min_length=1, max_length=4000)
    kind: Literal["draft", "research", "office"] = "research"
    frequency: Literal["once", "daily", "weekly"] = "once"


def create_app(*, db_path=None, token=None, provider=None, search=None, workers=True):
    load_dotenv(ROOT / ".env")
    token = token if token is not None else os.getenv("WORKSPACE_TOKEN", "")
    if len(token) < 20 or not token.isascii() or any(c.isspace() for c in token):
        raise ValueError("请运行 python -m assistant init，或将 WORKSPACE_TOKEN 设置为至少 20 位的随机令牌")
    db_path = db_path or os.getenv("ASSISTANT_DB", str(ROOT / "data/echo.sqlite3"))
    provider = provider or Provider(db_path)
    search = search or WebSearch()
    engine = Engine(db_path, provider, search)
    tasks = TaskQueue(engine)
    linking = Linking(engine)
    qq = QQBot(db_path, engine, tasks)

    @asynccontextmanager
    async def lifespan(app):
        if workers:
            tasks.start()
            qq.start()
        try:
            yield
        finally:
            if workers:
                qq.stop()
                tasks.stop()

    app = FastAPI(title="回声", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.include_router(qq.router)
    app.state.tasks = tasks

    def owner(authorization: str = Header(default="")):
        if not secrets.compare_digest(authorization.encode(), ("Bearer " + token).encode()):
            raise HTTPException(401, "请输入有效的工作区令牌", headers={"WWW-Authenticate": "Bearer"})
        return WEB_OWNER

    authenticated = Depends(owner)

    @app.exception_handler(KeyError)
    async def missing(request, exc):
        return JSONResponse({"detail": str(exc.args[0])}, 404)

    @app.exception_handler(ValueError)
    async def invalid(request, exc):
        return JSONResponse({"detail": str(exc)}, 400)

    @app.exception_handler(ConversationBusy)
    async def busy(request, exc):
        return JSONResponse({"detail": str(exc)}, 409)

    @app.exception_handler(RuntimeError)
    async def upstream(request, exc):
        return JSONResponse({"detail": str(exc)}, 502)

    @app.get("/healthz")
    def health():
        return {"status": "ok"}

    @app.get("/api/status")
    def status(user=authenticated):
        return {
            "model": provider.model,
            "model_configured": bool(
                provider.model and (provider.local or (provider.key and all(provider.rates)))
            ),
            "search": "SearXNG" if search.searx else "中文维基百科",
            "qq_configured": qq.enabled,
        }

    @app.get("/api/budget")
    def budget(user=authenticated):
        state = provider.budget()
        return {
            **state,
            **{
                key + "_usd": state[src]
                for key, src in (
                    ("limit", "limit"),
                    ("booked", "booked"),
                    ("held", "held"),
                    ("available", "free"),
                )
            },
        }

    @app.get("/api/conversations")
    def conversation_list(user=authenticated):
        return engine.conversations(user)

    @app.post("/api/conversations", status_code=201)
    def create_conversation(data: ConversationInput, user=authenticated):
        return engine.create_conversation(user, data.title)

    @app.delete("/api/conversations/{cid}", status_code=204)
    def delete_conversation(cid: str, user=authenticated):
        engine.delete_conversation(user, cid)
        return Response(status_code=204)

    @app.get("/api/conversations/{cid}/messages")
    def messages(cid: str, user=authenticated):
        return engine.messages(user, cid)

    @app.post("/api/conversations/{cid}/messages")
    def reply(cid: str, data: MessageInput, user=authenticated):
        return engine.reply(user, cid, data.text, data.mode, data.request_id)

    @app.get("/api/memories")
    def memories(user=authenticated):
        return engine.memories(user)

    @app.post("/api/memories", status_code=201)
    def add_memory(data: MemoryInput, user=authenticated):
        return engine.add_memory(user, data.content)

    @app.delete("/api/memories/{mid}", status_code=204)
    def delete_memory(mid: str, user=authenticated):
        engine.delete_memory(user, mid)
        return Response(status_code=204)

    @app.get("/api/documents")
    def documents(user=authenticated):
        return engine.documents(user)

    @app.post("/api/documents", status_code=201)
    def add_document(data: DocumentInput, user=authenticated):
        return engine.add_document(user, data.name, data.content)

    @app.delete("/api/documents/{did}", status_code=204)
    def delete_document(did: str, user=authenticated):
        engine.delete_document(user, did)
        return Response(status_code=204)

    @app.get("/api/qq/link")
    def link_status(user=authenticated):
        return linking.status(user)

    @app.post("/api/qq/link-code")
    def link_code(user=authenticated):
        if not qq.enabled:
            raise HTTPException(503, "请先配置 QQ 机器人")
        return JSONResponse(linking.issue(user), headers={"Cache-Control": "no-store"})

    @app.delete("/api/qq/link", status_code=204)
    def unlink(user=authenticated):
        linking.unlink(user)
        return Response(status_code=204)

    def download(name, content, fmt):
        if fmt == "docx":
            content = docx(content)
            name = Path(name).stem + ".docx"
            mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        elif fmt == "xlsx":
            if not name.endswith(".csv"):
                raise ValueError("Excel 导出需要 CSV 文件")
            content = xlsx(content)
            name = Path(name).stem + ".xlsx"
            mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        else:
            mime = "text/markdown; charset=utf-8" if name.endswith(".md") else "application/octet-stream"
        return Response(
            content,
            media_type=mime,
            headers={
                "Content-Disposition": "attachment; filename*=UTF-8''" + quote(name, safe=""),
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.get("/api/tasks/{tid}/files/{name}")
    def workspace_file(
        tid: str, name: str, format: Literal["original", "docx", "xlsx"] = "original", user=authenticated
    ):
        return download(name, tasks.office.read(user, tid, name), format)

    @app.get("/api/tasks")
    def task_list(user=authenticated):
        return tasks.list(user)

    @app.post("/api/tasks", status_code=201)
    def create_task(data: TaskInput, user=authenticated):
        return tasks.create(
            user,
            data.prompt,
            data.frequency,
            data.kind,
            request_id=data.request_id,
            files=[file.model_dump() for file in data.files],
        )

    @app.get("/api/tasks/{tid}/artifact")
    def artifact(tid: str, format: Literal["md", "docx"] = "md", user=authenticated):
        return download(f"echo-{tid}.md", tasks.artifact(user, tid), format)

    @app.post("/api/tasks/{tid}/{action}")
    def change_task(tid: str, action: Literal["pause", "resume"], user=authenticated):
        return tasks.change(user, tid, action)

    @app.delete("/api/tasks/{tid}", status_code=204)
    def delete_task(tid: str, user=authenticated):
        tasks.change(user, tid, "delete")
        return Response(status_code=204)

    app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
    return app
