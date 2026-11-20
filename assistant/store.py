"""SQLite persistence for the assistant. Provider calls run outside transactions."""

import json
import sqlite3
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4


class ConversationBusy(RuntimeError):
    """Another turn is still running. The caller may retry."""


def now():
    return datetime.now(UTC).isoformat(timespec="microseconds")


_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    title TEXT NOT NULL,
    auto_title INTEGER NOT NULL,
    channel INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    turn_claim TEXT,
    claim_expires REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_owner ON conversations(owner) WHERE channel = 1;
CREATE INDEX IF NOT EXISTS conversation_list ON conversations(owner, updated_at DESC);
CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    mode TEXT NOT NULL,
    sources TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    UNIQUE(conversation_id, request_id)
);
CREATE INDEX IF NOT EXISTS turn_history ON turns(conversation_id, id);
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(owner, content)
);
CREATE INDEX IF NOT EXISTS memory_list ON memories(owner, created_at);
"""

_COLUMNS = "id, title, created_at, updated_at"
# Longer than supported provider/search deadlines. The claim token fences late workers.
CLAIM_TTL_SECONDS = 600


def checked_text(value, field, limit):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field}不能为空")
    value = value.strip()
    if len(value) > limit:
        raise ValueError(f"{field}最多支持 {limit} 个字符")
    return value


def as_messages(turn):
    common = {"mode": turn["mode"]}
    return [
        {
            **common,
            "id": f"u-{turn['id']}",
            "role": "user",
            "content": turn["question"],
            "sources": [],
            "created_at": turn["started_at"],
        },
        {
            **common,
            "id": f"a-{turn['id']}",
            "role": "assistant",
            "content": turn["answer"],
            "sources": json.loads(turn["sources"]),
            "created_at": turn["finished_at"],
        },
    ]


class Store:
    def __init__(self, db_path):
        self.path = str(db_path)
        self.memory = self.path == ":memory:"
        if self.memory:
            self.path = f"file:assistant-{uuid4().hex}?mode=memory&cache=shared"
            self._anchor = sqlite3.connect(self.path, uri=True)
        else:
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(_SCHEMA)

    @contextmanager
    def connection(self, write=False):
        conn = sqlite3.connect(self.path, timeout=10, uri=self.memory, isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA foreign_keys=ON")
            if write:
                conn.execute("BEGIN IMMEDIATE")
            yield conn
            if write:
                conn.commit()
        except sqlite3.Error as exc:
            raise RuntimeError("数据库操作失败") from exc
        finally:
            conn.close()  # rolls back any uncommitted write

    @staticmethod
    def conversation(conn, owner, cid):
        row = conn.execute("SELECT * FROM conversations WHERE id=? AND owner=?", (cid, owner)).fetchone()
        if row is None:
            raise KeyError("对话不存在")
        return row

    def _create(self, conn, owner, title, channel=False):
        cid, stamp = uuid4().hex, now()
        conn.execute(
            """INSERT INTO conversations(id, owner, title, auto_title, channel, created_at, updated_at)
               VALUES(?, ?, ?, ?, ?, ?, ?)""",
            (cid, owner, title or "新对话", title is None, channel, stamp, stamp),
        )
        return {"id": cid, "title": title or "新对话", "created_at": stamp, "updated_at": stamp}

    def create_conversation(self, owner, title=None):
        if title is not None:
            title = checked_text(title, "标题", 128)
        with self.connection(write=True) as conn:
            return self._create(conn, owner, title)

    def channel_conversation(self, owner):
        with self.connection(write=True) as conn:
            row = conn.execute(
                "SELECT id FROM conversations WHERE owner=? AND channel=1", (owner,)
            ).fetchone()
            if row:
                return row["id"]
            return self._create(conn, owner, None, channel=True)["id"]

    def conversations(self, owner):
        with self.connection() as conn:
            rows = conn.execute(
                f"SELECT {_COLUMNS} FROM conversations WHERE owner=? ORDER BY updated_at DESC, id",
                (owner,),
            )
            return [dict(row) for row in rows]

    def messages(self, owner, conversation_id):
        with self.connection() as conn:
            self.conversation(conn, owner, conversation_id)
            rows = conn.execute("SELECT * FROM turns WHERE conversation_id=? ORDER BY id", (conversation_id,))
            return [message for row in rows for message in as_messages(row)]

    def latest_research_sources(self, owner, conversation_id):
        with self.connection() as conn:
            self.conversation(conn, owner, conversation_id)
            row = conn.execute(
                """SELECT sources FROM turns WHERE conversation_id=? AND mode='research' AND sources<>'[]'
                   ORDER BY id DESC LIMIT 1""",
                (conversation_id,),
            ).fetchone()
            return json.loads(row["sources"]) if row else []

    @staticmethod
    def _check_idle(conversation):
        if conversation["turn_claim"] and conversation["claim_expires"] > time.time():
            raise ConversationBusy("此对话已有回复正在生成，请稍后重试")

    def delete_conversation(self, owner, conversation_id):
        with self.connection(write=True) as conn:
            self._check_idle(self.conversation(conn, owner, conversation_id))
            conn.execute("DELETE FROM conversations WHERE id=? AND owner=?", (conversation_id, owner))

    def memories(self, owner):
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT id, content, created_at FROM memories WHERE owner=? ORDER BY created_at DESC, id",
                (owner,),
            )
            return [dict(row) for row in rows]

    def add_memory(self, owner, content):
        content = checked_text(content, "记忆", 2000)
        with self.connection(write=True) as conn:
            existing = conn.execute(
                "SELECT id, content, created_at FROM memories WHERE owner=? AND content=?", (owner, content)
            ).fetchone()
            if existing:
                return dict(existing)
            count = conn.execute("SELECT COUNT(*) FROM memories WHERE owner=?", (owner,)).fetchone()[0]
            if count >= 50:
                raise ValueError("最多可保存 50 条记忆，请先删除旧记忆")
            memory_id, stamp = uuid4().hex, now()
            conn.execute(
                "INSERT INTO memories(id, owner, content, created_at) VALUES(?, ?, ?, ?)",
                (memory_id, owner, content, stamp),
            )
            return {"id": memory_id, "content": content, "created_at": stamp}

    def delete_memory(self, owner, id):
        with self.connection(write=True) as conn:
            result = conn.execute("DELETE FROM memories WHERE id=? AND owner=?", (id, owner))
            if result.rowcount == 0:
                raise KeyError("记忆不存在")

    def claim_turn(self, owner, cid, request_id, text, mode, token):
        with self.connection(write=True) as conn:
            conversation = self.conversation(conn, owner, cid)
            completed = conn.execute(
                "SELECT * FROM turns WHERE conversation_id=? AND request_id=?", (cid, request_id)
            ).fetchone()
            if completed:
                if (completed["question"], completed["mode"]) != (text, mode):
                    raise ValueError("请求编号已用于其他消息")
                return as_messages(completed)[1]
            self._check_idle(conversation)
            conn.execute(
                "UPDATE conversations SET turn_claim=?, claim_expires=? WHERE id=?",
                (token, time.time() + CLAIM_TTL_SECONDS, cid),
            )

    def release_turn(self, cid, token):
        with self.connection(write=True) as conn:
            conn.execute(
                "UPDATE conversations SET turn_claim=NULL, claim_expires=NULL WHERE id=? AND turn_claim=?",
                (cid, token),
            )

    def recent_turns(self, owner, cid):
        with self.connection() as conn:
            self.conversation(conn, owner, cid)
            rows = conn.execute(
                "SELECT question, answer, sources FROM turns WHERE conversation_id=? ORDER BY id DESC LIMIT 20",
                (cid,),
            )
            return [dict(row) for row in rows]

    def finish_turn(self, cid, token, request_id, text, answer, mode, sources, started):
        stamp = now()
        with self.connection(write=True) as conn:
            changed = conn.execute(
                """UPDATE conversations SET turn_claim=NULL, claim_expires=NULL, updated_at=?,
                       title=CASE WHEN auto_title=1 THEN ? ELSE title END, auto_title=0
                   WHERE id=? AND turn_claim=?""",
                (stamp, " ".join(text.split())[:56], cid, token),
            )
            if not changed.rowcount:
                raise ConversationBusy("请求已失效，请重新载入对话")
            cursor = conn.execute(
                """INSERT INTO turns(conversation_id, request_id, question, answer, mode, sources,
                                     started_at, finished_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    cid,
                    request_id,
                    text,
                    answer,
                    mode,
                    json.dumps(sources, ensure_ascii=False),
                    started,
                    stamp,
                ),
            )
            turn = conn.execute("SELECT * FROM turns WHERE id=?", (cursor.lastrowid,)).fetchone()
            return as_messages(turn)[1]
