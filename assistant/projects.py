"""Private project files, version history and explicit transfers to and from office tasks."""

import hashlib
import json
from uuid import uuid4

from .office import filename, validate_text
from .store import checked_text, now

MAX_PROJECTS = 64
MAX_PROJECT_FILES = 128
MAX_FILE_REVISIONS = 64
MAX_PROJECT_BYTES = 8 * 1024 * 1024


class ProjectConflict(Exception):
    """A client attempted to modify a file or use a task run that has changed."""

    def __init__(self, message, *, reason="file_version"):
        super().__init__(message)
        self.reason = reason


SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS project_owner ON projects(owner, updated_at DESC);
CREATE TABLE IF NOT EXISTS project_paths (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name_key TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, name_key)
);
CREATE TABLE IF NOT EXISTS project_revisions (
    project_id TEXT NOT NULL, name_key TEXT NOT NULL, version INTEGER NOT NULL,
    content TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, updated_at TEXT NOT NULL,
    source_task_id TEXT, source_run_id TEXT,
    PRIMARY KEY(project_id, name_key, version),
    FOREIGN KEY(project_id, name_key) REFERENCES project_paths(project_id, name_key) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS project_revision_floors (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_tasks (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    inputs TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS project_tasks_by_project ON project_tasks(project_id);
"""

_FILE_META = """p.name, r.version, r.size_bytes, r.sha256, p.created_at, r.updated_at,
                 r.source_task_id, r.source_run_id"""
_FILE_JOIN = """FROM project_paths p JOIN project_revisions r
                ON (p.project_id,p.name_key)=(r.project_id,r.name_key)"""
_PROJECT = "SELECT id,name,created_at,updated_at FROM projects"
_STALE = "文件版本已变化，请刷新后重试"


def _version(value):
    if type(value) is not int or not 0 <= value <= 2**63 - 1:
        raise ValueError("版本号必须是非负整数")
    return value


class Projects:
    def __init__(self, engine):
        self.engine = engine
        with engine.connection() as db:
            db.executescript(SCHEMA)
        # Older databases kept a path record for each deleted file. Compact them safely.
        with engine.connection(write=True) as db:
            removed = """NOT EXISTS(SELECT 1 FROM project_revisions r
                         WHERE r.project_id=p.project_id AND r.name_key=p.name_key)"""
            db.execute(f"""INSERT INTO project_revision_floors
                           SELECT p.project_id, MAX(p.version) FROM project_paths p
                           WHERE {removed} GROUP BY p.project_id
                           ON CONFLICT(project_id) DO UPDATE SET version=MAX(version,excluded.version)""")
            db.execute(f"DELETE FROM project_paths AS p WHERE {removed}")

    @staticmethod
    def _project(db, owner, pid):
        row = db.execute(_PROJECT + " WHERE id=? AND owner=?", (pid, owner)).fetchone()
        if row is None:
            raise KeyError("项目不存在")
        return dict(row)

    def create(self, owner, name):
        name = checked_text(name, "项目名称", 100)
        pid, stamp = uuid4().hex, now()
        with self.engine.connection(write=True) as db:
            if (
                db.execute("SELECT COUNT(*) FROM projects WHERE owner=?", (owner,)).fetchone()[0]
                >= MAX_PROJECTS
            ):
                raise ValueError(f"工作区最多可保存 {MAX_PROJECTS} 个项目，请先删除无需保留的项目")
            db.execute("INSERT INTO projects VALUES(?,?,?,?,?)", (pid, owner, name, stamp, stamp))
            return self._project(db, owner, pid)

    def list(self, owner):
        with self.engine.connection() as db:
            return [
                dict(row)
                for row in db.execute(_PROJECT + " WHERE owner=? ORDER BY updated_at DESC,id", (owner,))
            ]

    def get(self, owner, pid):
        with self.engine.connection() as db:
            db.execute("BEGIN")
            project = self._project(db, owner, pid)
            project["files"] = [
                dict(row)
                for row in db.execute(
                    f"SELECT {_FILE_META} {_FILE_JOIN} WHERE p.project_id=? AND p.version=r.version ORDER BY p.name_key",
                    (pid,),
                )
            ]
            rows = db.execute(
                """SELECT t.id,t.prompt,t.kind,t.run_id,CASE WHEN t.paused THEN 'paused' ELSE t.status END AS status,
                          pt.inputs
                   FROM project_tasks pt JOIN tasks t ON t.id=pt.task_id
                   WHERE pt.project_id=? AND t.owner=? ORDER BY t.created DESC""",
                (pid, owner),
            )
            project["tasks"] = [{**row, "inputs": json.loads(row["inputs"])} for row in rows]
            return project

    def delete(self, owner, pid):
        with self.engine.connection(write=True) as db:
            if not db.execute("DELETE FROM projects WHERE id=? AND owner=?", (pid, owner)).rowcount:
                raise KeyError("项目不存在")

    @staticmethod
    def _file(db, pid, name, version=None):
        predicate = "p.version=r.version" if version is None else "r.version=?"
        args = [pid, filename(name).casefold()]
        if version is not None:
            args.append(_version(version))
        row = db.execute(
            f"SELECT {_FILE_META},r.content {_FILE_JOIN} WHERE p.project_id=? AND p.name_key=? AND {predicate}",
            args,
        ).fetchone()
        if row is None:
            raise KeyError("文件或版本不存在")
        return dict(row)

    def file(self, owner, pid, name, version=None):
        with self.engine.connection() as db:
            db.execute("BEGIN")
            self._project(db, owner, pid)
            return self._file(db, pid, name, version)

    def history(self, owner, pid, name):
        with self.engine.connection() as db:
            db.execute("BEGIN")
            self._project(db, owner, pid)
            rows = db.execute(
                f"SELECT {_FILE_META} {_FILE_JOIN} WHERE p.project_id=? AND p.name_key=? ORDER BY r.version DESC",
                (pid, filename(name).casefold()),
            )
            history = [dict(row) for row in rows]
            if not history:
                raise KeyError("文件不存在")
            return history

    @staticmethod
    def _save(db, pid, name, content, expected, task_id=None, run_id=None):
        name_key = filename(name).casefold()
        validate_text(content)
        expected = _version(expected)
        body = content.encode("utf-8")
        digest = hashlib.sha256(body).hexdigest()
        head = db.execute(
            "SELECT name,version,created_at FROM project_paths WHERE project_id=? AND name_key=?",
            (pid, name_key),
        ).fetchone()
        current = head["version"] if head else 0
        if current != expected:
            raise ProjectConflict(_STALE)
        usage = db.execute(
            """SELECT COALESCE(SUM(size_bytes),0), COUNT(CASE WHEN name_key=? THEN 1 END)
               FROM project_revisions WHERE project_id=?""",
            (name_key, pid),
        ).fetchone()
        if usage[1] >= MAX_FILE_REVISIONS:
            raise ValueError(f"每个文件最多保留 {MAX_FILE_REVISIONS} 个版本，请另存新文件或导出后删除旧文件")
        if usage[0] + len(body) > MAX_PROJECT_BYTES:
            raise ValueError(
                f"项目各版本的正文总量上限为 {MAX_PROJECT_BYTES} 字节，请先导出并删除无需保留的文件"
            )
        stamp = now()
        if head:
            created, name = head["created_at"], head["name"]
            next_version = current + 1
        else:
            if (
                db.execute("SELECT COUNT(*) FROM project_paths WHERE project_id=?", (pid,)).fetchone()[0]
                >= MAX_PROJECT_FILES
            ):
                raise ValueError(f"每个项目最多保留 {MAX_PROJECT_FILES} 个文件，请先删除无需保留的文件")
            floor = db.execute(
                "SELECT version FROM project_revision_floors WHERE project_id=?", (pid,)
            ).fetchone()
            next_version = (floor["version"] if floor else 0) + 1
            created = stamp
        db.execute(
            """INSERT INTO project_paths VALUES(?,?,?,?,?) ON CONFLICT(project_id,name_key)
                      DO UPDATE SET name=excluded.name,version=excluded.version,created_at=excluded.created_at""",
            (pid, name_key, name, next_version, created),
        )
        db.execute(
            "INSERT INTO project_revisions VALUES(?,?,?,?,?,?,?,?,?)",
            (pid, name_key, next_version, content, len(body), digest, stamp, task_id, run_id),
        )
        db.execute("UPDATE projects SET updated_at=? WHERE id=?", (stamp, pid))
        return {
            "name": name,
            "version": next_version,
            "size_bytes": len(body),
            "sha256": digest,
            "created_at": created,
            "updated_at": stamp,
            "source_task_id": task_id,
            "source_run_id": run_id,
        }

    def write(self, owner, pid, name, content, expected_version):
        with self.engine.connection(write=True) as db:
            self._project(db, owner, pid)
            return self._save(db, pid, name, content, expected_version)

    def delete_file(self, owner, pid, name, expected_version):
        with self.engine.connection(write=True) as db:
            self._project(db, owner, pid)
            current = self._file(db, pid, name)
            if current["version"] != _version(expected_version):
                raise ProjectConflict(_STALE)
            # One watermark per project prevents ABA even after removing the pathname and all its revisions.
            db.execute(
                """INSERT INTO project_revision_floors VALUES(?,?)
                          ON CONFLICT(project_id) DO UPDATE SET version=MAX(version,excluded.version)""",
                (pid, current["version"]),
            )
            db.execute("DELETE FROM project_paths WHERE project_id=? AND name_key=?", (pid, name.casefold()))
            db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now(), pid))

    def snapshot(self, db, owner, pid, selections):
        """Resolve pinned input versions inside TaskQueue.create's write transaction."""
        self._project(db, owner, pid)
        if not isinstance(selections, list) or len(selections) > 4:
            raise ValueError("每个任务最多可选 4 个项目文件")
        result = []
        seen = set()
        for entry in selections:
            if not isinstance(entry, dict) or set(entry) != {"name", "version"}:
                raise ValueError("所选项目文件需要名称和版本号")
            version = _version(entry["version"])
            current = self._file(db, pid, entry["name"])
            if not version or current["version"] != version:
                raise ProjectConflict(_STALE)
            name = current["name"]
            if name.casefold() in seen:
                raise ValueError("所选项目文件不可重名")
            seen.add(name.casefold())
            result.append({"name": name, "content": current["content"]})
        return result

    def attach(self, db, owner, pid, tid, selections):
        """Record the links after the task and its input copies have been inserted."""
        self._project(db, owner, pid)
        if not db.execute("SELECT 1 FROM tasks WHERE id=? AND owner=?", (tid, owner)).fetchone():
            raise KeyError("任务不存在")
        db.execute(
            "INSERT INTO project_tasks VALUES(?,?,?)", (tid, pid, json.dumps(selections, ensure_ascii=False))
        )
        db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now(), pid))

    @staticmethod
    def task_links(db, owner):
        rows = db.execute(
            """SELECT t.id,pt.project_id,pt.inputs FROM project_tasks pt
                             JOIN tasks t ON t.id=pt.task_id JOIN projects p ON p.id=pt.project_id
                             WHERE t.owner=? AND p.owner=?""",
            (owner, owner),
        )
        return {
            r["id"]: {"project_id": r["project_id"], "project_files": json.loads(r["inputs"])} for r in rows
        }

    @staticmethod
    def publishable(db, owner, tid, run_id):
        rows = db.execute(
            """SELECT DISTINCT f.name
               FROM tasks t JOIN office_files f ON f.task_id=t.id
               JOIN office_steps s ON s.task_id=t.id AND s.run_id=t.run_id
               WHERE t.id=? AND t.owner=? AND t.kind='office' AND t.status='completed' AND t.run_id=?
                 AND s.result IS NOT NULL AND json_extract(s.action,'$.action')='write_file'
                 AND json_extract(s.action,'$.name')=f.name""",
            (tid, owner, run_id),
        )
        return {r["name"] for r in rows}

    def publish(self, owner, pid, tid, source_name, target_name, expected_version, *, source_run_id=None):
        """Copy an output from a completed office run while holding a single write snapshot."""
        with self.engine.connection(write=True) as db:
            self._project(db, owner, pid)
            task = db.execute(
                "SELECT kind,status,run_id FROM tasks WHERE id=? AND owner=?", (tid, owner)
            ).fetchone()
            if not task:
                raise KeyError("任务不存在")
            if task["kind"] != "office" or task["status"] != "completed":
                raise ProjectConflict("只能发布已完成的文件工作任务成果", reason="task_status")
            run = task["run_id"]
            if source_run_id is not None and source_run_id != run:
                raise ProjectConflict("任务轮次已变化，请刷新后重试", reason="task_run")
            source = filename(source_name)
            if source not in self.publishable(db, owner, tid, run):
                raise KeyError("本轮没有生成此文件")
            output = db.execute(
                "SELECT content FROM office_files WHERE task_id=? AND name=?", (tid, source)
            ).fetchone()
            return self._save(db, pid, target_name, output["content"], expected_version, tid, run)
