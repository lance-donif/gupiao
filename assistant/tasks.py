"""Durable single-host research and writing jobs. Each run produces a Markdown artifact."""

import hashlib
import json
import logging
import threading
import time
from datetime import UTC, datetime
from uuid import uuid4

from .office import Office
from .store import ConversationBusy, checked_text
from .workflow import ResearchWorkflow

logger = logging.getLogger(__name__)
PERIOD = {"once": None, "daily": 86400, "weekly": 604800}
TASK_SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    prompt TEXT NOT NULL,
    kind TEXT NOT NULL,
    frequency TEXT NOT NULL,
    status TEXT NOT NULL,
    run_id TEXT NOT NULL,
    next_run REAL,
    claimed REAL,
    paused INTEGER NOT NULL DEFAULT 0,
    activity TEXT NOT NULL DEFAULT '[]',
    artifact TEXT,
    last_error TEXT,
    created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS task_due ON tasks(status, next_run);
CREATE TABLE IF NOT EXISTS task_requests (
    owner TEXT NOT NULL,
    request_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    PRIMARY KEY(owner, request_id)
);
"""


class PausedJob(Exception):
    pass


def public(row):
    due = row["next_run"]
    return {
        **{key: row[key] for key in ("id", "conversation_id", "prompt", "kind", "frequency", "last_error")},
        "status": "paused" if row["paused"] else row["status"],
        "activity": json.loads(row["activity"]),
        "files": [],
        "has_artifact": row["artifact"] is not None,
        "next_run_at": datetime.fromtimestamp(due, UTC).isoformat() if due is not None else None,
    }


class TaskQueue:
    def __init__(self, engine):
        self.engine = engine
        self.stop_event = threading.Event()
        self.thread = None
        with engine.connection() as db:
            db.executescript(TASK_SCHEMA)
        self.office = Office(engine)
        self.research = ResearchWorkflow(engine)

    def create(self, owner, prompt, frequency="once", kind="research", *, request_id=None, files=None):
        prompt = checked_text(prompt, "任务说明", 4000)
        if frequency not in PERIOD or kind not in {"draft", "research", "office"}:
            raise ValueError("无效的任务设置")
        if files and kind != "office":
            raise ValueError("输入文件仅适用于文件工作任务")
        receipt_type = "create"
        if files and request_id is not None:
            payload = json.dumps(files, ensure_ascii=False, sort_keys=True).encode()
            receipt_type += ":" + hashlib.sha256(payload).hexdigest()
        with self.engine.connection(write=True) as db:
            if request_id is not None:
                old = self._request(db, owner, request_id, receipt_type)
                if old:
                    if (old["prompt"], old["kind"], old["frequency"]) != (prompt, kind, frequency):
                        raise ValueError("该请求编号已用于其他任务")
                    return public(old)
            if db.execute("SELECT count(*) FROM tasks WHERE owner=?", (owner,)).fetchone()[0] >= 64:
                raise ValueError("最多可保存 64 个任务")
            conversation = self.engine._create(db, owner, "任务 · " + prompt[:48])
            tid = uuid4().hex
            stamp = time.time()
            db.execute(
                """INSERT INTO tasks(id,conversation_id,owner,prompt,kind,frequency,status,run_id,next_run,created)
                   VALUES(?,?,?,?,?,?,'queued',?,?,?)""",
                (tid, conversation["id"], owner, prompt, kind, frequency, uuid4().hex, stamp, stamp),
            )
            if files:
                self.office.seed(db, tid, files)
            if request_id is not None:
                db.execute(
                    "INSERT INTO task_requests VALUES (?,?,?,?)", (owner, request_id, tid, receipt_type)
                )
            return public(self._get(db, owner, tid))

    def _request(self, db, owner, request_id, action):
        checked_text(request_id, "请求编号", 160)
        receipt = db.execute(
            "SELECT * FROM task_requests WHERE owner=? AND request_id=?", (owner, request_id)
        ).fetchone()
        if receipt:
            if receipt["action"] != action:
                raise ValueError("该请求编号已用于其他操作")
            return self._get(db, owner, receipt["task_id"])
        return None

    def get(self, owner, tid):
        with self.engine.connection() as db:
            row = public(self._get(db, owner, tid))
        if row["kind"] == "office":
            row["files"] = self.office.files(owner, tid)
        return row

    @staticmethod
    def _get(db, owner, tid):
        row = db.execute("SELECT * FROM tasks WHERE id=? AND owner=?", (tid, owner)).fetchone()
        if not row:
            raise KeyError("任务不存在")
        return row

    def list(self, owner):
        with self.engine.connection() as db:
            rows = [
                public(r)
                for r in db.execute("SELECT * FROM tasks WHERE owner=? ORDER BY created DESC", (owner,))
            ]
        for row in rows:
            if row["kind"] == "office":
                row["files"] = self.office.files(owner, row["id"])
        return rows

    def artifact(self, owner, tid):
        with self.engine.connection() as db:
            result = self._get(db, owner, tid)["artifact"]
        if result is None:
            raise KeyError("任务尚无成果")
        return result

    def change(self, owner, tid, action, *, request_id=None):
        with self.engine.connection(write=True) as db:
            row = self._get(db, owner, tid)
            if request_id is not None:
                previous = self._request(db, owner, request_id, action)
                if previous:
                    if previous["id"] != tid:
                        raise ValueError("该请求编号已用于其他任务")
                    return public(previous)
            if action == "pause":
                db.execute("UPDATE tasks SET paused=1,next_run=NULL WHERE id=?", (tid,))
            elif action == "resume":
                if row["status"] == "running":
                    raise ConversationBusy("当前请求仍在运行")
                if not row["paused"] and row["status"] != "failed":
                    raise ValueError("只能恢复暂停或失败的任务")
                # Replay a failed run with its previous request key if a reply was already persisted.
                run_id = row["run_id"] if row["status"] != "completed" else uuid4().hex
                db.execute(
                    "UPDATE tasks SET paused=0,status='queued',run_id=?,next_run=?,last_error=NULL WHERE id=?",
                    (run_id, time.time(), tid),
                )
            elif action == "delete":
                db.execute("DELETE FROM tasks WHERE id=?", (tid,))
                return
            else:
                raise ValueError("未知操作")
            if request_id is not None:
                db.execute("INSERT INTO task_requests VALUES(?,?,?,?)", (owner, request_id, tid, action))
            return public(self._get(db, owner, tid))

    def checkpoint(self, tid, key, label):
        with self.engine.connection(write=True) as db:
            row = db.execute(
                "SELECT paused,activity FROM tasks WHERE id=? AND run_id=? AND status='running'", (tid, key)
            ).fetchone()
            if row is None or row["paused"]:
                raise PausedJob()
            steps = json.loads(row["activity"])
            steps.append(label[:240])
            db.execute(
                "UPDATE tasks SET activity=?,claimed=? WHERE id=?",
                (json.dumps(steps[-25:], ensure_ascii=False), time.time(), tid),
            )

    def run_one(self):
        stamp = time.time()
        with self.engine.connection(write=True) as db:
            # An interrupted upstream call can still be billable. Let the owner decide whether to retry.
            db.execute(
                """UPDATE tasks SET status='failed',claimed=NULL,next_run=NULL,last_error='工作进程中断，请检查账本后恢复'
                   WHERE status='running' AND claimed < ?""",
                (stamp - 900,),
            )
            job = db.execute(
                """SELECT * FROM tasks WHERE status IN ('queued','completed') AND paused=0 AND next_run<=?
                   ORDER BY next_run LIMIT 1""",
                (stamp,),
            ).fetchone()
            if not job:
                return False
            key = job["run_id"] if job["status"] == "queued" else uuid4().hex
            db.execute(
                "UPDATE tasks SET status='running',claimed=?,next_run=NULL,activity=CASE WHEN run_id=? THEN activity ELSE '[]' END,run_id=? WHERE id=?",
                (stamp, key, key, job["id"]),
            )
        try:

            def checkpoint(label):
                self.checkpoint(job["id"], key, label)

            if job["kind"] == "research":
                message = self.research.execute(
                    job["owner"], job["conversation_id"], key, job["prompt"], checkpoint
                )
            elif job["kind"] == "office":
                message = self.office.execute(job["owner"], job["id"], key, job["prompt"], checkpoint)
            else:
                checkpoint("根据任务说明与知识库撰写文稿")
                message = self.engine.reply(job["owner"], job["conversation_id"], job["prompt"], "chat", key)
            article = f"# {job['prompt']}\n\n{message['content']}\n"
            if message["sources"]:
                article += (
                    "\n## 参考资料\n\n"
                    + "\n".join(
                        f"{i}. {s['title']} — {s['url']}" for i, s in enumerate(message["sources"], 1)
                    )
                    + "\n"
                )
        except PausedJob:
            with self.engine.connection(write=True) as db:
                db.execute(
                    "UPDATE tasks SET status='queued',claimed=NULL WHERE id=? AND run_id=? AND status='running'",
                    (job["id"], key),
                )
        except Exception as exc:  # noqa: BLE001 -- contain a failed job and persist its state.
            logger.warning("Task %s failed (%s)", job["id"], type(exc).__name__)
            detail = (
                str(exc)[:300] if isinstance(exc, (RuntimeError, ValueError)) else "执行失败，请检查服务日志"
            )
            with self.engine.connection(write=True) as db:
                db.execute(
                    """UPDATE tasks SET status='failed', last_error=?, claimed=NULL
                              WHERE id=? AND status='running' AND run_id=?""",
                    (detail, job["id"], key),
                )
        else:
            interval = PERIOD[job["frequency"]]
            due = time.time() + interval if interval else None
            with self.engine.connection(write=True) as db:
                db.execute(
                    """UPDATE tasks SET status='completed',artifact=?,last_error=NULL,claimed=NULL,
                              next_run=CASE WHEN paused=0 THEN ? ELSE NULL END
                              WHERE id=? AND status='running' AND run_id=?""",
                    (article, due, job["id"], key),
                )
        return True

    def _work(self):
        while not self.stop_event.is_set():
            try:
                if self.run_one():
                    continue
            except Exception:
                logger.exception("Task queue poll failed")
            self.stop_event.wait(1)

    def start(self):
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._work, name="assistant-tasks", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)
