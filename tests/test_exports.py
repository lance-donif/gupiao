from io import BytesIO
from zipfile import ZipFile

import pytest
from docx import Document
from openpyxl import load_workbook

from assistant.exports import MAX_CHARACTERS, MAX_COLUMNS, MAX_ROWS, docx, xlsx


def test_word_round_trip_chinese_headings_lists_and_line_breaks():
    result = docx("# 季度报告\r\n\r\n正文第一行\r正文第二行\n- 上海\n1. 北京\n## 结论\n")
    document = Document(BytesIO(result))
    assert [(p.text, p.style.name) for p in document.paragraphs] == [
        ("季度报告", "Heading 1"), ("", "Normal"), ("正文第一行", "Normal"), ("正文第二行", "Normal"),
        ("上海", "List Bullet"), ("北京", "List Number"), ("结论", "Heading 2"), ("", "Normal")
    ]


def test_word_keeps_code_examples_literal():
    document = Document(BytesIO(docx("```python\n# 注释\n```\n引用 <样本> & 数据")))
    assert [(p.text, p.style.name) for p in document.paragraphs] == [
        ("# 注释", "Normal"), ("引用 <样本> & 数据", "Normal")
    ]


def test_excel_csv_round_trip_preserves_fields_and_quotes():
    data = '\ufeff编号,摘要,公式文本,错误文本\r\n0012,"这段包含 ""引号"", 逗号\r\n和换行",=1+1,#REF!\r\n'
    result = xlsx(data)
    workbook = load_workbook(BytesIO(result), data_only=False)
    sheet = workbook.active
    assert list(sheet.values) == [
        ("编号", "摘要", "公式文本", "错误文本"),
        ("0012", '这段包含 "引号", 逗号\r\n和换行', "=1+1", "#REF!"),
    ]
    assert sheet["C2"].data_type == sheet["D2"].data_type == "s"
    with ZipFile(BytesIO(result)) as archive:
        assert b"<f>" not in archive.read("xl/worksheets/sheet1.xml")


@pytest.mark.parametrize(("export", "text"), [
    (xlsx, '"没有结束的引号'), (xlsx, "x," * MAX_COLUMNS + "x"),
    (xlsx, "😀" * 16384), (docx, "\n" * MAX_ROWS),
    (docx, "x" * (MAX_CHARACTERS + 1)), (docx, "\x00"), (xlsx, "文字\x0b"),
], ids=["quotes", "columns", "cell-length", "paragraphs", "document-length", "word-control", "excel-control"])
def test_export_rejects_unrepresentable_or_oversized_input(export, text):
    with pytest.raises(ValueError):
        export(text)
