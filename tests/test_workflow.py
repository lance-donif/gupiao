from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from assistant.engine import ConversationBusy, Engine
from assistant.workflow import ResearchWorkflow


def source(key):
    return {"title": key, "url": "https://example.org/" + key, "snippet": "关于 " + key}


class Services:
    def __init__(self):
        fence = chr(96) * 3
        self.plan = fence + 'json\n{"queries":["第一条", "第二条", "第三条"]}\n' + fence
        self.calls = Counter()

    def complete(self, messages, *, response_format=None):
        if len(messages) == 2 and '"queries"' in messages[0]["content"]:
            assert response_format["json_schema"]["strict"]
            self.calls["plan"] += 1
            return self.plan
        self.calls["report"] += 1
        return "综合报告 [1]"

    def search(self, query):
        self.calls[query] += 1
        prefix = {"第一条": "a", "第二条": "b", "第三条": "c"}[query]
        return [source("common"), *[source(f"{prefix}{i}") for i in range(7)]]


@pytest.fixture
def setup(tmp_path):
    services = Services()
    engine = Engine(tmp_path / "state.db", services, services.search)
    cid = engine.create_conversation("alice")["id"]
    return services, engine, cid


def test_steps_persist_across_restart_and_fairly_represent_queries(setup):
    services, engine, cid = setup
    flow = ResearchWorkflow(engine)

    def cancel(label):
        if "第二条" in label:
            raise RuntimeError("已暂停")

    with pytest.raises(RuntimeError, match="暂停"):
        flow.execute("alice", cid, "r1", "研究主题", cancel)
    assert services.calls == {"plan": 1, "第一条": 1}
    fresh = ResearchWorkflow(Engine(engine.path, services, services.search))
    checkpoints = []
    result = fresh.execute("alice", cid, "r1", "研究主题", checkpoints.append)
    assert len(checkpoints) == 3
    assert checkpoints[-1] == "综合资料并撰写报告"
    assert result["content"] == "综合报告 [1]"
    assert [s["title"] for s in result["sources"]] == ["common", "a0", "b0", "c0", "a1", "b1", "c1", "a2"]
    assert fresh.execute("alice", cid, "r1", "研究主题", lambda _: None) == result
    assert all(v == 1 for v in services.calls.values())
    assert len(engine.messages("alice", cid)) == 2
    with pytest.raises(ValueError):
        fresh.execute("alice", cid, "r1", "其他主题", lambda _: None)
    with pytest.raises(KeyError):
        fresh.execute("bob", cid, "r1", "研究主题", lambda _: None)
    bob_cid = engine.create_conversation("bob")["id"]
    fresh.execute("bob", bob_cid, "r1", "独立研究", lambda _: None)
    assert services.calls["plan"] == 2
    engine.delete_conversation("alice", cid)
    with engine.connection() as db:
        assert [r["owner"] for r in db.execute("SELECT owner FROM research_runs")] == ["bob"]


@pytest.mark.parametrize(
    "bad",
    [
        '{"queries":[]}',
        '{"queries":["q","Q"]}',
        '{"queries":["1","2","3","4"]}',
        '{"queries":[1]}',
        "not JSON",
        '{"summary":"yes","queries":["x"]}',
        '{"queries":["line\\nbreak"]}',
    ],
)
def test_invalid_plan_fails_before_search_or_report(setup, bad):
    services, engine, cid = setup
    services.plan = bad
    with pytest.raises(RuntimeError, match="计划"):
        ResearchWorkflow(engine).execute("alice", cid, "id", "说明", lambda _: None)
    assert services.calls == {"plan": 1}
    assert not engine.messages("alice", cid)


def test_empty_results_do_not_create_unsupported_report(setup):
    services, engine, cid = setup
    engine.search = lambda _: []
    with pytest.raises(RuntimeError, match="可引用"):
        ResearchWorkflow(engine).execute("alice", cid, "id", "说明", lambda _: None)
    assert services.calls["report"] == 0


def test_concurrent_execution_does_not_plan_twice(setup):
    services, engine, cid = setup
    workflow = ResearchWorkflow(engine)
    ready, release = Event(), Event()

    def wait_at_planning(label):
        if label == "制定检索计划":
            ready.set()
            release.wait(timeout=5)

    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(workflow.execute, "alice", cid, "r1", "研究", wait_at_planning)
        assert ready.wait(timeout=5)
        try:
            with pytest.raises(ConversationBusy):
                workflow.execute("alice", cid, "r1", "研究", lambda _: None)
        finally:
            release.set()
        first.result(timeout=5)
    assert services.calls["plan"] == 1


def test_search_error_on_one_query_can_resume_using_prior_results(setup):
    services, engine, cid = setup

    def search(query):
        if query == "第三条":
            raise RuntimeError("search offline")
        return services.search(query)

    engine.search = search
    workflow = ResearchWorkflow(engine)
    with pytest.raises(RuntimeError, match="offline"):
        workflow.execute("alice", cid, "r1", "研究", lambda _: None)
    engine.search = services.search
    workflow.execute("alice", cid, "r1", "研究", lambda _: None)
    assert services.calls == {"plan": 1, "第一条": 1, "第二条": 1, "第三条": 1, "report": 1}


def test_source_reading_survives_resume_and_reaches_synthesis(setup):
    services, engine, cid = setup
    labels = []

    class Search:
        def __init__(self):
            self.reads = []

        def __call__(self, query):
            return services.search(query)

        def read(self, item):
            self.reads.append(item["title"])
            return {**item, "snippet": "正文：" + item["title"]}

    def stop_before_second_read(label):
        labels.append(label)
        if label.startswith("阅读来源 2"):
            raise RuntimeError("暂停")

    first = Search()
    engine.search = first
    with pytest.raises(RuntimeError, match="暂停"):
        ResearchWorkflow(engine).execute("alice", cid, "read", "研究", stop_before_second_read)
    assert first.reads == ["common"]
    new_search = Search()
    new_engine = Engine(engine.path, services, new_search)
    result = ResearchWorkflow(new_engine).execute("alice", cid, "read", "研究", labels.append)
    assert new_search.reads == ["a0"]
    assert result["sources"][:2] == [
        {**source("common"), "snippet": "正文：common"},
        {**source("a0"), "snippet": "正文：a0"},
    ]
    assert sum(label.startswith("阅读来源 1") for label in labels) == 1
    assert services.calls["plan"] == 1 and services.calls["report"] == 1
