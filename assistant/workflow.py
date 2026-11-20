"""Plan, retrieve and synthesize a bounded research report with durable progress."""

import json
import re
import time
from itertools import zip_longest
from uuid import uuid4

from .engine import research_sources
from .store import ConversationBusy, checked_text

_SCHEMA = """
CREATE TABLE IF NOT EXISTS research_runs (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    prompt TEXT NOT NULL,
    plan TEXT,
    batches TEXT NOT NULL DEFAULT '[]',
    claim TEXT,
    claim_until REAL,
    PRIMARY KEY(conversation_id, run_id)
);
CREATE TABLE IF NOT EXISTS research_reads (
    conversation_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    url TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    PRIMARY KEY(conversation_id, run_id, url),
    FOREIGN KEY(conversation_id, run_id) REFERENCES research_runs(conversation_id, run_id) ON DELETE CASCADE
);
"""

_PLAN_PROMPT = (
    "你是一名研究助理。请将研究主题拆成 1 到 3 个互补的、可以直接用于检索引擎的短查询。"
    "先提取主题中的专有名词，每条查询只写一个具体实体或常用百科词条，去掉写报告、区别、优点等描述。"
    '例如研究水星和金星的区别时，返回 {"queries":["水星","金星"]}。仅返回 JSON，不要添加解释。'
)


_PLAN_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "research_queries",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["queries"],
            "properties": {
                "queries": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 3,
                    "items": {"type": "string", "minLength": 1, "maxLength": 160},
                }
            },
        },
    },
}


def _queries(raw):
    error = "模型未返回有效的检索计划（需要 1 至 3 条不同的短查询）"
    if not isinstance(raw, str) or len(raw) > 4096:
        raise RuntimeError(error)
    value = raw.strip()
    fenced = re.fullmatch(r"```(?:json)?[ \t]*\r?\n(.*?)\r?\n```", value, re.DOTALL | re.IGNORECASE)
    try:
        plan = json.loads(fenced.group(1) if fenced else value)
    except (ValueError, RecursionError):
        raise RuntimeError(error) from None
    if not isinstance(plan, dict) or set(plan) != {"queries"} or not isinstance(plan["queries"], list):
        raise RuntimeError(error)
    result = []
    seen = set()
    for term in plan["queries"]:
        if not isinstance(term, str) or not term.strip() or len(term) > 160 or not term.isprintable():
            raise RuntimeError(error)
        normalized = " ".join(term.split())
        if normalized.casefold() in seen:
            raise RuntimeError(error)
        result.append(normalized)
        seen.add(normalized.casefold())
    if not 1 <= len(result) <= 3:
        raise RuntimeError(error)
    return result


class ResearchWorkflow:
    def __init__(self, engine):
        self.engine = engine
        with engine.connection() as db:
            db.executescript(_SCHEMA)

    def _claim(self, owner, cid, run_id, prompt, token):
        with self.engine.connection(write=True) as db:
            self.engine.conversation(db, owner, cid)
            db.execute(
                """INSERT INTO research_runs(conversation_id, run_id, owner, prompt)
                   VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id, run_id) DO NOTHING""",
                (cid, run_id, owner, prompt),
            )
            row = db.execute(
                "SELECT * FROM research_runs WHERE conversation_id=? AND run_id=? AND owner=?",
                (cid, run_id, owner),
            ).fetchone()
            if not row or row["prompt"] != prompt:
                raise ValueError("任务编号与原研究主题不符")
            if row["claim"] and row["claim_until"] > time.time():
                raise ConversationBusy("该研究任务正在运行")
            db.execute(
                "UPDATE research_runs SET claim=?, claim_until=? WHERE conversation_id=? AND run_id=?",
                (token, time.time() + 900, cid, run_id),
            )
            return json.loads(row["plan"]) if row["plan"] else None, json.loads(row["batches"])

    def _save(self, cid, run_id, token, plan, batches):
        with self.engine.connection(write=True) as db:
            changed = db.execute(
                """UPDATE research_runs SET plan=?, batches=?, claim_until=?
                   WHERE conversation_id=? AND run_id=? AND claim=?""",
                (
                    json.dumps(plan, ensure_ascii=False),
                    json.dumps(batches, ensure_ascii=False),
                    time.time() + 900,
                    cid,
                    run_id,
                    token,
                ),
            )
            if not changed.rowcount:
                raise ConversationBusy("研究任务已被释放，请重新载入")

    def _read_sources(self, cid, run_id, token, sources, checkpoint):
        reader = getattr(self.engine.search, "read_checkpoint", None) or getattr(
            self.engine.search, "read", None
        )
        if not callable(reader):
            return sources
        with self.engine.connection() as db:
            cached = dict(
                db.execute(
                    "SELECT url, excerpt FROM research_reads WHERE conversation_id=? AND run_id=?",
                    (cid, run_id),
                ).fetchall()
            )
        for number, source in enumerate(sources[:2], 1):
            url = source["url"]
            if url in cached:
                source["snippet"] = cached[url]
                continue
            checkpoint(f"阅读来源 {number} · {source['title']}")
            read = research_sources([reader(dict(source))])[0]
            if read["url"] != url:
                raise RuntimeError("阅读结果与原来源不符")
            source["snippet"] = read["snippet"]
            with self.engine.connection(write=True) as db:
                changed = db.execute(
                    """INSERT INTO research_reads(conversation_id, run_id, url, excerpt)
                       SELECT conversation_id, run_id, ?, ? FROM research_runs
                       WHERE conversation_id=? AND run_id=? AND claim=?""",
                    (url, source["snippet"], cid, run_id, token),
                )
                if not changed.rowcount:
                    raise ConversationBusy("研究任务已被释放，请重新载入")
        return sources

    def execute(self, owner, conversation_id, run_id, prompt, checkpoint):
        prompt = checked_text(prompt, "研究主题", 4000)
        run_id = checked_text(run_id, "任务编号", 160)
        token = uuid4().hex
        plan, batches = self._claim(owner, conversation_id, run_id, prompt, token)
        try:
            if plan is None:
                checkpoint("制定检索计划")
                raw = self.engine.provider.complete(
                    [
                        {"role": "system", "content": _PLAN_PROMPT},
                        {"role": "user", "content": prompt},
                    ],
                    response_format=_PLAN_FORMAT,
                )
                plan = _queries(raw)
                self._save(conversation_id, run_id, token, plan, batches)

            for index in range(len(batches), len(plan)):
                query = plan[index]
                checkpoint(f"检索 {index + 1}/{len(plan)} · {query}")
                results = self.engine.search(query)
                if not isinstance(results, list) or any(not isinstance(item, dict) for item in results):
                    raise RuntimeError("检索服务返回格式无效")
                batches.append(research_sources(results) if results else [])
                self._save(conversation_id, run_id, token, plan, batches)

            # Interleave the result sets so a broad first query cannot consume the citation budget.
            sources = research_sources(
                [result for group in zip_longest(*batches) for result in group if result]
            )
            sources = self._read_sources(conversation_id, run_id, token, sources, checkpoint)
            checkpoint("综合资料并撰写报告")
            return self.engine.reply(
                owner, conversation_id, prompt, "research", run_id, trusted_sources=sources
            )
        finally:
            with self.engine.connection(write=True) as db:
                db.execute(
                    "UPDATE research_runs SET claim=NULL,claim_until=NULL WHERE conversation_id=? AND run_id=? AND claim=?",
                    (conversation_id, run_id, token),
                )
