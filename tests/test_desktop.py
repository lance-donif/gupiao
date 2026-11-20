import json
import os
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from assistant import desktop
from assistant.desktop import Desktop, DesktopUnavailable, DockerEditor
from assistant.engine import Engine
from assistant.projects import ProjectConflict
from assistant.tasks import TaskQueue


class Editor:
    enabled = True

    def __init__(self):
        self.windows = {}
        self.calls = []
        self.fail_launch = False

    def launch(self, name, file):
        self.calls.append(("launch", name))
        self.windows[name] = file["content"]
        if self.fail_launch:
            raise DesktopUnavailable("启动失败")

    def find(self, name, *, running=True):
        self.calls.append(("find", name))
        return name if name in self.windows else None

    def remove(self, name):
        self.calls.append(("remove", name))
        self.windows.pop(name, None)

    def command(self, cid, op, data=b""):
        self.calls.append((op, cid))
        if op == "screenshot":
            return b"\x89PNG\r\n\x1a\nscreen"
        if op == "read":
            return self.windows[cid].encode()
        if op == "input" and (event := json.loads(data))["type"] == "text":
            self.windows[cid] += event["text"]
        return b'{"ok":true}'


@pytest.fixture
def room(tmp_path):
    engine = Engine(tmp_path / "echo.sqlite", None, None)
    projects = TaskQueue(engine).projects
    d = Desktop(projects, sandbox=Editor())
    pid = projects.create("alice", "项目")["id"]
    projects.write("alice", pid, "初稿.md", "草稿", 0)
    return d, projects, pid


def test_open_edit_reconnect_save_and_stop(room):
    d, projects, pid = room
    before = d.status("alice", pid)
    assert before == {"enabled": True, "session": None} and d.sandbox.calls == []
    with ThreadPoolExecutor(max_workers=4) as pool:
        sessions = list(pool.map(lambda _: d.start("alice", pid, "初稿.md", 1), range(4)))
    sid = sessions[0]["session"]["id"]
    assert all(s == sessions[0] for s in sessions)
    assert len(d.sandbox.windows) == 1
    assert [c[0] for c in d.sandbox.calls].count("launch") == 1
    assert d.save("alice", pid, sid)["version"] == 1
    d.input("alice", pid, sid, {"type": "text", "text": "，已确认。"})
    assert d.screenshot("alice", pid, sid).startswith(b"\x89PNG")
    reopened = Desktop(projects, sandbox=d.sandbox)
    assert reopened.status("alice", pid) == sessions[0]
    assert reopened.save("alice", pid, sid)["version"] == 2
    assert d.status("alice", pid)["session"]["version"] == 2
    assert projects.file("alice", pid, "初稿.md")["content"] == "草稿，已确认。"
    d.stop("alice", pid, sid)
    d.stop("alice", pid, sid)
    assert d.status("alice", pid) == before and not d.sandbox.windows
    next_id = d.start("alice", pid, "初稿.md", 2)["session"]["id"]
    assert next_id != sid
    for action in [
        lambda: d.stop("alice", pid, sid),
        lambda: d.screenshot("alice", pid, sid),
        lambda: d.save("alice", pid, sid),
        lambda: d.input("alice", pid, sid, {"type": "key", "key": "Home"}),
    ]:
        with pytest.raises(ProjectConflict) as conflict:
            action()
        assert conflict.value.reason == "desktop_session"
    assert d.status("alice", pid)["session"]["id"] == next_id


def test_conflict_save_new_copy_and_version_pinning(room):
    d, projects, pid = room
    with pytest.raises(ProjectConflict):
        d.start("alice", pid, "初稿.md", 2)
    assert not d.sandbox.calls
    sid = d.start("alice", pid, "初稿.md", 1)["session"]["id"]
    projects.write("alice", pid, "初稿.md", "手机修改", 1)
    with pytest.raises(ProjectConflict) as active:
        d.start("alice", pid, "初稿.md", 2)
    assert active.value.reason == "desktop_session"
    with pytest.raises(ProjectConflict) as conflict:
        d.save("alice", pid, sid)
    assert conflict.value.reason == "file_version"
    assert d.save("alice", pid, sid, target_name="桌面副本.md")["version"] == 1
    assert projects.file("alice", pid, "桌面副本.md")["content"] == "草稿"
    assert projects.file("alice", pid, "初稿.md")["content"] == "手机修改"
    with pytest.raises(ProjectConflict):
        d.save("alice", pid, sid, target_name="桌面副本.md")
    projects.delete_file("alice", pid, "初稿.md", 2)
    with pytest.raises(ProjectConflict, match="删除"):
        d.save("alice", pid, sid)
    assert d.status("alice", pid)["session"]["name"] == "初稿.md"


def test_owner_isolation_and_deletion_cleanup(room):
    d, _, pid = room
    sid = d.start("alice", pid, "初稿.md", 1)["session"]["id"]
    previous = list(d.sandbox.calls)
    for action in [
        lambda: d.status("bob", pid),
        lambda: d.start("bob", pid, "初稿.md", 1),
        lambda: d.save("bob", pid, sid),
        lambda: d.screenshot("bob", pid, sid),
        lambda: d.input("bob", pid, sid, {"type": "text", "text": "写"}),
        lambda: d.stop("bob", pid, sid),
        lambda: d.delete_project("bob", pid),
    ]:
        with pytest.raises(KeyError):
            action()
    assert d.sandbox.calls == previous
    d.delete_project("alice", pid)
    assert not d.sandbox.windows
    with pytest.raises(KeyError):
        d.status("alice", pid)


def test_lifecycle_failure_expiry_and_capacity(room, monkeypatch):
    d, projects, pid = room
    d.sandbox.fail_launch = True
    with pytest.raises(DesktopUnavailable):
        d.start("alice", pid, "初稿.md", 1)
    assert d.status("alice", pid)["session"] is None and not d.sandbox.windows
    monkeypatch.setattr(desktop, "MAX_SESSIONS", 1)
    d.sandbox.fail_launch = False
    d.start("alice", pid, "初稿.md", 1)
    p2 = projects.create("alice", "项目2")["id"]
    projects.write("alice", p2, "计划.md", "2", 0)
    with pytest.raises(ProjectConflict, match="上限"):
        d.start("alice", p2, "计划.md", 1)
    with d.engine.connection(write=True) as db:
        db.execute("UPDATE desktop_sessions SET expires=? WHERE project_id=?", (time.time() - 1, pid))
    assert d.status("alice", pid)["session"] is None and not d.sandbox.windows
    d.start("alice", p2, "计划.md", 1)
    d.sandbox.windows.clear()  # externally removed / daemon restarted
    assert d.status("alice", p2)["session"] is None


@pytest.mark.parametrize(
    "event",
    [
        {"type": "key", "key": "ctrl+alt+t"},
        {"type": "click", "x": True, "y": 2},
        {"type": "click", "x": 1000, "y": 25},
        {"type": "click", "x": 10, "y": 650},
        {"type": "text", "text": "\x00"},
        {"type": "text", "text": "长" * 9000},
        {"type": "text", "text": "文本", "command": "whoami"},
        None,
    ],
)
def test_input_validation(room, event):
    d, _, pid = room
    sid = d.start("alice", pid, "初稿.md", 1)["session"]["id"]
    with pytest.raises(ValueError):
        d.input("alice", pid, sid, event)
    assert not any(cmd == "input" for cmd, _ in d.sandbox.calls)


def test_disabled_requires_no_daemon(room, monkeypatch):
    _, projects, pid = room
    monkeypatch.delenv("ECHO_DESKTOP_IMAGE_ID", raising=False)
    monkeypatch.setattr(desktop, "_docker", lambda *a, **kw: pytest.fail("unexpected Docker access"))
    d = Desktop(projects)
    assert d.status("alice", pid) == {"enabled": False, "session": None}
    with pytest.raises(DesktopUnavailable):
        d.start("alice", pid, "初稿.md", 1)
    d.delete_project("alice", pid)
    monkeypatch.setenv("ECHO_DESKTOP_IMAGE_ID", "foo:latest")
    with pytest.raises(ValueError):
        DockerEditor()


def test_fixed_docker_invocation_and_labels(monkeypatch):
    calls = []
    cid = "b" * 64
    image = "sha256:" + "a" * 64
    monkeypatch.setenv("ECHO_DESKTOP_IMAGE_ID", image)

    def docker(cmd, data=b"", **kwargs):
        calls.append((cmd, data))
        return (cid + "\n").encode() if cmd[0] in {"run", "ps"} else b"{}"

    monkeypatch.setattr(desktop, "_docker", docker)
    box = DockerEditor()
    box.launch("echo-desktop-unique", {"name": "文档.md", "content": "内容$(TEST)"})
    cmd, _ = calls[0]
    assert cmd[-1] == image
    assert {
        "--pull=never",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user=10001:10001",
        "--rm",
        "--pids-limit=32",
        "--memory=192m",
    }.issubset(cmd)
    assert not any(x in cmd for x in ("-v", "--mount", "--volume", "--privileged"))
    cmd, data = calls[1]
    assert cmd == ["exec", "-i", cid, *desktop.WORKER, "init"]
    assert json.loads(data)["content"] == "内容$(TEST)"
    box.remove("echo-desktop-unique")
    assert calls[-2][0][-1] == "label=io.echo.editor=echo-desktop-unique"
    assert calls[-1][0] == ["rm", "-f", cid]


def test_cli_secret_isolation(tmp_path, monkeypatch):
    binary = tmp_path / "docker"
    binary.write_text('#!/bin/sh\nprintf \'%s|%s|%s\' "$1" "$MODEL_API_KEY" "$DOCKER_CONFIG"')
    binary.chmod(0o700)
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setenv("MODEL_API_KEY", "ignored")
    monkeypatch.setenv("DOCKER_HOST", "tcp://example.org")
    args, secret, config = desktop._docker(["noop"]).decode().split("|")
    assert args == "--host=unix:///var/run/docker.sock" and secret == ""
    assert not os.path.exists(config)


@pytest.mark.parametrize("created", [False, True])
def test_crashed_launcher_releases_incomplete_reservation_and_window(room, monkeypatch, created):
    d, projects, pid = room
    launch = d.sandbox.launch

    def crash(name, file):
        if created:
            launch(name, file)
        raise SystemExit("abrupt launcher exit")

    monkeypatch.setattr(d.sandbox, "launch", crash)
    with pytest.raises(SystemExit):
        d.start("alice", pid, "初稿.md", 1)
    assert bool(d.sandbox.windows) == created
    with d.engine.connection() as db:
        row = db.execute("SELECT session_id, ready FROM desktop_sessions").fetchone()
        assert row["ready"] == 0
    monkeypatch.setattr(d.sandbox, "launch", launch)
    restart = Desktop(projects, sandbox=d.sandbox)
    assert restart.status("alice", pid)["session"] is None
    assert not d.sandbox.windows
    sid = restart.start("alice", pid, "初稿.md", 1)["session"]["id"]
    assert sid != row["session_id"]
    assert restart.status("alice", pid)["session"]["id"] == sid


def test_upgrade_keeps_initialized_graphical_editor_and_its_unsaved_data(room):
    d, projects, pid = room
    old = d.start("alice", pid, "初稿.md", 1)
    sid = old["session"]["id"]
    d.input("alice", pid, sid, {"type": "text", "text": "，未保存的修改"})
    with d.engine.connection(write=True) as db:
        db.execute("ALTER TABLE desktop_sessions DROP COLUMN ready")
    upgraded = Desktop(projects, sandbox=d.sandbox)
    assert upgraded.status("alice", pid) == old
    with d.engine.connection() as db:
        assert db.execute("SELECT ready FROM desktop_sessions").fetchone()[0] == 1
    upgraded.save("alice", pid, sid)
    assert projects.file("alice", pid, "初稿.md")["content"] == "草稿，未保存的修改"
