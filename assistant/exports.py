"""Build standard Office files from a stored report or CSV without executing its contents."""

import csv
import re
from io import BytesIO, StringIO

from docx import Document
from openpyxl import Workbook

MAX_CHARACTERS = 262_144
MAX_ROWS = 10_000
MAX_COLUMNS = 512
MAX_CELLS = 100_000
MAX_CELL_UNITS = 32_767
INVALID_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")
HEADING = re.compile(r"^(#{1,6})[ \t]+(.+)$")
BULLET = re.compile(r"^[-*+][ \t]+(.+)$")
NUMBERED = re.compile(r"^\d{1,9}[.)][ \t]+(.+)$")


def _validate(text):
    if not isinstance(text, str) or len(text) > MAX_CHARACTERS:
        raise ValueError(f"导出内容应为不超过 {MAX_CHARACTERS} 个字符的文本")
    if INVALID_XML.search(text):
        raise ValueError("文档中含有 Office 格式不支持的控制字符")


def docx(text) -> bytes:
    """Map Markdown headings and list items to Word paragraph styles."""
    _validate(text)
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if len(lines) > MAX_ROWS:
        raise ValueError(f"Word 文档最多支持 {MAX_ROWS} 段")
    document = Document()
    fenced = False
    for line in lines:
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if fenced:
            document.add_paragraph(line)
        elif heading := HEADING.fullmatch(line):
            document.add_heading(heading.group(2), level=len(heading.group(1)))
        elif bullet := BULLET.fullmatch(line):
            document.add_paragraph(bullet.group(1), style="List Bullet")
        elif numbered := NUMBERED.fullmatch(line):
            document.add_paragraph(numbered.group(1), style="List Number")
        else:
            document.add_paragraph(line)
    output = BytesIO()
    document.save(output)
    return output.getvalue()


def xlsx(csv_text) -> bytes:
    """Store every CSV field as literal text, including leading zeros and formula-like values."""
    _validate(csv_text)
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "数据"
    fields = csv.reader(StringIO(csv_text.removeprefix("\ufeff"), newline=""), strict=True)
    cells = 0
    try:
        for row_index, row in enumerate(fields, 1):
            cells += len(row)
            if row_index > MAX_ROWS or len(row) > MAX_COLUMNS or cells > MAX_CELLS:
                raise ValueError("表格超出支持的行数、列数或单元格总数")
            for col_index, value in enumerate(row, 1):
                if len(value.encode("utf-16-le")) // 2 > MAX_CELL_UNITS:
                    raise ValueError(f"第 {row_index} 行第 {col_index} 列的内容超过 Excel 单元格上限")
                cell = sheet.cell(row_index, col_index, value)
                # Override openpyxl's inference for strings like '=1+1' and '#REF!'.
                cell.data_type = "s"
    except csv.Error as exc:
        raise ValueError(f"CSV 在第 {fields.line_num} 行附近格式有误或字段过长") from exc
    output = BytesIO()
    workbook.save(output)
    return output.getvalue()
