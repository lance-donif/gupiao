import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from assistant.engine import Engine
from assistant.projects import ProjectConflict
from assistant.tasks import TaskQueue


class Writer:
    def complete(self, messages, *, response_format):
        return json.dumps({"action": "write_file", "name": "result.md", "text": "# 已交付"})


@pytest.fixture
def queue(tmp_path):
    return TaskQueue(Engine(tmp_path / "shared.sqlite", Writer(), None))


def test_revisions_compare_and_swap_and_purge(queue):
    projects = queue.projects
    project = projects.create("alice", " 我的项目 ")
    pid = project["id"]
    assert projects.list("alice")[0]["name"] == "我的项目"
    v1 = projects.write("alice", pid, "Plan.md", "第一行\r\n", 0)
    v2 = projects.write("alice", pid, "PLAN.md", "第二稿", v1["version"])
    assert v2["name"] == "Plan.md"
    assert v1["created_at"] == v2["created_at"] and v1["updated_at"] <= v2["updated_at"]
    assert [r["version"] for r in projects.history("alice", pid, "Plan.md")] == [2, 1]
    assert projects.file("alice", pid, "plan.md", 1)["content"] == "第一行\r\n"
    assert projects.file("alice", pid, "plan.md")["content"] == "第二稿"

    with pytest.raises(ProjectConflict):
        projects.delete_file("alice", pid, "Plan.md", 1)
    projects.delete_file("alice", pid, "Plan.md", 2)
    assert not projects.get("alice", pid)["files"]
    with pytest.raises(KeyError):
        projects.file("alice", pid, "Plan.md", 1)
    v3 = projects.write("alice", pid, "plan.md", "重新建立", 0)
    assert v3["version"] == 3
    with pytest.raises(ProjectConflict):
        projects.write("alice", pid, "Plan.md", "过时的覆盖", 2)
    assert len(projects.history("alice", pid, "Plan.md")) == 1
    projects.delete("alice", pid)
    with queue.engine.connection() as db:
        assert db.execute("SELECT count(*) FROM project_paths").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM project_revisions").fetchone()[0] == 0


def test_concurrent_edit_only_one_wins(queue):
    projects = queue.projects
    pid = projects.create("alice", "并发")["id"]
    projects.write("alice", pid, "金额.txt", "0", 0)
    ready = Barrier(2)

    def edit(value):
        ready.wait(timeout=5)
        try:
            return projects.write("alice", pid, "金额.txt", value, 1)
        except ProjectConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        rows = list(pool.map(edit, ["1", "2"]))
    assert sum(bool(row) for row in rows) == 1
    assert projects.get("alice", pid)["files"][0]["version"] == 2


def test_snapshot_and_receipt_survive_edits_and_project_deletion(queue):
    projects = queue.projects
    pid = projects.create("alice", "收入研究")["id"]
    source = "地区,收入\r\n北京,22\r\n"
    projects.write("alice", pid, "输入.csv", source, 0)
    selected = [{"name": "输入.csv", "version": 1}]
    options = {"kind": "office", "project_id": pid, "project_files": selected, "request_id": "request1"}
    task = queue.create("alice", "创建 result.md", **options)
    tid = task["id"]
    projects.write("alice", pid, "输入.csv", "地区,收入\n上海,60", 1)

    assert queue.office.read("alice", tid, "输入.csv") == source
    assert queue.create("alice", "创建 result.md", **options)["id"] == tid
    assert projects.get("alice", pid)["tasks"][0]["inputs"] == selected
    assert queue.get("alice", tid)["project_files"] == selected
    links = queue.list("alice")[0]
    assert links["project_id"] == pid and links["project_files"] == selected
    with pytest.raises(ProjectConflict):
        queue.create("alice", "新任务", **{**options, "request_id": "request2"})
    with pytest.raises(ValueError):
        queue.create(
            "alice",
            "重复文件",
            kind="office",
            project_id=pid,
            project_files=[{"name": "输入.csv", "version": 2}],
            files=[{"name": "输入.csv", "content": "重名"}],
        )
    assert len(queue.list("alice")) == len(queue.engine.conversations("alice")) == 1
    projects.delete("alice", pid)
    assert queue.get("alice", tid)["project_id"] is None
    assert queue.office.read("alice", tid, "输入.csv") == source


def test_publish_verifies_completed_run_then_keeps_independent_copy(queue):
    projects = queue.projects
    pid = projects.create("alice", "成果")["id"]
    projects.write("alice", pid, "input.md", "材料", 0)
    task = queue.create(
        "alice",
        "创建 result.md",
        kind="office",
        project_id=pid,
        project_files=[{"name": "input.md", "version": 1}],
    )
    tid, run = task["id"], task["run_id"]
    with pytest.raises(ProjectConflict):
        projects.publish("alice", pid, tid, "result.md", "交付.md", 0, source_run_id=run)
    assert queue.run_one() and queue.get("alice", tid)["status"] == "completed"
    with pytest.raises(KeyError):
        projects.publish("alice", pid, tid, "input.md", "交付.md", 0, source_run_id=run)
    with pytest.raises(ProjectConflict):
        projects.publish("alice", pid, tid, "result.md", "交付.md", 0, source_run_id="old")

    rev = projects.publish("alice", pid, tid, "result.md", "交付.md", 0, source_run_id=run)
    assert rev["source_task_id"] == tid and rev["source_run_id"] == run
    assert rev["sha256"] == hashlib.sha256("# 已交付".encode()).hexdigest()
    with pytest.raises(ProjectConflict):
        projects.publish("alice", pid, tid, "result.md", "交付.md", 0)
    # A new run reuses the workspace, but a leftover file alone isn't a new output.
    with queue.engine.connection(write=True) as db:
        db.execute("UPDATE tasks SET run_id='new-completed-run' WHERE id=?", (tid,))
    with pytest.raises(KeyError):
        projects.publish("alice", pid, tid, "result.md", "交付.md", 1, source_run_id="new-completed-run")
    queue.change("alice", tid, "delete")
    assert projects.file("alice", pid, "交付.md")["content"] == "# 已交付"
    assert projects.get("alice", pid)["tasks"] == []


def test_all_project_data_and_task_transfers_are_owner_scoped(queue):
    projects = queue.projects
    pid = projects.create("alice", "个人")["id"]
    projects.write("alice", pid, "notes.txt", "保密", 0)
    other = projects.create("bob", "另一个")["id"]
    task = queue.create("alice", "创建 result.md", kind="office")
    assert queue.run_one()
    for call in [
        lambda: projects.get("bob", pid),
        lambda: projects.delete("bob", pid),
        lambda: projects.file("bob", pid, "notes.txt"),
        lambda: projects.history("bob", pid, "notes.txt"),
        lambda: projects.write("bob", pid, "notes.txt", "覆盖", 1),
        lambda: projects.delete_file("bob", pid, "notes.txt", 1),
        lambda: queue.create(
            "bob",
            "创建 result.md",
            kind="office",
            project_id=pid,
            project_files=[{"name": "notes.txt", "version": 1}],
        ),
        lambda: projects.publish("bob", other, task["id"], "result.md", "steal.md", 0),
    ]:
        with pytest.raises(KeyError):
            call()
    assert [p["id"] for p in projects.list("bob")] == [other]
    assert not queue.list("bob")
    assert projects.file("alice", pid, "notes.txt")["content"] == "保密"


@pytest.mark.parametrize(
    ("name", "content", "expected"),
    [
        ("../notes.md", "ok", 0),
        ("notes.jpg", "ok", 0),
        ("notes.md", "a\x00", 0),
        ("notes.md", "大" * 8193, 0),
        ("notes.md", "ok", -1),
        ("notes.md", "ok", True),
    ],
)
def test_invalid_project_file_edits_are_atomic(queue, name, content, expected):
    projects = queue.projects
    pid = projects.create("alice", "文件")["id"]
    with pytest.raises(ValueError):
        projects.write("alice", pid, name, content, expected)
    assert projects.get("alice", pid)["files"] == []


def test_project_and_file_limits_are_atomic_and_deletion_releases_slots(queue, monkeypatch):
    monkeypatch.setattr("assistant.projects.MAX_PROJECTS", 1)
    monkeypatch.setattr("assistant.projects.MAX_PROJECT_FILES", 1)
    projects = queue.projects
    pid = projects.create("alice", "文件")["id"]
    with pytest.raises(ValueError, match="工作区最多"):
        projects.create("alice", "额外")
    assert projects.create("bob", "另一个账号")
    ready = Barrier(2)

    def save(name):
        ready.wait(timeout=5)
        try:
            return projects.write("alice", pid, name, "内容", 0)
        except ValueError as exc:
            assert "最多保留 1 个文件" in str(exc)
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        rows = list(pool.map(save, ["a.txt", "b.txt"]))
    assert sum(bool(row) for row in rows) == 1
    winner = next(row for row in rows if row)
    projects.delete_file("alice", pid, winner["name"], winner["version"])
    later = projects.write("alice", pid, "c.txt", "新文件", 0)
    assert later["version"] > winner["version"]
    projects.delete("alice", pid)
    assert projects.create("alice", "新项目")


def test_revision_and_byte_caps_preserve_history_and_block_publish(queue, monkeypatch):
    monkeypatch.setattr("assistant.projects.MAX_FILE_REVISIONS", 2)
    monkeypatch.setattr("assistant.projects.MAX_PROJECT_BYTES", 7)
    projects = queue.projects
    pid = projects.create("alice", "小容量")["id"]
    projects.write("alice", pid, "A.md", "中", 0)
    projects.write("alice", pid, "A.md", "en", 1)
    with pytest.raises(ValueError, match="最多保留 2 个版本"):
        projects.write("alice", pid, "A.md", "x", 2)
    assert projects.file("alice", pid, "A.md", 1)["content"] == "中"
    projects.write("alice", pid, "B.txt", "ab", 0)
    with pytest.raises(ValueError, match="正文总量"):
        projects.write("alice", pid, "C.txt", "x", 0)
    # Existing revision content consumes space even after updating a file.
    monkeypatch.setattr("assistant.projects.MAX_PROJECT_BYTES", 10)
    task = queue.create("alice", "创建 result.md", kind="office")
    assert queue.run_one()
    with pytest.raises(ValueError, match="正文总量"):
        projects.publish("alice", pid, task["id"], "result.md", "new.md", 0)
    projects.delete_file("alice", pid, "A.md", 2)
    restored = projects.write("alice", pid, "A.md", "again", 0)
    assert restored["version"] == 3
    assert len(projects.history("alice", pid, "A.md")) == 1


def test_preexisting_deletion_markers_compact_without_reusing_old_versions(queue):
    projects = queue.projects
    pid = projects.create("alice", "迁移")["id"]
    with queue.engine.connection(write=True) as db:
        db.execute("INSERT INTO project_paths VALUES(?,?,?,?,?)", (pid, "old.md", "old.md", 9, "past"))
        db.execute("INSERT INTO project_paths VALUES(?,?,?,?,?)", (pid, "older.md", "older.md", 4, "past"))
    # Simulate a restart of an instance whose previous schema retained deleted paths.
    projects = type(projects)(queue.engine)
    with queue.engine.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM project_paths WHERE project_id=?", (pid,)).fetchone()[0] == 0
    current = projects.write("alice", pid, "old.md", "重新建立", 0)
    assert current["version"] == 10
    with pytest.raises(ProjectConflict):
        projects.write("alice", pid, "old.md", "过时", 9)
