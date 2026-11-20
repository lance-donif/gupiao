import json
from decimal import Decimal

import pytest

from assistant.engine import Engine
from assistant.office import ACTIONS, MAX_BYTES, MAX_FILES, Office, parse
from assistant.tasks import TaskQueue


def step(verb, name="", text=""):
    return {"action": verb, "name": name, "text": text}


class Planner:
    def __init__(self):
        self.steps = []
        self.calls = []

    def complete(self, messages, *, response_format):
        self.calls.append((messages, response_format))
        return json.dumps(self.steps.pop(0), ensure_ascii=False)


@pytest.fixture
def workspace(tmp_path):
    planner = Planner()
    searches = []

    def search(query):
        searches.append(query)
        return [{"title": "太阳", "url": "https://example.org/sun", "snippet": "恒星"}]

    engine = Engine(tmp_path / "office.db", planner, search)
    task = TaskQueue(engine).create("alice", "编写一份关于太阳的短报告")
    with engine.connection() as db:
        run = db.execute("SELECT run_id FROM tasks WHERE id=?", (task["id"],)).fetchone()[0]
    return Office(engine), planner, searches, ("alice", task["id"], run, task["prompt"])


def test_full_cycle_with_two_restart_boundaries(workspace):
    office, planner, searches, args = workspace
    planner.steps = [
        step("search_web", text="太阳"),
        step("write_file", "报告.md", "# 太阳\n它是一颗恒星。"),
        step("read_file", "报告.md"),
        step("list_files"),
        step("finish", text="已生成报告.md。"),
    ]

    def interrupt(label):
        if "写入文件" in label:
            raise RuntimeError("用户暂停")

    with pytest.raises(RuntimeError, match="用户暂停"):
        office.execute(*args, interrupt)
    assert searches == ["太阳"]
    assert len(planner.calls) == 2
    assert office.files(*args[:2]) == []
    fresh = Office(office.engine)

    def pause_after_write(label):
        if label == "规划第 3 步":
            raise RuntimeError("重启")

    with pytest.raises(RuntimeError, match="重启"):
        fresh.execute(*args, pause_after_write)
    assert len(planner.calls) == 2
    assert fresh.read(*args[:2], "报告.md").startswith("# 太阳")
    result = fresh.execute(*args, lambda _: None)
    assert result == {
        "content": "已生成报告.md。",
        "sources": [{"title": "太阳", "url": "https://example.org/sun", "snippet": "恒星"}],
    }
    assert len(planner.calls) == 5
    assert searches == ["太阳"]
    assert fresh.execute(*args, lambda _: pytest.fail("completed work repeated")) == result
    assert fresh.files(*args[:2]) == [
        {"name": "报告.md", "size_bytes": len("# 太阳\n它是一颗恒星。".encode())}
    ]
    assert "它是一颗恒星。" in planner.calls[-1][0][-1]["content"]


def test_tenant_isolation_and_removal(workspace):
    office, planner, _, args = workspace
    planner.steps = [step("write_file", "结果.csv", "目标,结果\nA,通过"), step("finish", text="完成")]
    office.execute(*args, lambda _: None)
    owner, tid, run, prompt = args
    for access in [
        lambda: office.files("bob", tid),
        lambda: office.read("bob", tid, "结果.csv"),
        lambda: office.execute("bob", tid, run, prompt, lambda _: None),
    ]:
        with pytest.raises(KeyError):
            access()
    with pytest.raises(RuntimeError, match="失效"):
        office.execute(owner, tid, "old-run", prompt, lambda _: None)
    TaskQueue(office.engine).change(owner, tid, "delete")
    with office.engine.connection() as db:
        assert db.execute("select count(*) from office_files").fetchone()[0] == 0
        assert db.execute("select count(*) from office_steps").fetchone()[0] == 0


@pytest.mark.parametrize(
    "bad",
    [
        "text",
        '{"action":"list_files","name":"","text":"","text":""}',
        json.dumps({"action": "open_file", "name": "a.md", "text": ""}),
        json.dumps({"action": "write_file", "name": "../x.md", "text": "bad"}),
        json.dumps({"action": "write_file", "name": "unsafe.html", "text": "bad"}),
        json.dumps({"action": "write_file", "name": "文档.txt", "text": "大" * (MAX_BYTES // 3 + 1)}),
        json.dumps({"action": "search_web", "name": "", "text": ""}),
        json.dumps({"action": "finish", "text": "ok"}),
    ],
)
def test_invalid_action_rejected(bad):
    with pytest.raises(ValueError):
        parse(bad, ACTIONS)


def test_file_required_this_run_and_quota(workspace):
    office, planner, _, args = workspace
    owner, tid, _, _ = args
    planner.steps = [step("finish", text="没有文件")]
    with pytest.raises(ValueError, match="不可用"):
        office.execute(*args, lambda _: None)
    assert office.files(owner, tid) == []
    with office.engine.connection(write=True) as db:
        for n in range(MAX_FILES):
            office._local_tool(db, tid, step("write_file", f"{n}.txt", "file"))
        office._local_tool(db, tid, step("write_file", "1.txt", "updated"))
        with pytest.raises(ValueError, match="最多"):
            office._local_tool(db, tid, step("write_file", "extra.txt", "file"))


def test_never_plans_more_than_six_steps(workspace):
    office, planner, _, args = workspace
    planner.steps = [step("search_web", text="wiki")] * 4 + [
        step("write_file", "笔记.txt", "内容"),
        step("finish", text="完成"),
    ]
    office.execute(*args, lambda _: None)
    allowed = [fmt["json_schema"]["schema"]["properties"]["action"]["enum"] for _, fmt in planner.calls]
    assert "finish" not in allowed[0]
    assert allowed[-2:] == [["write_file"], ["finish"]]


def test_all_named_deliverables_before_handoff(workspace):
    office, planner, _, args = workspace
    planner.steps = [
        step("write_file", "summary.md", "测试完成"),
        step("write_file", "stats.csv", "count\n1"),
    ]
    result = office.execute(*args[:3], "请生成 summary.md 和 stats.csv。", lambda _: None)
    allowed = [fmt["json_schema"]["schema"]["properties"]["action"]["enum"] for _, fmt in planner.calls]
    assert "write_file" in allowed[1]
    assert len(allowed) == 2
    assert "finish" not in allowed[1]
    assert result["content"] == "已生成 stats.csv、summary.md。"
    assert office.read(*args[:2], "summary.md") == "测试完成"


def test_followup_operations_remain_available(workspace):
    office, planner, _, args = workspace
    planner.steps = [
        step("write_file", "清单.md", "要点"),
        step("read_file", "清单.md"),
        step("write_file", "清单.md", "完整要点"),
        step("finish", text="已复核"),
    ]
    office.execute(*args[:3], "请写一个名为清单.md的文件，然后读取核对，修改并提交。", lambda _: None)
    assert office.read(*args[:2], "清单.md") == "完整要点"


def test_csv_rows_quote_and_preserve_table_shape(workspace):
    office, planner, _, args = workspace
    planner.steps = [step("write_file", "table.csv", [["Name", "Note"], ["Alice", 'East, "A"']])]
    office.execute(*args[:3], "请生成 table.csv", lambda _: None)
    assert office.read(*args[:2], "table.csv") == 'Name,Note\nAlice,"East, ""A"""\n'
    assert planner.calls[0][1]["json_schema"]["schema"]["properties"]["text"]["type"] == "array"
    with pytest.raises(ValueError, match="列数"):
        parse(json.dumps(step("write_file", "bad.csv", [["A", "B"], ["x"]])), ACTIONS)


def test_csv_input_is_computed_before_model_drafts(workspace):
    office, planner, searches, args = workspace
    owner, tid, rid, _ = args
    body = '地区,收入\r\n"东,区",12.34\r\n西区,0.76\r\n'
    with office.engine.connection(write=True) as db:
        office.seed(db, tid, [{"name": "data.csv", "content": body}])
    planner.steps = [step("write_file", "result.md", "总计 13.1")]
    result = office.execute(owner, tid, rid, "统计 data.csv 中收入的合计，生成 result.md。", lambda _: None)
    assert result["content"] == "已生成 result.md。"
    assert len(planner.calls) == 1
    messages, fmt = planner.calls[0]
    data = json.loads(messages[-1]["content"].split("\n")[0])
    action = data["本轮已做"][0]
    assert action["action"] == "summarize_csv"
    assert action["result"]["row_count"] == 2
    assert Decimal(action["result"]["columns"][1]["sum"]) == Decimal("13.10")
    assert "search_web" not in fmt["json_schema"]["schema"]["properties"]["action"]["enum"]
    assert not searches
    assert office.read(owner, tid, "data.csv") == body
    with pytest.raises(KeyError):
        office.read("bob", tid, "data.csv")


@pytest.mark.parametrize(
    "files",
    [
        [{"name": "ok.txt", "content": "ok"}, {"name": "OK.txt", "content": "duplicate"}],
        [{"name": "ok.md", "content": "ok"}, {"name": "../other.txt", "content": "no"}],
        [{"name": "ok.md", "content": "ok"}, {"name": "big.txt", "content": "文" * (MAX_BYTES // 3 + 1)}],
        [{"name": "nul.txt", "content": "a\x00b"}],
        [{"name": "x.md", "content": "\ud800"}],
        [{"name": f"{n}.txt", "content": "file"} for n in range(5)],
    ],
)
def test_invalid_attachments_never_partially_seed(workspace, files):
    office, _, _, args = workspace
    with office.engine.connection(write=True) as db, pytest.raises(ValueError):
        office.seed(db, args[1], files)
    assert office.files(*args[:2]) == []


def test_private_text_attachment_read_on_resume(workspace):
    office, planner, _, args = workspace
    owner, tid, rid, _ = args
    initial = "会前确认场地、容量、时间。"
    with office.engine.connection(write=True) as db:
        office.seed(db, tid, [{"name": "input.txt", "content": initial}])
    prompt = "根据 input.txt 的内容生成 output.md"
    with pytest.raises(RuntimeError, match="暂停"):

        def interrupt(label):
            if label.startswith("规划"):
                raise RuntimeError("暂停")

        office.execute(owner, tid, rid, prompt, interrupt)
    planner.steps = [step("write_file", "output.md", "检查事项")]
    office.execute(owner, tid, rid, prompt, lambda label: None)
    assert initial in planner.calls[0][0][-1]["content"]
    assert "summarize_csv" not in planner.calls[0][1]["json_schema"]["schema"]["properties"]["action"]["enum"]
