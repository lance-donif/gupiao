"""Project-scoped human access to a single-file, offline Linux graphical editor."""

import hashlib
import json
import os
import re
import selectors
import shutil
import subprocess
import tempfile
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from .office import filename, validate_text
from .projects import ProjectConflict

WIDTH, HEIGHT = 1000, 650
TTL = 1800
MAX_SESSIONS = 4
MAX_TEXT = 24 * 1024
KEYS = frozenset(
    {
        "BackSpace",
        "Delete",
        "Return",
        "Tab",
        "Left",
        "Right",
        "Up",
        "Down",
        "Home",
        "End",
        "Page_Up",
        "Page_Down",
        "Control_L+a",
        "Control_L+z",
        "Control_L+y",
    }
)
WORKER = ["/usr/bin/python3", "-I", "/opt/echo/worker.py"]
IMAGE = re.compile(r"sha256:[a-f0-9]{64}")
CID = re.compile(rb"[a-f0-9]{64}")
SCHEMA = """
CREATE TABLE IF NOT EXISTS desktop_sessions (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE,
  source_name TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  expires REAL NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0
);
"""


class DesktopUnavailable(RuntimeError):
    pass


def _session_conflict(message="图形会话已结束或已更换，请刷新会话"):
    return ProjectConflict(message, reason="desktop_session")


def _payload(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _input_event(event):
    if not isinstance(event, dict):
        raise ValueError("无效的桌面输入")  # noqa: TRY004 -- public validation errors are HTTP 400.
    match event.get("type"):
        case "click":
            x, y = event.get("x"), event.get("y")
            if (
                set(event) == {"type", "x", "y"}
                and type(x) is int
                and type(y) is int
                and 0 <= x < WIDTH
                and 0 <= y < HEIGHT
            ):
                return event
        case "key":
            if set(event) == {"type", "key"} and isinstance(event["key"], str) and event["key"] in KEYS:
                return event
        case "text":
            if set(event) == {"type", "text"} and isinstance(event["text"], str):
                text = event["text"]
                if (
                    text
                    and len(text.encode("utf-8")) <= MAX_TEXT
                    and all(ord(c) >= 32 or c in "\t\r\n" for c in text)
                ):
                    return event
    raise ValueError("不支持的输入、坐标或文本")


def _docker(args, data=b"", limit=512, timeout=12):
    """A bounded CLI call. No credentials, remote Docker contexts or project files are mounted."""
    executable = shutil.which("docker")
    if not executable:
        raise DesktopUnavailable("找不到本机 Docker CLI")
    command = [executable, "--host=unix:///var/run/docker.sock", *args]
    with (
        tempfile.TemporaryDirectory(prefix="echo-desktop-config-") as config,
        tempfile.TemporaryFile() as stdin,
    ):
        stdin.write(data)
        stdin.seek(0)
        with subprocess.Popen(
            command,
            stdin=stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={"PATH": os.defpath, "DOCKER_CONFIG": config},
        ) as proc:
            deadline = time.monotonic() + timeout
            output = bytearray()
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(proc.stdout, selectors.EVENT_READ)
                    while True:
                        left = deadline - time.monotonic()
                        if left <= 0 or not selector.select(left):
                            raise TimeoutError
                        block = os.read(proc.stdout.fileno(), 65536)
                        if not block:
                            break
                        output.extend(block)
                        if len(output) > limit:
                            raise DesktopUnavailable("图形容器返回数据超过限制")
                proc.wait(timeout=max(0.001, deadline - time.monotonic()))
            except (TimeoutError, subprocess.TimeoutExpired) as exc:
                raise DesktopUnavailable("图形容器操作超时，请检查本机 Docker 服务") from exc
            finally:
                if proc.poll() is None:
                    proc.kill()
            if proc.returncode:
                raise DesktopUnavailable("图形容器操作失败，请检查本地镜像和 Docker 服务")
            return bytes(output)


class DockerEditor:
    def __init__(self):
        self.image = os.getenv("ECHO_DESKTOP_IMAGE_ID", "").strip()
        if self.image and not IMAGE.fullmatch(self.image):
            raise ValueError("ECHO_DESKTOP_IMAGE_ID 需要完整的 sha256 镜像 ID")
        self.enabled = bool(self.image)

    def find(self, name, *, running=True):
        flags = [
            "ps",
            "-q" if running else "-aq",
            "--no-trunc",
            "--filter",
            f"name=^/{name}$",
            "--filter",
            f"label=io.echo.editor={name}",
        ]
        value = _docker(flags).strip()
        if value and not CID.fullmatch(value):
            raise DesktopUnavailable("图形容器标识异常")
        return value.decode() or None

    def launch(self, name, file):
        value = _docker(
            [
                "run",
                "-d",
                "--rm",
                "--pull=never",
                "--name",
                name,
                "--label",
                f"io.echo.editor={name}",
                "--network=none",
                "--read-only",
                "--cap-drop=ALL",
                "--security-opt=no-new-privileges",
                "--pids-limit=32",
                "--memory=192m",
                "--memory-swap=192m",
                "--cpus=.75",
                "--user=10001:10001",
                "--tmpfs",
                "/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777",
                self.image,
            ],
            timeout=20,
        ).strip()
        if not CID.fullmatch(value):
            raise DesktopUnavailable("无法识别新建的图形容器")
        self.command(value.decode(), "init", _payload(file))

    def command(self, cid, op, data=b""):
        limits = {"init": 1024, "input": 1024, "screenshot": 3 * 1024 * 1024, "read": MAX_TEXT}
        return _docker(["exec", "-i", cid, *WORKER, op], data, limit=limits[op])

    def remove(self, name):
        cid = self.find(name, running=False)
        if cid:
            _docker(["rm", "-f", cid])


class Desktop:
    def __init__(self, projects, *, sandbox=None):
        self.projects = projects
        self.engine = projects.engine
        self.sandbox = sandbox or DockerEditor()
        path = Path(self.engine.path).resolve()
        self.scope = hashlib.sha256(str(path).encode()).hexdigest()[:24]
        self.lock_dir = (
            Path(tempfile.gettempdir()) if self.engine.memory else path.parent
        ) / f".echo-desktop-{self.scope}"
        with self.engine.connection() as db:
            db.executescript(SCHEMA)
        with self.engine.connection(write=True) as db:
            columns = {r["name"] for r in db.execute("PRAGMA table_info(desktop_sessions)")}
            if "ready" not in columns:
                # Older sessions lack a marker. Verify their worker on first use,
                # retaining an initialized desktop and any edits it already contains.
                db.execute("ALTER TABLE desktop_sessions ADD COLUMN ready INTEGER")

    def _name(self, pid, sid):
        key = hashlib.sha256(f"{self.scope}/{pid}/{sid}".encode()).hexdigest()[:40]
        return f"echo-desktop-{key}"

    def _owned(self, owner, pid):
        with self.engine.connection() as db:
            self.projects._project(db, owner, pid)
            return db.execute("SELECT * FROM desktop_sessions WHERE project_id=?", (pid,)).fetchone()

    @contextmanager
    def _locked(self, owner, pid):
        # Docker is local to this Linux host. Sharded advisory locks span sibling API
        # processes and release on crash without holding the shared SQLite writer lock.
        import fcntl

        self._owned(owner, pid)
        self.lock_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
        shard = hashlib.sha256(pid.encode()).hexdigest()[:2]
        with (self.lock_dir / shard).open("ab") as lock:
            deadline = time.monotonic() + 25
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise _session_conflict("图形会话正在处理其他操作，请稍后重试") from None
                    time.sleep(0.05)
            yield self._owned(owner, pid)

    def _status(self, row=None):
        session = None
        if row is not None:
            session = {
                "id": row["session_id"],
                "name": row["source_name"],
                "version": row["base_version"],
                "expires_at": datetime.fromtimestamp(row["expires"], UTC).isoformat(),
                "width": WIDTH,
                "height": HEIGHT,
            }
        return {"enabled": self.sandbox.enabled, "session": session}

    def _discard(self, row):
        pid, sid = row["project_id"], row["session_id"]
        self.sandbox.remove(self._name(pid, sid))
        with self.engine.connection(write=True) as db:
            db.execute("DELETE FROM desktop_sessions WHERE project_id=? AND session_id=?", (pid, sid))

    def _ready(self, pid, sid):
        with self.engine.connection(write=True) as db:
            cursor = db.execute(
                "UPDATE desktop_sessions SET ready=1 WHERE project_id=? AND session_id=?", (pid, sid)
            )
            if cursor.rowcount != 1:
                raise _session_conflict()

    def _running(self, row):
        if row is None:
            return None
        # The project lock is held. A reservation still marked initializing was
        # abandoned by the launcher before the editor could be offered to a client.
        if row["ready"] != 0 and row["expires"] > time.time():
            cid = self.sandbox.find(self._name(row["project_id"], row["session_id"]))
            if cid:
                if row["ready"] is None:
                    self.sandbox.command(cid, "read")
                    self._ready(row["project_id"], row["session_id"])
                return cid
        self._discard(row)
        return None

    def status(self, owner, pid):
        row = self._owned(owner, pid)
        if row is None or not self.sandbox.enabled:
            return self._status()
        with self._locked(owner, pid) as row:
            return self._status(row if self._running(row) else None)

    def start(self, owner, pid, name, version):
        self._owned(owner, pid)
        if not self.sandbox.enabled:
            raise DesktopUnavailable("图形工作区尚未配置本机镜像")
        if type(version) is not int or version < 1:
            raise ValueError("请选择已保存的文件版本")
        name = filename(name)
        with self._locked(owner, pid) as row:
            if self._running(row):
                if row["source_name"].casefold() == name.casefold() and row["base_version"] == version:
                    return self._status(row)
                raise _session_conflict("该项目已有图形会话，请继续编辑或先结束会话")
            with self.engine.connection(write=True) as db:
                self.projects._project(db, owner, pid)
                source = self.projects._file(db, pid, name)
                if source["version"] != version:
                    raise ProjectConflict("项目文件已变化，请刷新版本")
                if (
                    db.execute(
                        "SELECT count(*) FROM desktop_sessions WHERE expires>?", (time.time(),)
                    ).fetchone()[0]
                    >= MAX_SESSIONS
                ):
                    raise _session_conflict("图形会话已达到同时开启的上限")
                sid = uuid4().hex
                db.execute(
                    "INSERT INTO desktop_sessions(project_id,session_id,source_name,base_version,expires,ready) VALUES(?,?,?,?,?,0)",
                    (pid, sid, source["name"], version, time.time() + TTL),
                )
                row = db.execute("SELECT * FROM desktop_sessions WHERE project_id=?", (pid,)).fetchone()
            try:
                self.sandbox.launch(
                    self._name(pid, sid), {"name": source["name"], "content": source["content"]}
                )
                self._ready(pid, sid)
            except (OSError, RuntimeError, ValueError, ProjectConflict):
                # Handles a created container even if its CLI was interrupted before returning an ID.
                self._discard(row)
                raise
            return self._status(row)

    @contextmanager
    def _active(self, owner, pid, sid):
        self._owned(owner, pid)
        if not self.sandbox.enabled:
            raise DesktopUnavailable("图形工作区尚未配置本机镜像")
        with self._locked(owner, pid) as row:
            if row is None or row["session_id"] != sid:
                raise _session_conflict()
            cid = self._running(row)
            if not cid:
                raise _session_conflict()
            yield row, cid

    def screenshot(self, owner, pid, sid):
        with self._active(owner, pid, sid) as (_, cid):
            png = self.sandbox.command(cid, "screenshot")
            if not png.startswith(b"\x89PNG\r\n\x1a\n"):
                raise DesktopUnavailable("桌面截图格式异常")
            return png

    def input(self, owner, pid, sid, event):
        with self._active(owner, pid, sid) as (_, cid):
            self.sandbox.command(cid, "input", _payload(_input_event(event)))

    def save(self, owner, pid, sid, *, target_name=None):
        with self._active(owner, pid, sid) as (row, cid):
            raw = self.sandbox.command(cid, "read")
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                raise DesktopUnavailable("桌面返回的文件编码异常") from None
            validate_text(text)
            original = row["source_name"]
            target = filename(target_name) if target_name is not None else original
            with self.engine.connection(write=True) as db:
                self.projects._project(db, owner, pid)
                if target.casefold() != original.casefold():
                    return self.projects._save(db, pid, target, text, 0)
                try:
                    head = self.projects._file(db, pid, original)
                except KeyError:
                    raise ProjectConflict("原文件已删除，可将桌面内容另存为新文件") from None
                if head["version"] != row["base_version"]:
                    raise ProjectConflict("原文件已更新，可将桌面内容另存为新文件")
                if head["content"] == text:
                    return {k: v for k, v in head.items() if k != "content"}
                meta = self.projects._save(db, pid, original, text, row["base_version"])
                db.execute(
                    "UPDATE desktop_sessions SET base_version=? WHERE project_id=? AND session_id=?",
                    (meta["version"], pid, sid),
                )
                return meta

    def stop(self, owner, pid, sid):
        if self._owned(owner, pid) is None:
            return
        with self._locked(owner, pid) as row:
            if row is None:
                return
            if row["session_id"] != sid:
                raise _session_conflict()
            self._discard(row)

    def delete_project(self, owner, pid):
        if os.name != "posix" and not self.sandbox.enabled and self._owned(owner, pid) is None:
            self.projects.delete(owner, pid)
            return
        with self._locked(owner, pid) as row:
            if row is not None:
                self._discard(row)
            self.projects.delete(owner, pid)
