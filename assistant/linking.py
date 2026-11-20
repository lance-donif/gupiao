"""Explicit, one-use pairing of a private QQ chat and a Web workspace."""

import base64
import hashlib
import re
import secrets
import time
from datetime import UTC, datetime

_SCHEMA = """
CREATE TABLE IF NOT EXISTS pairing_codes (
    digest TEXT PRIMARY KEY,
    web_owner TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS qq_workspace_links (
    qq_owner TEXT PRIMARY KEY,
    web_owner TEXT NOT NULL UNIQUE,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL
);
"""

_IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,128}")
_PRIVATE_ONLY = "请在机器人的 QQ 私聊中使用绑定命令"


def _private(owner):
    if not isinstance(owner, str):
        return False
    parts = owner.split(":")
    return (
        len(parts) == 5
        and parts[0] == "qq"
        and parts[2] == "users"
        and _IDENTIFIER.fullmatch(parts[1]) is not None
        and _IDENTIFIER.fullmatch(parts[3]) is not None
        and parts[3] == parts[4]
    )


def code_digest(code):
    if not isinstance(code, str) or not code.isascii() or not re.fullmatch(r"[A-Za-z2-7]{26}", code.strip()):
        raise ValueError("绑定码格式无效")
    return hashlib.sha256(code.strip().upper().encode("ascii")).hexdigest()


class Linking:
    def __init__(self, engine):
        self.engine = engine
        with engine.connection() as db:
            db.executescript(_SCHEMA)

    def issue(self, web_owner):
        if not web_owner or web_owner.startswith("qq:"):
            raise ValueError("需要网页工作区身份")
        code = base64.b32encode(secrets.token_bytes(16)).decode("ascii").rstrip("=")
        stamp = int(time.time())
        expires = stamp + 600
        with self.engine.connection(write=True) as db:
            if db.execute("SELECT 1 FROM qq_workspace_links WHERE web_owner=?", (web_owner,)).fetchone():
                raise ValueError("工作区已有绑定，请先解绑")
            db.execute("DELETE FROM pairing_codes WHERE web_owner=? OR expires_at<=?", (web_owner, stamp))
            db.execute("INSERT INTO pairing_codes VALUES(?, ?, ?)", (code_digest(code), web_owner, expires))
        return {"code": code, "expires_at": datetime.fromtimestamp(expires, UTC).isoformat()}

    def bind(self, qq_owner, code):
        self.bind_digest(qq_owner, code_digest(code))

    def bind_digest(self, qq_owner, digest):
        if not _private(qq_owner):
            raise ValueError(_PRIVATE_ONLY)
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("绑定码无效或已过期")
        with self.engine.connection(write=True) as db:
            code = db.execute(
                "SELECT web_owner FROM pairing_codes WHERE digest=? AND expires_at>?",
                (digest, int(time.time())),
            ).fetchone()
            if not code:
                raise ValueError("绑定码无效或已过期")
            web_owner = code["web_owner"]
            if db.execute(
                "SELECT 1 FROM qq_workspace_links WHERE qq_owner=? OR web_owner=?", (qq_owner, web_owner)
            ).fetchone():
                raise ValueError("账号已有绑定，请先解绑")
            cid = self.engine._create(db, web_owner, "QQ 私聊")["id"]
            db.execute("INSERT INTO qq_workspace_links VALUES(?, ?, ?)", (qq_owner, web_owner, cid))
            db.execute("DELETE FROM pairing_codes WHERE digest=?", (digest,))

    def status(self, web_owner):
        with self.engine.connection() as db:
            row = db.execute("SELECT 1 FROM qq_workspace_links WHERE web_owner=?", (web_owner,)).fetchone()
            return {"linked": row is not None}

    def unlink(self, web_owner):
        with self.engine.connection(write=True) as db:
            db.execute("DELETE FROM pairing_codes WHERE web_owner=?", (web_owner,))
            db.execute("DELETE FROM qq_workspace_links WHERE web_owner=?", (web_owner,))

    def unbind_qq(self, qq_owner):
        if not _private(qq_owner):
            raise ValueError(_PRIVATE_ONLY)
        with self.engine.connection(write=True) as db:
            db.execute("DELETE FROM qq_workspace_links WHERE qq_owner=?", (qq_owner,))

    def linked_owner(self, qq_owner):
        if _private(qq_owner):
            with self.engine.connection() as db:
                row = db.execute(
                    "SELECT web_owner FROM qq_workspace_links WHERE qq_owner=?", (qq_owner,)
                ).fetchone()
                return row["web_owner"] if row else None
        return None

    def still_linked(self, qq_owner, conversation_id):
        if not _private(qq_owner):
            return False
        with self.engine.connection() as db:
            row = db.execute(
                "SELECT 1 FROM qq_workspace_links WHERE qq_owner=? AND conversation_id=?",
                (qq_owner, conversation_id),
            ).fetchone()
            return row is not None

    def route(self, qq_owner):
        if _private(qq_owner):
            with self.engine.connection(write=True) as db:
                link = db.execute(
                    "SELECT web_owner, conversation_id FROM qq_workspace_links WHERE qq_owner=?", (qq_owner,)
                ).fetchone()
                if link:
                    cid = link["conversation_id"]
                    if cid is None:  # Owner deleted the previous QQ conversation in the Web UI.
                        cid = self.engine._create(db, link["web_owner"], "QQ 私聊")["id"]
                        db.execute(
                            "UPDATE qq_workspace_links SET conversation_id=? WHERE qq_owner=?",
                            (cid, qq_owner),
                        )
                    return link["web_owner"], cid
        return qq_owner, self.engine.channel_conversation(qq_owner)
