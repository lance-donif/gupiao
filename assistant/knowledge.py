"""Local full-text document retrieval with Chinese bigrams and Unicode words."""

import re
import unicodedata
from pathlib import PurePath
from uuid import uuid4

from .store import checked_text, now

DOCUMENT_LIMIT = 20
BYTE_LIMIT = 256 * 1024
_CHINESE = r"\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0002fa1f"
_WORDS = re.compile(rf"[{_CHINESE}]+|[^\W_{_CHINESE}]+")
_COMMON = {
    "什么",
    "是什",
    "怎么",
    "怎样",
    "请问",
    "告诉",
    "诉我",
    "一下",
    "哪些",
    "关于",
    "为何",
    "如何",
    "我的",
    "我们",
    "吗",
    "呢",
    "的",
    "和",
    "是",
    "我",
    "了",
    "a",
    "an",
    "about",
    "and",
    "are",
    "can",
    "do",
    "for",
    "how",
    "i",
    "in",
    "is",
    "me",
    "of",
    "on",
    "or",
    "please",
    "tell",
    "the",
    "to",
    "what",
    "when",
    "where",
    "with",
}
_HAN = re.compile(rf"[{_CHINESE}]")

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS document_owner ON documents(owner, created_at);
CREATE TABLE IF NOT EXISTS document_chunks (
    id INTEGER PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS document_chunk_lookup ON document_chunks(document_id);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_search USING fts5(filename, terms);
CREATE TRIGGER IF NOT EXISTS remove_knowledge_terms AFTER DELETE ON document_chunks BEGIN
    DELETE FROM knowledge_search WHERE rowid=old.id;
END;
"""


def terms(text, *, index=False):
    words = _WORDS.findall(unicodedata.normalize("NFKC", text).casefold())
    for word in words:
        if len(word) == 1 or not _HAN.match(word):
            if word not in _COMMON:
                yield word[:128]
        else:
            if index:
                yield from (char for char in word if char not in _COMMON)
            for i in range(len(word) - 1):
                pair = word[i : i + 2]
                if pair not in _COMMON:
                    yield pair


def chunks(content):
    start = 0
    while start < len(content):
        end = min(start + 800, len(content))
        # Prefer a paragraph boundary when it does not create a short fragment.
        if end < len(content):
            boundary = content.rfind("\n", start + 500, end)
            if boundary != -1:
                end = boundary + 1
        yield content[start:end]
        if end == len(content):
            break
        start = end - 96


class Knowledge:
    def __init__(self, store):
        self.store = store
        with store.connection() as conn:
            conn.executescript(SCHEMA)

    def documents(self, owner):
        with self.store.connection() as conn:
            rows = conn.execute(
                "SELECT id, name, size_bytes, created_at FROM documents WHERE owner=? ORDER BY created_at DESC, id",
                (owner,),
            )
            return [dict(row) for row in rows]

    def add_document(self, owner, name, content):
        name = checked_text(name, "文件名", 140)
        if PurePath(name).name != name or "\\" in name or any(ord(c) < 32 for c in name):
            raise ValueError("请输入文件名")
        if not isinstance(content, str) or not content.strip() or "\x00" in content:
            raise ValueError("文档必须包含有效文本")
        try:
            size = len(content.encode("utf-8"))
        except UnicodeEncodeError as exc:
            raise ValueError("文档必须是 UTF-8 文本") from exc
        if size > BYTE_LIMIT:
            raise ValueError("每个文档最大 256 KiB")
        doc_id, stamp = uuid4().hex, now()
        filename_terms = " ".join(terms(name, index=True))
        with self.store.connection(write=True) as conn:
            count = conn.execute("SELECT COUNT(*) FROM documents WHERE owner=?", (owner,)).fetchone()[0]
            if count >= DOCUMENT_LIMIT:
                raise ValueError("最多可保存 20 个文档，请先删除旧文档")
            conn.execute("INSERT INTO documents VALUES(?, ?, ?, ?, ?)", (doc_id, owner, name, size, stamp))
            for fragment in chunks(content):
                row = conn.execute(
                    "INSERT INTO document_chunks(document_id, content) VALUES(?, ?)", (doc_id, fragment)
                )
                conn.execute(
                    "INSERT INTO knowledge_search(rowid, filename, terms) VALUES(?, ?, ?)",
                    (row.lastrowid, filename_terms, " ".join(terms(fragment, index=True))),
                )
        return {"id": doc_id, "name": name, "size_bytes": size, "created_at": stamp}

    def delete_document(self, owner, doc_id):
        with self.store.connection(write=True) as conn:
            removed = conn.execute("DELETE FROM documents WHERE owner=? AND id=?", (owner, doc_id))
            if not removed.rowcount:
                raise KeyError("文档不存在")

    def retrieve(self, owner, text):
        # terms contain only Unicode words, quoted individually to keep input literal.
        query_terms = list(dict.fromkeys(terms(text)))[:64]
        if not query_terms:
            return []
        query = " OR ".join(f'"{word}"' for word in query_terms)
        with self.store.connection() as conn:
            rows = conn.execute(
                """SELECT d.name, c.content FROM knowledge_search
                   JOIN document_chunks c ON c.id=knowledge_search.rowid
                   JOIN documents d ON d.id=c.document_id
                   WHERE knowledge_search MATCH ? AND d.owner=?
                   ORDER BY bm25(knowledge_search, 2.0, 1.0), c.id LIMIT 3""",
                (query, owner),
            )
            return [dict(row) for row in rows]
