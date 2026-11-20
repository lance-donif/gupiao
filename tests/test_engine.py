import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

from assistant.engine import ConversationBusy, Engine


class RecordingProvider:
    def __init__(self):
        self.prompts = []

    def complete(self, messages):
        self.prompts.append(messages)
        return "回答 " + str(len(self.prompts))


class EngineTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.db = Path(folder.name) / "db.sqlite"
        self.provider = RecordingProvider()
        self.urls = [{"title": "搜索资料", "url": "https://example.com/a", "snippet": "来源摘录"}]
        self.searched = []

        def search(query):
            self.searched.append(query)
            return self.urls

        self.engine = Engine(self.db, self.provider, search)
        self.cid = self.engine.create_conversation("alice")["id"]

    def test_history_memories_and_ownership_persist_across_instances(self):
        saved = self.engine.add_memory("alice", "称呼我小鱼")
        self.assertEqual(self.engine.add_memory("alice", "称呼我小鱼"), saved)
        self.engine.add_memory("bob", "bob 的秘密")
        first = self.engine.reply("alice", self.cid, "今天读什么？")
        second_engine = Engine(self.db, self.provider, lambda _: [])
        second_engine.reply("alice", self.cid, "还有呢？")
        prompt = json.dumps(self.provider.prompts[-1], ensure_ascii=False)
        for expected in ("称呼我小鱼", "今天读什么？", first["content"], "还有呢？"):
            self.assertIn(expected, prompt)
        self.assertNotIn("bob 的秘密", prompt)
        self.assertEqual(second_engine.conversations("alice")[0]["title"], "今天读什么？")
        self.assertEqual(second_engine.conversations("bob"), [])
        self.assertEqual(second_engine.messages("alice", self.cid)[1], first)
        self.assertFalse(self.searched)
        for op in [
            lambda: second_engine.messages("bob", self.cid),
            lambda: second_engine.reply("bob", self.cid, "read"),
            lambda: second_engine.delete_conversation("bob", self.cid),
            lambda: second_engine.delete_memory("bob", saved["id"]),
        ]:
            with self.assertRaises(KeyError):
                op()
        self.assertEqual(len(self.provider.prompts), 2)
        second_engine.delete_memory("alice", saved["id"])
        second_engine.reply("alice", self.cid, "明天呢？")
        self.assertNotIn("称呼我小鱼", json.dumps(self.provider.prompts[-1], ensure_ascii=False))
        second_engine.delete_conversation("alice", self.cid)
        with self.assertRaises(KeyError):
            second_engine.messages("alice", self.cid)

    def test_research_filters_sources_and_persists_citations_on_replay(self):
        self.urls.extend(
            [
                {"title": "bad", "url": "javascript:alert(1)"},
                {"title": "bad", "url": "https://user:secret@example.com"},
                self.urls[0],
            ]
        )
        first = self.engine.reply("alice", self.cid, "最近的新发现？", "research", "unique")
        again = self.engine.reply("alice", self.cid, "最近的新发现？", "research", "unique")
        self.assertEqual(again, first)
        self.assertEqual(first["sources"], [self.urls[0]])
        self.assertEqual(self.searched, ["最近的新发现？"])
        self.assertEqual(len(self.engine.messages("alice", self.cid)), 2)
        self.assertEqual(len(self.provider.prompts), 1)
        self.assertIn("来源摘录", self.provider.prompts[-1][-2]["content"])
        with self.assertRaises(ValueError):
            self.engine.reply("alice", self.cid, "另一个问题", "research", "unique")
        self.engine.reply("alice", self.cid, "给我刚才的链接")
        self.assertIn("https://example.com/a", self.provider.prompts[-1][-2]["content"])

    def test_empty_search_invalid_answer_and_provider_error_release_turn(self):
        self.urls.clear()
        with self.assertRaises(RuntimeError):
            self.engine.reply("alice", self.cid, "关键词", mode="research", request_id="try")
        self.assertFalse(self.provider.prompts)
        self.assertFalse(self.engine.messages("alice", self.cid))

        def fail(_):
            raise RuntimeError("provider offline")

        self.provider.complete = fail
        with self.assertRaisesRegex(RuntimeError, "offline"):
            self.engine.reply("alice", self.cid, "关键词", request_id="try")
        self.provider.complete = lambda _: "  "
        with self.assertRaises(RuntimeError):
            self.engine.reply("alice", self.cid, "关键词", request_id="try")
        self.assertFalse(self.engine.messages("alice", self.cid))
        self.provider.complete = lambda _: "ok"
        self.assertEqual(self.engine.reply("alice", self.cid, "关键词", request_id="try")["content"], "ok")

    def test_concurrent_claims_serialize_same_conversation(self):
        started, release = Event(), Event()
        other = Engine(self.db, RecordingProvider(), lambda _: [])

        def blocked(_):
            started.set()
            release.wait(5)
            return "done"

        self.provider.complete = blocked
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(self.engine.reply, "alice", self.cid, "hello", "chat", "same")
            self.assertTrue(started.wait(5))
            try:
                with self.assertRaises(ConversationBusy):
                    other.reply("alice", self.cid, "hello", request_id="same")
                with self.assertRaises(ConversationBusy):
                    other.delete_conversation("alice", self.cid)
                separate = other.create_conversation("bob")
                other.reply("bob", separate["id"], "可并发处理")
            finally:
                release.set()
            answer = pending.result(timeout=5)
        self.assertEqual(other.reply("alice", self.cid, "hello", request_id="same"), answer)
        self.assertEqual(len(other.messages("alice", self.cid)), 2)

    def test_channel_singleton_survives_restart_and_competing_creates(self):
        owner = "qq:group:one:user:one"
        with ThreadPoolExecutor(max_workers=6) as pool:
            ids = list(pool.map(self.engine.channel_conversation, [owner] * 10))
        second_engine = Engine(self.db, self.provider, lambda _: [])
        self.assertEqual(set(ids), {second_engine.channel_conversation(owner)})
        self.assertNotEqual(ids[0], self.engine.channel_conversation("qq:group:two:user:one"))

    def test_chinese_knowledge_retrieval_is_relevant_and_owner_scoped(self):
        handbook = self.engine.add_document("alice", "航行指南.md", "海豚号飞船的发射许可由北极星站签发。")
        self.engine.add_document("alice", "菜谱.txt", "菠菜汤的原料是冬笋和木耳。")
        self.engine.add_document("bob", "机密.txt", "海豚号秘密船坞设在火山。")
        restored = Engine(self.db, self.provider, lambda _: [])
        self.assertEqual(len(restored.documents("alice")), 2)
        self.assertEqual(handbook["size_bytes"], len("海豚号飞船的发射许可由北极星站签发。".encode()))
        answer = restored.reply("alice", self.cid, "海豚号的发射许可如何获得？")
        context = json.dumps(self.provider.prompts[-1], ensure_ascii=False)
        self.assertIn("北极星站", context)
        self.assertIn("航行指南.md", context)
        self.assertNotIn("机密.txt", context)
        self.assertNotIn("菜谱.txt", context)
        self.assertEqual(answer["sources"], [])
        with self.assertRaises(KeyError):
            restored.delete_document("bob", handbook["id"])
        restored.delete_document("alice", handbook["id"])
        restored.reply("alice", self.cid, "海豚号的发射许可如何获得？")
        self.assertNotIn("北极星站", json.dumps(self.provider.prompts[-1], ensure_ascii=False))

    def test_document_limits_and_queries(self):
        for name, content in [
            ("empty", ""),
            ("../bad", "hello"),
            ("binary.txt", "a\x00b"),
            ("too big", "文" * 90000),
        ]:
            with self.assertRaises(ValueError):
                self.engine.add_document("alice", name, content)
        self.engine.add_document("alice", "guide.txt", "Cats love quiet reading rooms. 木星指南。")
        for query in ('"reading" OR (near*)', "木"):
            self.assertEqual(self.engine.knowledge.retrieve("alice", query)[0]["name"], "guide.txt")
        self.assertFalse(self.engine.knowledge.retrieve("alice", "🥶"))
        for i in range(19):
            self.engine.add_document("alice", f"{i}", "other")
        with self.assertRaises(ValueError):
            self.engine.add_document("alice", "extra", "other")
        self.assertEqual(len(self.engine.documents("alice")), 20)

    def test_research_accepts_internal_precollected_results_without_a_second_search(self):
        result = self.engine.reply("alice", self.cid, "综合资料", mode="research", trusted_sources=self.urls)
        self.assertEqual(result["sources"], self.urls)
        self.assertFalse(self.searched)

    def test_research_citations_must_use_valid_source_ids_and_surface_omissions(self):
        self.provider.complete = lambda _: "越界引用 [2]"
        with self.assertRaisesRegex(RuntimeError, "不存在的来源"):
            self.engine.reply("alice", self.cid, "研究", mode="research")
        self.assertEqual(self.engine.messages("alice", self.cid), [])
        self.provider.complete = lambda _: "没有注明来源的答复"
        result = self.engine.reply("alice", self.cid, "研究", mode="research")
        self.assertIn("模型未在正文标注来源编号", result["content"])
        self.provider.complete = lambda _: "[1]\n没有注明来源的答复"
        result = self.engine.reply("alice", self.cid, "研究", mode="research")
        self.assertIn("模型未在正文标注来源编号", result["content"])
        self.provider.complete = lambda _: "摘录 [1]"
        result = self.engine.reply("alice", self.cid, "研究", mode="research")
        self.assertEqual(result["content"], "摘录 [1]")
