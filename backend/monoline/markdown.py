"""Markdown → the lines the beat model reads. One owner, parser-driven.

The IR guarantees 1 beat = 1 segment = 1 scene (the audio is cut from the beat), so the
question this module answers is not "how do I render markdown" but "what IS one beat" when the
input is markdown. Answer, per CommonMark: **one block-level statement**. A paragraph that a
LLM or a README hard-wrapped across three source lines is ONE sentence, not three; a table is
ONE row-set; a thematic break is nothing at all.

Measured on a torture document before this existed (20 beats out of 9 blocks): a wrapped
paragraph arrived as three half-sentences, `> ` and `[ ]` and `~~` and `` ``` `` leaked into the
slide text, a code fence became three beats and welded the following setext heading onto one of
them, and a footnote reference `[^1]` was promoted to a giant `stat` because it contains a
digit. All of those are the same root cause: the segmenter was reading SOURCE lines instead of
BLOCKS.

So: parse with markdown-it (never regexes over raw lines — `---` under a paragraph is a setext
heading and a `|` inside a paragraph is not a table), then emit one plain-text line per block,
keeping the `#` / `-` markers the segmenter uses to recognise a deliberate short line.
"""
from __future__ import annotations

import re

from markdown_it import MarkdownIt

_MD = MarkdownIt("commonmark").enable(["table", "strikethrough"])

# A header whose first cell just names the column ("项 / 名称 / name") is not data: the row
# below it is already self-describing. Any other first cell (温度, 指标) is a real key, and a
# single-row table is read column-wise — 温度：20℃，压力：1atm — rather than 20℃：1atm.
_FIELD_HEADER = {"项", "项目", "条目", "名称", "名字", "指标", "参数", "类别", "分类", "维度",
                 "字段", "key", "name", "item", "label", "field"}

_CJK = re.compile(r"[぀-ヿ一-鿿]")
_TAGS = re.compile(r"</?[A-Za-z][^>]*>")
# Footnotes are reference apparatus: they belong at the bottom of a page, and on a slide the
# marker is noise while the definition is a beat nobody asked for. Removed from the SOURCE
# before parsing, because once a `[^1]: …` definition exists markdown-it resolves `[^1]` into
# a real link whose href is the definition — indistinguishable from a legit link at token level.
_FN_DEF = re.compile(r"^\[\^[^\]]+\]:.*$", re.M)
_FN_REF = re.compile(r"\[\^[^\]]+\]")
_TASK = re.compile(r"^\[[ xX]\]\s*")
# CommonMark only knows `- + *` as bullets. 中文文档与 Word 粘贴用的是 • · ‣ ◦ — and because
# those are not markers, markdown-it reads the line as a paragraph CONTINUATION and my unwrap
# welds it onto the previous bullet. Translating them is the difference between three beats and
# one run-on. `-10%` stays prose: a real marker needs whitespace after it.
_BULLET = re.compile(r"^([ \t]*)[•·‣◦][ \t]+", re.M)


def _unwrap(text: str) -> str:
    """Join a soft-wrapped block. CJK does not use spaces, so a newline between two Han
    characters must vanish, not become a gap in the middle of a word."""
    out: list[str] = []
    for ch in text:
        if ch == "\n":
            if out and _CJK.match(out[-1]):
                continue
            out.append(" ")
        elif ch == "\t":
            out.append(" ")
        else:
            out.append(ch)
    return re.sub(r"[ ]{2,}", " ", "".join(out)).strip()


def _inline(tok) -> str:
    """An inline token → plain text: links keep their label, images their alt, code and
    strikethrough lose their markup, footnote references disappear.

    A `link_open` without an href is markdown-it's parse of a shortcut reference — `[^1]` — i.e.
    a footnote marker whose text IS the pointer. Keeping it painted 「^1」 on a slide is worse
    than dropping it, and the definition line it points at is already gone (markdown-it turns
    `[^1]: …` into a hidden definition token).
    """
    parts: list[str] = []
    skip_depth = 0
    for c in tok.children or []:
        if c.type == "link_open":
            if not dict(c.attrs or {}).get("href"):
                skip_depth += 1
            continue
        if c.type == "link_close":
            skip_depth = max(0, skip_depth - 1)
            continue
        if skip_depth:
            continue
        if c.type in ("em_open", "em_close", "strong_open", "strong_close",
                      "s_open", "s_close"):
            continue
        if c.type == "image":
            parts.append(_inline(c))            # the alt text is the caption; the URL is not
        elif c.type == "html_inline":
            continue
        elif c.type == "softbreak":
            parts.append("\n")
        elif c.type == "hardbreak":
            parts.append(" ")
        else:
            parts.append(c.content)
    text = _unwrap("".join(parts))
    return _FN_REF.sub("", text).strip()


def _table_rows(tokens: list, start: int) -> tuple[list[list[str]], int]:
    """Cells of every row of the table that opens at `tokens[start]`, and the index of its
    closing token (the delimiter row never appears, so rows[0] is always the header)."""
    rows: list[list[str]] = []
    cells: list[str] | None = None
    for j in range(start + 1, len(tokens)):
        tok = tokens[j]
        if tok.type == "table_close":
            return rows, j
        if tok.type == "tr_open":
            cells = []
            rows.append(cells)
        elif tok.type == "inline" and cells is not None:
            cells.append(_inline(tok))
    return rows, len(tokens)


def _table_line(rows: list[list[str]]) -> str:
    rows = [[c.strip() for c in r] for r in rows]
    rows = [r for r in rows if any(r)]
    if not rows:
        return ""
    head, data = rows[0], rows[1:] or rows
    if max((len(r) for r in data), default=0) <= 1:
        return "、".join(r[0] for r in data if r and r[0])       # one column = a list
    if len(data) == 1 and head[0].strip("：:").lower() not in _FIELD_HEADER and len(head) == len(data[0]):
        return "，".join(f"{k}：{v}" for k, v in zip(head, data[0], strict=True) if k and v)
    return "，".join(f"{r[0]}：{' '.join(c for c in r[1:] if c)}" for r in data if r and r[0])


def blocks(text: str) -> list[str]:
    """One plain-text line per markdown block. `#` / `-` markers are re-emitted because the
    segmenter treats a deliberate short line (a heading, a list item) as protected — without
    them 「代价」 would be merged into its neighbour and never become a chapter page."""
    src = _BULLET.sub(r"\1- ", str(text or ""))
    tokens = _MD.parse(_FN_REF.sub("", _FN_DEF.sub("", src)), {})
    lines: list[str] = []
    stack: list[str] = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        t = tok.type
        if t in ("heading_open", "paragraph_open", "blockquote_open", "bullet_list_open",
                 "ordered_list_open", "list_item_open"):
            stack.append({"heading_open": "h", "paragraph_open": "p", "blockquote_open": "q",
                          "bullet_list_open": "l", "ordered_list_open": "l",
                          "list_item_open": "i"}.get(t, "p"))
        elif t in ("heading_close", "paragraph_close", "blockquote_close", "bullet_list_close",
                   "ordered_list_close", "list_item_close"):
            if stack:
                stack.pop()
        elif t == "inline":
            raw = _TASK.sub("", _inline(tok))
            if not raw:
                pass
            elif "i" in stack or "l" in stack:
                lines.append(f"- {raw}")
            elif "h" in stack:
                lines.append(f"# {raw}")
            else:
                lines.append(raw)
        elif t in ("fence", "code_block"):
            body = _unwrap(tok.content or "")
            if body:
                lines.append(body)
        elif t == "html_block":
            body = _unwrap(_TAGS.sub(" ", tok.content or ""))
            if body:
                lines.append(body)
        elif t == "table_open":
            rows, close = _table_rows(tokens, i)
            line = _table_line(rows)
            if line:
                lines.append(line)
            i = close
        i += 1
    return [x for x in (re.sub(r"\s+", " ", ln).strip() for ln in lines) if x]


def normalize(text: str) -> str:
    """Rewrite markdown into the line-per-block text the segmenter was always meant to read.

    Plain prose is unchanged: one paragraph in, one line out.
    """
    src = str(text or "")
    if not src.strip():
        return src
    return "\n".join(blocks(src))
