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

from .desktop import Desktop, DesktopUnavailable
from .engine import ConversationBusy, Engine
from .exports import docx, xlsx
from .linking import Linking
from .project_budget import read_snapshot
from .projects import ProjectConflict
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


class ProjectInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class ProjectFileInput(BaseModel):
    content: str = Field(min_length=1, max_length=24576)
    expected_version: int = Field(ge=0, strict=True)


class ProjectSelection(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    version: int = Field(ge=1, strict=True)


class ProjectPublish(BaseModel):
    task_id: str = Field(min_length=1, max_length=80)
    source_run_id: str = Field(min_length=1, max_length=80)
    source_name: str = Field(min_length=1, max_length=80)
    target_name: str = Field(min_length=1, max_length=80)
    expected_version: int = Field(ge=0, strict=True)


class DesktopSave(BaseModel):
    target_name: str | None = Field(None, min_length=1, max_length=80)


class TaskInput(BaseModel):
    project_id: str | None = Field(None, min_length=1, max_length=80)
    project_files: list[ProjectSelection] = Field(default_factory=list, max_length=4)
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
    desktop = Desktop(tasks.projects)
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
    app.state.desktop = desktop

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

    @app.exception_handler(ProjectConflict)
    async def conflict(request, exc):
        return JSONResponse({"detail": str(exc), "reason": exc.reason}, 409)

    @app.exception_handler(ConversationBusy)
    async def busy(request, exc):
        return JSONResponse({"detail": str(exc)}, 409)

    @app.exception_handler(DesktopUnavailable)
    async def unavailable(request, exc):
        return JSONResponse({"detail": str(exc)}, 503)

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
            "desktop_configured": desktop.sandbox.enabled,
        }

    @app.get("/api/budget")
    def budget(user=authenticated):
        state = provider.budget()
        return {
            **state,
            "project_budget": read_snapshot(Path(db_path).with_name("project-budget.sqlite3")),
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

    @app.get("/api/projects")
    def projects_list(user=authenticated):
        return tasks.projects.list(user)

    @app.post("/api/projects", status_code=201)
    def create_project(data: ProjectInput, user=authenticated):
        return tasks.projects.create(user, data.name)

    @app.get("/api/projects/{pid}")
    def project(pid: str, user=authenticated):
        return tasks.projects.get(user, pid)

    @app.delete("/api/projects/{pid}", status_code=204)
    def delete_project(pid: str, user=authenticated):
        desktop.delete_project(user, pid)
        return Response(status_code=204)

    @app.get("/api/projects/{pid}/desktop")
    def desktop_status(pid: str, user=authenticated):
        return desktop.status(user, pid)

    @app.post("/api/projects/{pid}/desktop")
    def open_desktop(pid: str, data: ProjectSelection, user=authenticated):
        return desktop.start(user, pid, data.name, data.version)

    @app.get("/api/projects/{pid}/desktop/{sid}/screen")
    def desktop_screen(pid: str, sid: str, user=authenticated):
        return Response(
            desktop.screenshot(user, pid, sid),
            media_type="image/png",
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    @app.post("/api/projects/{pid}/desktop/{sid}/input", status_code=204)
    def desktop_input(pid: str, sid: str, data: dict, user=authenticated):
        desktop.input(user, pid, sid, data)
        return Response(status_code=204)

    @app.post("/api/projects/{pid}/desktop/{sid}/save")
    def save_desktop(pid: str, sid: str, data: DesktopSave, user=authenticated):
        return desktop.save(user, pid, sid, target_name=data.target_name)

    @app.delete("/api/projects/{pid}/desktop/{sid}", status_code=204)
    def close_desktop(pid: str, sid: str, user=authenticated):
        desktop.stop(user, pid, sid)
        return Response(status_code=204)

    @app.get("/api/projects/{pid}/files/{name}")
    def project_file(pid: str, name: str, version: int | None = None, user=authenticated):
        return tasks.projects.file(user, pid, name, version)

    @app.get("/api/projects/{pid}/files/{name}/history")
    def project_file_history(pid: str, name: str, user=authenticated):
        return tasks.projects.history(user, pid, name)

    @app.put("/api/projects/{pid}/files/{name}")
    def write_project_file(pid: str, name: str, data: ProjectFileInput, user=authenticated):
        return tasks.projects.write(user, pid, name, data.content, data.expected_version)

    @app.delete("/api/projects/{pid}/files/{name}", status_code=204)
    def delete_project_file(pid: str, name: str, expected_version: int, user=authenticated):
        tasks.projects.delete_file(user, pid, name, expected_version)
        return Response(status_code=204)

    @app.post("/api/projects/{pid}/publish")
    def publish_task_file(pid: str, data: ProjectPublish, user=authenticated):
        return tasks.projects.publish(
            user,
            pid,
            data.task_id,
            data.source_name,
            data.target_name,
            data.expected_version,
            source_run_id=data.source_run_id,
        )

    @app.get("/api/tasks/{tid}")
    def get_task(tid: str, user=authenticated):
        return tasks.get(user, tid)

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
            project_id=data.project_id,
            project_files=[file.model_dump() for file in data.project_files],
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
