"""Compare explicitly cited quantities against the excerpts the model actually received."""

import re
from decimal import Decimal

CITATION = re.compile(r"\[([0-9]+)\](?!\()")
_CITATION_GROUP = re.compile(r"\[[0-9]+\](?!\()(?:[ \t]*(?:[,，、][ \t]*)?\[[0-9]+\](?!\())*")
_SENTENCE_BREAK = re.compile(r"[。！？!?；;\n]|\.(?=\s)")
_NON_PROSE = re.compile(r"(?P<ticks>`+).*?(?P=ticks)|https?://[^\s<>，。；！？)）]+", re.IGNORECASE)
_FENCE = re.compile(r"^[ ]{0,3}(`{3,}|~{3,})")
# One character in, one out. Match offsets still identify verbatim source text.
_WIDTH = str.maketrans("０１２３４５６７８９＋－−．，％負萬億", "0123456789+--.,%负万亿")
_MEASURE = re.compile(
    r"(?<![A-Za-z0-9_.+\-负])(?<![0-9],)(?P<num>[+\-负]?"
    r"(?:(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?|\.[0-9]+))"
    r"[ \t\u00a0]*(?P<scale>[千亿万]?)[ \t\u00a0]*(?P<unit>个百分点|個百分點|倍|[%‰])"
)
_SCALE = {"": 0, "千": 3, "万": 4, "亿": 8}


def prose(text):
    """Mask code and URLs, preserving newlines and offsets for evidence excerpts."""
    lines = []
    fence = ""
    for line in text.splitlines(keepends=True):
        mark = _FENCE.match(line)
        if fence or mark:
            if not fence:
                fence = mark[1]
            elif mark and mark[1].startswith(fence) and not line[mark.end() :].strip():
                fence = ""
            line = re.sub(r"[^\r\n]", " ", line)
        else:
            line = _NON_PROSE.sub(lambda match: " " * len(match[0]), line)
        lines.append(line)
    return "".join(lines)


def _measures(text):
    for match in _MEASURE.finditer(text.translate(_WIDTH)):
        if len(match["num"]) > 80:
            continue
        number = match["num"].replace(",", "").replace("负", "-")
        value = Decimal(f"{number}e{_SCALE[match['scale']]}")
        unit = match["unit"].replace("個百分點", "个百分点")
        yield (value, unit), match.span()


def _source_index(sources):
    locations = {}
    for index, source in enumerate(sources, 1):
        snippet = source["snippet"]
        for key, (start, end) in _measures(prose(snippet)):
            # Keep a bounded, verbatim window around the first occurrence in this source.
            left, right = max(0, start - 32), min(len(snippet), end + 32)
            if left:
                before = list(_SENTENCE_BREAK.finditer(snippet, left, start))
                if before:
                    left = before[-1].end()
            if right < len(snippet):
                after = list(_SENTENCE_BREAK.finditer(snippet, end, right))
                if after:
                    right = after[-1].end()
            excerpt = snippet[left:right].strip()
            locations.setdefault(key, {}).setdefault(index, excerpt)
    return locations


def quantity_notes(text, sources):
    """Flag literal mismatches without altering citations or certifying semantic support."""
    locations = _source_index(sources)
    seen = set()
    notes = []
    last_end = 0
    for group in _CITATION_GROUP.finditer(text):
        # Attribute only the closest preceding sentence fragment. Consecutive references
        # constitute one citation group. A reference may follow terminal punctuation.
        prefix = text[last_end : group.start()].rstrip(" \t.。！？?!；;")
        fragment = _SENTENCE_BREAK.split(prefix)[-1]
        last_end = group.end()
        indices = tuple(dict.fromkeys(map(int, CITATION.findall(group[0]))))
        for key, (start, end) in _measures(fragment):
            matches = locations.get(key, {})
            if any(n in matches for n in indices) or (indices, key) in seen:
                continue
            seen.add((indices, key))
            if len(notes) >= 8:
                continue
            ids = "、".join(f"[{i}]" for i in indices)
            note = f"「{fragment[start:end]}」在所引 {ids} 的摘录中未找到同数值、同单位的表述。"
            if matches:
                index, excerpt = next(iter(matches.items()))
                note += f" [{index}] 的摘录含该数值，可核对原文：「{excerpt}」。"
            notes.append(note)
    if not notes:
        return ""
    if len(seen) > len(notes):
        notes.append(f"另有 {len(seen) - len(notes)} 项数字引文需要核对。")
    return "\n\n**数字引文待核对**\n\n" + "\n".join(f"- {note}" for note in notes)
