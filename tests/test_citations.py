import pytest

from assistant.engine import Engine, _grounded_answer


def source(snippet, n=1):
    return {"title": f"文章{n}", "url": f"https://example.org/{n}", "snippet": snippet}


def test_misattributed_measure_is_reported_without_replacing_citation_or_retrying(tmp_path):
    class Model:
        calls = 0

        def complete(self, messages):
            self.calls += 1
            return "作用速度至少比光速快 10,000 倍，但不能用来传递信息 [2]。"

    model = Model()
    excerpt = "實驗顯示，相關速度至少比光速快10,000倍。這還只是速度下限。"
    sources = [source(excerpt), source("量子力学是物理学的分支。", 2)]
    engine = Engine(tmp_path / "store.sqlite", model, lambda query: sources)
    cid = engine.create_conversation("user")["id"]
    answer = engine.reply("user", cid, "请解释实验。", "research", "request")
    assert answer["content"].startswith("作用速度至少比光速快 10,000 倍，但不能用来传递信息 [2]。")
    assert "「10,000 倍」在所引 [2] 的摘录中未找到" in answer["content"]
    assert f"[1] 的摘录含该数值，可核对原文：「{excerpt}」" in answer["content"]
    assert answer["sources"] == sources
    assert engine.messages("user", cid)[-1] == answer
    assert engine.reply("user", cid, "请解释实验。", "research", "request") == answer
    assert model.calls == 1


@pytest.mark.parametrize(
    ("claim", "evidence"),
    [
        ("１．０万倍", "10,000.00倍"),
        ("２．５个百分点", "2.50 個百分點"),
        ("－１，２３４．５％", "负1234.50%"),
        ("0.05‰", "0.050 ‰"),
        ("其中，.5%", "資料顯示，0.50％。"),
        ("成果增幅为 10%；另有提升", "增幅为 4%。"),  # Only the latter clause cites this source.
        ("使用 `growth = '40%'` 测量", "测试方法说明。"),
        ("数据位于 https://example.org/files/40%25/page 。可供查看", "数据已公开。"),
    ],
)
def test_supported_equivalents_and_non_claims_are_unchanged(claim, evidence):
    answer = f"{claim} [1]。"
    assert _grounded_answer(answer, [source(evidence)]) == answer


@pytest.mark.parametrize(
    "evidence", ["变化 210%。", "变化 10‰。", "变化 -10%。", "变化 10 個百分點。", "变化 2.10%。"]
)
def test_no_equal_signed_measure_in_excerpts(evidence):
    answer = _grounded_answer("增加10% [1]。", [source(evidence)])
    assert "「10%」在所引 [1] 的摘录中未找到" in answer
    assert "可核对原文" not in answer


def test_multiple_sources_support_same_group_and_later_claims_are_scoped():
    sources = [source("甲为15%。"), source("乙为20%。", 2)]
    answer = "甲为15%、乙为20%。[1]、[2] 另一组达到15% [2]。"
    result = _grounded_answer(answer, sources)
    assert result.count("未找到") == 1
    assert "「15%」在所引 [2]" in result


def test_code_and_urls_do_not_supply_citations_or_quantitative_evidence():
    answer = "示例。\n```python\nrate = '90%'  # [99]\n```\n网站 https://example.org/item/[99] 可查 [1]。"
    assert _grounded_answer(answer, [source("有数据。")]) == answer
    assert "未找到" in _grounded_answer(
        "数值为8% [1]。", [source("示例 `8%`，链接 https://example.org/8%。")]
    )
    with pytest.raises(RuntimeError, match="不存在的来源编号"):
        _grounded_answer("数值为8% [8]。", [source("数值为8%。")])


def test_chat_and_non_quantitative_research_unchanged():
    assert _grounded_answer("增幅20% [1]。", []) == "增幅20% [1]。"
    assert _grounded_answer("这是一种物理现象 [1]。", [source("物理现象。")]) == "这是一种物理现象 [1]。"


def test_cjk_comma_before_claim_does_not_hide_a_missing_number():
    assert "「10%」在所引 [1]" in _grounded_answer("结果显示，10% 选择甲项 [1]。", [source("没有数据。")])
