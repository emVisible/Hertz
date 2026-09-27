"""Scene planner — classify each beat by CONTENT and extract slots.

M1's failure: every middle beat became `statement` with headline = the whole
sentence → "black bg + one big line". The PoC looked good because scenes were
hand-designed (stat numbers, k-v tables, compare, quote). This recovers that
automatically, deterministically, and explainably (each scene records `source`).

Pluggable in spirit: `RulePlanner` is the only implementation, and `llm/planner.upgrade()`
consumes and returns the same scene dicts, so a model verdict goes through the same shape.
"""
from __future__ import annotations

import re

from .display_text import mask_math, outside_math, tidy_slots
from .rotation import rebalance
from .sceneplan import KINDS
from .segment import SentenceSegmenter  # noqa: F401  (re-export for callers)

# Number + unit / arrow tokens that deserve a `stat` treatment.
_NUM = re.compile(r"([↓↑]?\s*[\d][\d.,]*\s*(?:%|％|倍|万|亿|千|美元|美金|元|块|ms|s|秒|分钟|小时|天|周|月|年|岁|个|种|条|位|名|K|M|G|GB|Token|token)?)")
_KV = re.compile(r"([\u4e00-\u9fa5A-Za-z][\w\u4e00-\u9fa5 ]{0,8})\s*[：:]\s*([^，,。；;！!？?]+)")
_QUOTE_WRAP = re.compile(r"^[「“\"『《](.+?)[」”\"』》]$")
_DEF = re.compile(r"^(.{2,10}?)\s*(?:是|是指|称为|叫做|即)\s*(.+)$")
_DEF_BAD_TERM = re.compile(r"[不没也都很这那它谁啥什]")  # 是 is too common; reject pronoun/negation terms
_ENUM = re.compile(r"、")  # true enumeration uses 、 (not the general ，)
# A divider beat announces a CHAPTER. 「第一」 alone is an enumeration ("第一步，打开终端"),
# which is a step, not a section — and an ordered markdown list used to become one divider
# page per item. Only 部分/章/节 count as structural after 第N.
_SECTION_MARK = re.compile(
    r"^(首先|其次|然后|接着|最后|下面|接下来|先看|再看|第[一二三四五六七八九十]+(?:部分|章|节))")
_NOTE_MARK = re.compile(r"(但|需要注意|注意|提醒|以官方为准|口径不一|存疑)")
# A beat that reads as source code is not a statistic: a call, a keyword or an arrow is syntax,
# and the digits inside it are literals. Markdown code spans arrive as plain text by then, so
# the shape is the only signal left. Prose with a bracket — 「同比 (vs 去年)」 — never matches:
# the identifier must sit directly against the parenthesis.
_CODEISH = re.compile(r"[A-Za-z_]\w*\s*\(|\b(?:def|return|import|class)\b|=>|\{\{|\}\}")

# ── V27: content that should render as a diagram (nodes + connectors), not as text ──
# Longest arrow spellings first so "-->" can't be re-split by "->".
_ARROW = re.compile(r"→|⇒|➜|➦|--+>|=>|->")
# "X 分为 A、B、C" / "X 包括以下三个模块：A、B、C" — a head term that owns a list.
_RADIAL = re.compile(
    r"^(.{2,14}?)(?:主要|大致|一共)?(分为|包括|涵盖|包含|划分为|由|分别是|涉及|覆盖)"
    r"(?:以下|如下|这)?[一二三四五六七八九十\d]{0,3}"
    r"(?:个|项|类|种|部分|方面|环节|步骤|维度|模块)?\s*[:：]?\s*(.+)$"
)
_STEP_MARK = re.compile(r"[①②③④⑤⑥⑦⑧⑨⑩]|第\s*[一二三四五六七八九十1-9]\s*[步次阶段期]")
# A "标题：" lead-in that names the diagram rather than being one of its parts.
_LEAD_LABEL = re.compile(r"^([^，,。；;]{2,10}?)\s*[:：]\s*(.+)$")


# Kinds that carry their own picture — they outrank the positional summary rule.
# Derived from the registry, because a hand-maintained list goes stale: a timeline on
# the last beat was being turned into a summary by exactly this omission.
_TEXT_KINDS = {"title", "statement", "section", "definition", "quote", "note", "summary", "split"}
_SHAPE_KINDS = {k for k in KINDS if k not in _TEXT_KINDS}

# V48: only the marks that GB/T forbids on a display line. ？ ！ … used to be stripped
# here too, which deleted the whole point of a question headline — display_text.tidy() is
# now the single owner of the end-of-line rule.
_TRAIL = re.compile(r"[。．.；;]+$")
# A clause can open with ellipsis or dashes after a split ("……魅力得自己去挣"); on a
# 120px display line that leading punctuation reads as a rendering glitch.
_LEAD_PUNCT = re.compile(r"^[\s。.…、，,;；:：·—–~～]+")

# Leading discourse markers that make poor on-slide keywords — distill skips them.
_LEAD_CONNECT = {
    "总之", "综上", "总的来说", "首先", "其次", "再次", "然后", "最后",
    "因此", "所以", "但是", "然而", "而且", "并且", "另外", "此外", "同时",
    "其实", "事实上", "例如", "比如", "也就是说", "简而言之",
}
# Short prepositional/comparative/narrative openers ("相比旧版，…" / "起初，…") that set
# up rather than carry the point — skipped only when short and followed by substance.
_SETUP_PREFIX = ("相比", "对于", "关于", "随着", "为了", "通过", "根据", "基于", "针对", "与其",
                 "起初", "后来", "随后", "于是", "接着", "从此", "那天", "那晚", "那年", "当晚", "首先")
# Short clauses ending in a temporal frame ("那晚之后", "三年以后") are lead-ins too.
_TEMPORAL_SUFFIX = ("之后", "以后", "之前", "以前", "以来")


def _is_lead_clause(p: str) -> bool:
    if p in _LEAD_CONNECT:
        return True
    if len(p) <= 6 and (p.startswith(_SETUP_PREFIX) or p.endswith(_TEMPORAL_SUFFIX)):
        return True
    return False


def distill_keyword(text: str, *, max_len: int = 12) -> tuple[str, bool]:
    """Distill a sentence to a short on-slide keyword.

    Returns (keyword, is_clean_split). is_clean_split=True when we found a natural
    clause meaningfully shorter than the full sentence → the slide shows the keyword
    and the full sentence becomes the caption. When no clean keyword exists, returns
    (full_sentence, False) → slide shows the sentence, no caption (no duplication).
    """
    s = _LEAD_PUNCT.sub("", _TRAIL.sub("", text.strip()))
    parts = [_LEAD_PUNCT.sub("", p).strip() for p in re.split(r"[，、：；,;]", s) if p.strip()]
    # prefer the first clause that isn't a bare connective or short setup ("总之" / "相比旧版")
    first = next((p for p in parts if not _is_lead_clause(p)), parts[0] if parts else s)
    if 2 <= len(first) <= max_len and len(first) < len(s):
        return first, True
    if len(s) <= max_len:
        return s, False  # whole sentence is already short → title card, no caption
    return s, False


def _not_a_statistic(s: str, num: str) -> bool:
    """Numbers that must not be promoted to a hero figure.

    「这是第10句」 counts sentences and 「根本不像40多岁的人」 approximates an age — a giant
    10 or 40 turns a counter or a fuzzy range into a magnitude the script never claimed,
    and strands the leftover 句/多岁 in the label.  Code is the same trap: a markdown code
    span arrives as plain text, and `def f(x): return x * 2` was being promoted to a giant 2.
    """
    d = re.escape(num.strip())
    return bool(re.search(r"[第]\s*" + d, s)
                or re.search(d + r"\s*(?:[步章节条款次句]|[多来几]|左右|上下)", s)
                or _CODEISH.search(s))


def _strip_number(sentence: str) -> str:
    # outside a formula: `\frac{1}{2}` has digits that belong to the notation, and deleting
    # them would hand the template LaTeX that no renderer can parse
    s = outside_math(sentence, lambda r: _NUM.sub("", r))
    s = re.sub(r"[，,、：:\s]+$", "", s).strip("，,、：: ")
    return s


def _flow_nodes(s: str) -> tuple[str, list[str]]:
    """'流程：A→B→C' → ('流程', [A,B,C]). Empty unless it's a real chain of ≥3 short,
    self-contained nodes — a bare "0→1" range or a numeric span isn't a diagram."""
    parts = [p.strip(" \t") for p in _ARROW.split(s)]
    if len(parts) < 3:
        return "", []
    title = ""
    lead = _LEAD_LABEL.match(parts[0])
    if lead:
        title, parts[0] = lead.group(1).strip(), lead.group(2).strip()
    nodes = [p for p in parts if p]
    if len(nodes) < 3 or any(len(x) > 14 or re.search(r"[、，,。；;]", x) for x in nodes):
        return "", []
    return title, nodes[:6]


def _radial(s: str) -> tuple[str, list[str]]:
    """'系统分为感知、决策、执行三层' → ('系统', [感知,决策,执行三层]). A head term that
    owns an enumeration is the hub; the enumeration items are its branches."""
    m = _RADIAL.match(s)
    if not m:
        return "", []
    term, tail = m.group(1).strip(), m.group(3)
    items = [x.strip(" \t") for x in (re.split(r"、", tail) if "、" in tail else re.split(r"[，,]", tail))]
    items = [_TAIL_COUNT.sub("", x).strip(" ，,、的") for x in items]
    items = [x for x in items if 2 <= len(x) <= 10]
    if len(items) < 3:
        return "", []
    return term, items[:5]


def _steps(s: str) -> tuple[str, list[str]]:
    """'节奏：①调研 ②试点 ③推广' / '第一步…第二步…' → a numbered timeline."""
    marks = list(_STEP_MARK.finditer(s))
    if len(marks) < 2:
        return "", []
    head = re.sub(r"\s*[:：]\s*$", "", s[:marks[0].start()].strip(" ，,。"))
    title = head if 2 <= len(head) <= 14 else ""
    out: list[str] = []
    for idx, m in enumerate(marks):
        end = marks[idx + 1].start() if idx + 1 < len(marks) else len(s)
        body = s[m.end():end].strip(" ，,、：:；;")
        if not body or len(body) > 18 or "。" in body:
            return "", []
        out.append(body)
    return title, out[:5]


def apply_icons(scenes: list[dict], beats: list[str]) -> None:
    """Give every scene an icon (kind default, else picked from its beat). In-place, and
    re-run after an LLM upgrade so a promoted beat doesn't keep the old kind's icon."""
    from .icons import KIND_ICON, pick_icon
    for sc in scenes:
        icon = KIND_ICON.get(sc["kind"], "")
        if not icon:  # sparse kinds (statement/note): pick a contextual icon from the beat text
            idx = sc["i"]
            icon = pick_icon(beats[idx] if 0 <= idx < len(beats) else "")
        sc["slots"]["icon"] = icon


def number_sections(scenes: list[dict]) -> None:
    """V9-6: number section beats so chapter breaks read as "01 / 02 …"."""
    sec = 0
    for sc in scenes:
        if sc["kind"] == "section":
            sec += 1
            sc["slots"]["index"] = f"{sec:02d}"



# ── V30: numeric ladders, closed loops and layer stacks ─────────────────────────
_NUMV = re.compile(r"^[-+]?[\d.,]+\s*(%|％|倍|万|亿|千|人|次|元|块|户|家|台|单|ms|s|秒|分钟|小时|天|周|月|年|[KMGB]|GB|Token|token)?$")
_LOOP_MARK = re.compile(r"(循环|闭环|反馈环|周而复始|反复|回流|飞轮|雪球|正循环)")
# "…监控四层" — the count belongs to the sentence, not to the last node's name.
_TAIL_COUNT = re.compile(r"[一二三四五六七八九十\d]+(层|个|项|种|部分|方面|模块|环节|步骤|维度|级)$")
_LAYER_MARK = re.compile(r"([一二三四五六七八九十\d]层|分层|堆叠|层次|底层|顶层|中层)")
# A funnel is one flow losing population. Without one of these words a decreasing
# number list is just a comparison of unrelated metrics (速度/功耗/成本), which is a
# bar chart — drawing it as a funnel would claim a relationship that isn't there.
# 留存/流失 are deliberately absent: as often a standalone rate (留存 45%) as a funnel
# stage, and a false funnel is worse than a missed one.
_FUNNEL_MARK = re.compile(
    r"(漏斗|转化|转化率|链路|曝光|点击|加购|下单|成交|付费|线索|商机|试用|注册|报名|筛选)")

# ── V31d: colon-free metric lists (kpi) and dated milestones (timeline) ─────────
# 「日活 120 万，留存 45%，营收 3.2 亿」 has no colons, so _KV never sees it and it
# used to fall through to a plain sentence. A chunk is label + number + optional unit.
_UNIT_ALT = r"%|％|万|亿|元|人|次|天|周|月|小时|分钟|ms|s|秒|倍|台|单|家|户|字|K|M|G|GB"
# a number plus whatever unit glyph sits right after it ('' when bare) — used to tell
# whether two numbers are even comparable before a chart is drawn through them
_NUM_UNIT = re.compile(r"([\d][\d.,]*)\s*(" + _UNIT_ALT + r")?")
_METRIC_LEAD = re.compile(r"^(其中|另外|同时|以及)")
_METRIC_CHUNK = re.compile(
    r"^([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9]{0,7}?)\s*"
    r"(?:(?:仅|只|约|已)?\s*(?:占|为|是|达|达到))?\s*"
    r"([\d][\d.,]*)\s*(" + _UNIT_ALT + r")?\s*$")

_DATE_CHUNK = re.compile(r"^(20\d{2}|19\d{2})\s*年?|[Qq一二三四]\s*[度Q]|^\d{1,2}\s*月")
_SPLIT_CHUNKS = re.compile(r"[，,、；;。]")
_FROM_TO = re.compile(r"(从|由)[^，,。]{0,8}?(到|至|涨到|升到|降到|跌至|扩至|升至)")
# A 2×2 grid needs two named dimensions, so only an explicit quadrant word earns it.
# Source boilerplate, not a narrative point: a bare URL, a 「链接：」/「来源：」 label, or a
# republication notice. Measured on the real corpus these three shapes have 0 false
# positives; looser heuristics (any trailing comma, any short clause) hit only prose that
# the segmenter had split mid-sentence, which is a different problem.
_SOURCE_JUNK = re.compile(
    r"^(?:https?://|www\.|//\w)|^\s*(?:链接|来源|出处|摘自)\s*[：:]"
    r"|(?:转载请注明出处|商业转载请|版权归原作者|版权归)")
# A 2×2 grid needs two named dimensions, so only an explicit quadrant word earns it.
_MATRIX_MARK = re.compile(r"(四象限|象限|矩阵|二维定位)")
_AXIS = re.compile(r"([^\s，,。；;、：:（）()]{1,6}?)\s*(?:轴|维度)")


def _numeric(v: str) -> bool:
    return bool(_NUMV.match((v or "").strip()))


def _chunks(s: str) -> list[str]:
    return [c.strip() for c in _SPLIT_CHUNKS.split(s) if c.strip()]


def _lead(s: str) -> tuple[str, str]:
    """'市场份额：芯片 45%，整机 30%…' → ('市场份额', '芯片 45%，整机 30%…').

    The lead label is the scene title, not the first item's name — without splitting it
    off, the first chunk carries a colon and no metric pattern matches it."""
    m = _LEAD_LABEL.match(s)
    return (m.group(1).strip(), m.group(2).strip()) if m else ("", s)


def _share(s: str) -> tuple[str, list[dict]]:
    """'安卓 45%，iOS 30%，其他 25%' → a part-of-whole ring.

    Every chunk must carry a percentage *and* the parts must add up to roughly one
    whole. Otherwise it's a set of unrelated rates (kpi), and drawing a donut would
    claim they exhaust a pie they don't belong to."""
    title, body = _lead(s)
    out = []
    for c in _chunks(body):
        m = _METRIC_CHUNK.match(c)
        unit = (m.group(3) or "").strip() if m else ""
        if not m or unit not in ("%", "％") or len(m.group(1).strip()) < 2:
            return "", []
        out.append({"k": m.group(1).strip(), "v": f"{m.group(2).strip()}%"})
    if len(out) < 2:
        return "", []
    total = sum(float(v["v"].rstrip("%")) for v in out)
    # ±5pp only: a ring whose parts add to 85% quietly deletes 15% of the whole.
    if not 95.0 <= total <= 105.0:
        return "", []
    return title, out[:4]


def _trend(s: str) -> tuple[str, list[str]]:
    """'1.2 亿、1.9 亿、2.4 亿、3.1 亿' or '从 12% 涨到 48%' → a series line.

    Needs 3+ numbers, or 2 with an explicit 从…到…: two lone numbers are a comparison
    (bars), and calling that a trend would invent an ordering between them.

    Every number must carry the same unit. 「一段 300 字的稿子，从粘贴到出片平均 21.7 秒」
    has a 从…到… and two numbers, but 字 and 秒 are not a series — drawing a falling line
    through them states something the文稿 never said."""
    title, body = _lead(s)
    hits = [(m.group(1), m.group(2) or "") for m in _NUM_UNIT.finditer(body)
            if any(ch.isdigit() for ch in m.group(1))]
    nums = [f"{n}{u}" for n, u in hits]        # unit rides along — it is the axis label
    span = bool(_FROM_TO.search(body))
    if len(nums) < 3 and not (span and len(nums) == 2):
        return "", []
    if len({u for _, u in hits}) > 1:
        return "", []
    return title, nums[:8]


def _matrix(s: str) -> tuple[str, str, str, list[str]]:
    """'四象限：重要紧急、重要不紧急…' → a 2×2 quadrant grid.

    Only an explicit quadrant/matrix word qualifies — four parallel items alone are a
    list, and forcing them into a grid would claim two axes that the text never named.
    Axes are read only if stated (「效率轴」「规模维度」); otherwise they stay blank."""
    if not _MATRIX_MARK.search(s):
        return "", "", "", []
    title, body = _lead(s)
    if not title and "：" in body:                      # a long lead label (「按…切成矩阵：」)
        head, _, tail = body.partition("：")
        if 2 <= len(head.strip()) <= 18 and not _NUM.search(head):
            title, body = head.strip(), tail.strip()
    if _MATRIX_MARK.fullmatch(title or ""):
        title = ""                       # 「四象限：」 is the shape's name, not a headline
    cells = [c.strip() for c in _SPLIT_CHUNKS.split(body) if 2 <= len(c.strip()) <= 14]
    cells = [c for c in cells if not _MATRIX_MARK.fullmatch(c)]
    if len(cells) != 4:      # a quadrant means four; 2-3 items is a list, not a grid
        return "", "", "", []
    # strip the particles that attach to an axis word (「按效率轴」「和规模维度」) so the
    # label on the slide reads 效率 / 规模, not 按效率 / 和规模
    axes = [re.sub(r"^(按|和|与|及|把|对|为|是|的|在)+", "", m.group(1).strip()) for m in _AXIS.finditer(s)]
    axes = [a for a in axes if len(a) >= 2]
    return title, (axes[0] if axes else ""), (axes[1] if len(axes) > 1 else ""), cells[:4]


def _timeline(s: str) -> tuple[str, list[dict]]:
    """'2019 创业，2021 拿 A 轮，2024 上市' → dated milestones on an axis.

    Needs ≥2 chunks that each open with a date, so a sentence that merely mentions a
    year stays a statement. The date becomes the tick label; the rest is the event."""
    title, body = _lead(s)
    out = []
    for c in _chunks(body):
        m = _DATE_CHUNK.search(c)
        if not m:
            continue
        event = (c[:m.start()] + c[m.end():]).strip(" ：:，,、")
        out.append({"k": m.group(0).strip(), "v": event})
    if len(out) < 2:
        return "", []
    if _DATE_CHUNK.search(title):
        title = ""
    return title, out[:6]


def _kpis(s: str) -> tuple[str, list[dict]]:
    """'日活 120 万，留存 45%，营收 3.2 亿' → metric cards.

    Colon-free, so _KV never sees these. Cards rather than bars when the units differ:
    120 万 and 45% are not comparable lengths, and normalizing them into one axis would
    invent a ranking that the numbers don't support."""
    title, body = _lead(s)
    out = []
    for c in _chunks(body):
        m = _METRIC_CHUNK.match(c)
        if not m or _DATE_CHUNK.search(c):
            return "", []                      # one non-metric chunk breaks the set
        raw = m.group(1).strip()
        # 「其中配音」 is a discourse lead-in, not part of the metric's name
        label = _METRIC_LEAD.sub("", raw).strip() or raw
        num, unit = m.group(2).strip(), (m.group(3) or "").strip()
        if len(label) < 2:
            return "", []
        out.append({"k": label, "v": f"{num}{unit}"})
    if len(out) < 2:
        return "", []
    return title, out[:4]


_STEP = re.compile(r"^(\S{1,6}?)\s*[：:]?\s*([-+]?[\d.,]+\s*\S{0,3})$")


def _cycle_nodes(s: str) -> tuple[str, list[str]]:
    """'A→B→C→A' (or a loop word + an arrow chain) → a ring. The repeated closing node
    is dropped: the arc back to the start is drawn by the template, not listed twice."""
    parts = [x.strip(" \t") for x in _ARROW.split(s)]
    if len(parts) < 3:
        return "", []
    title = ""
    lead = _LEAD_LABEL.match(parts[0])
    if lead:
        title, parts[0] = lead.group(1).strip(), lead.group(2).strip()
    nodes = [x for x in parts if x and not re.search(r"[、，,。；;]", x)]
    if len(nodes) < 3 or any(len(x) > 12 for x in nodes):
        return "", []
    head, tailn = _norm_node(nodes[0]), _norm_node(nodes[-1])
    returns = head == tailn or (len(head) >= 2 and (head in tailn or tailn in head))
    if not (returns or _LOOP_MARK.search(s)):
        return "", []
    if returns:
        nodes = nodes[:-1]
    return title, nodes[:6]


def _norm_node(x: str) -> str:
    return re.sub(r"[\s的]", "", x or "")


def _layers(s: str) -> tuple[str, list[str]]:
    """'平台分为接入、服务、存储三层' → a stack, not a mind map: the word 层 says the
    items sit on top of each other."""
    if not _LAYER_MARK.search(s):
        return "", []
    rt, rnodes = _radial(s)
    if not rnodes:
        return "", []
    return rt, rnodes


def md_heading_texts(script: str) -> set[str]:
    """Normalized text of every markdown heading in the source (markdown-it, commonmark).

    Parsing with a real markdown parser rather than a regex is the point: `#` inside code
    fences, setext underlines and `## 标题  ` all behave differently, and a wrong match here
    silently turns a sentence into a divider page.
    """
    from markdown_it import MarkdownIt
    try:
        toks = MarkdownIt("commonmark").parse(script or "")
    except Exception:
        return set()
    out: set[str] = set()
    for i, t in enumerate(toks):
        if t.type == "heading_open" and i + 1 < len(toks) and toks[i + 1].type == "inline":
            norm = _norm(toks[i + 1].content)
            if norm:
                out.add(norm)
    return out


def _norm(s: str) -> str:
    """Case/punctuation-folded text, so the heading 「机制」 meets the beat 「机制。」."""
    return re.sub(r"[\s。，,、：:；;！!？?「」『』“”‘’()（）\.·\-—]", "", str(s or "")).lower()


class RulePlanner:
    def plan(self, beats: list[str], *, brand: str = "Monoline", date_eyebrow: str = "",
             script: str = "") -> list[dict]:
        n = len(beats)
        scenes: list[dict] = []
        for i, b in enumerate(beats):
            if i == 0:
                scenes.append(self._title(b, brand, date_eyebrow))
            elif i == n - 1 and n > 2:
                # A closing line is usually a takeaway, so it becomes the summary card —
                # unless the sentence has a real shape to draw. Position must not eat a
                # funnel/stat/diagram that happens to land last.
                shaped = self._classify(i, b)
                if shaped["kind"] in _SHAPE_KINDS:
                    scenes.append(shaped)
                else:
                    ts = self._text_slots(b)
                    scenes.append({"i": i, "kind": "summary", "source": "rules:position",
                                   "slots": {"eyebrow": "In short", "headline": ts["headline"], "verbatim": ts["verbatim"]}})
            else:
                scenes.append(self._classify(i, b))
        scenes = self._mark_md_headings(scenes, beats, script)
        scenes = rebalance(scenes, beats)      # whole-piece view: no 12-beat run of one layout
        # (section labels are derived at compose time so manual and model paths get them too)
        for s in scenes:
            s["slots"] = tidy_slots(s["kind"], s["slots"])
        apply_icons(scenes, beats)
        number_sections(scenes)
        return scenes

    def _clean(self, s: str) -> str:
        return s.strip().rstrip("。")

    def _text_slots(self, b: str) -> dict:
        kw, clean = distill_keyword(b)
        return {"headline": kw, "verbatim": (not clean)}

    def _mark_md_headings(self, scenes: list[dict], beats: list[str], script: str) -> list[dict]:
        """A markdown heading in the source becomes a divider beat, whatever the prose rules said.

        The segmenter strips `# ` (V20), so the marker is already gone by beat time — structure
        has to be read from the raw script and matched back to the beat that came from it.
        """
        heads = md_heading_texts(script)
        if not heads:
            return scenes
        out = []
        for sc, b in zip(scenes, beats, strict=True):
            if _norm(b) in heads:
                s = dict(sc)
                s["kind"] = "section"
                s["source"] = "rules:md-heading"
                s["slots"] = {"title": b.strip(" 。.，,、"), "verbatim": False}
                out.append(s)
            else:
                out.append(sc)
        return out

    def _title(self, b: str, brand: str, date_eyebrow: str) -> dict:
        if _SECTION_MARK.match(b.strip()):
            # An explicit chapter mark on line 1 is a divider, not the film's title card —
            # claiming it here is what left the opening section with no label to propagate.
            return self._classify(0, b)
        ts = self._text_slots(b)
        return {"i": 0, "kind": "title", "source": "rules:first-line",
                "slots": {"eyebrow": date_eyebrow or brand, "headline": ts["headline"], "sub": brand, "verbatim": ts["verbatim"]}}

    def _classify(self, i: int, b: str) -> dict:
        s = self._clean(b)
        # `$…$` is notation, not a magnitude. A beat whose only digits sit inside a formula
        # used to become a giant "2" (rules:number) or a three-point sparkline of the
        # fraction exponents (rules:number-series). `figures` gates every number-driven rule
        # and `sm` owns the one that has to pick the value; `s` still supplies display text,
        # LaTeX intact, so masking can never paint a ▮.
        sm = mask_math(s)
        figures = any(c.isdigit() for c in sm)

        # source boilerplate first: it must never reach the screen as a display headline
        if _SOURCE_JUNK.search(s):
            return {"i": i, "kind": "note", "source": "rules:source-junk",
                    "slots": {"marker": "!", "body": s, "verbatim": True}}

        # quote: whole beat wrapped in quotes
        m = _QUOTE_WRAP.match(s)
        if m:
            return {"i": i, "kind": "quote", "source": "rules:quote-wrap",
                    "slots": {"q": m.group(1), "attr": "", "verbatim": True}}

        # note: caveat markers
        if _NOTE_MARK.search(s):
            return {"i": i, "kind": "note", "source": "rules:note-mark",
                    "slots": {"marker": "!", "body": s, "verbatim": True}}

        # ≥2 k:v pairs: a numeric comparison is a chart, everything else is a table.
        # Ordered funnel → bars → table: a non-increasing ladder reads as conversion,
        # other all-numeric sets read as comparison, mixed text needs the table.
        pairs = _KV.findall(s)
        if len(pairs) >= 2:
            pv = [_num_of(v) for _k, v in pairs]
            allnum = len(pv) >= 2 and all(_numeric(v) for _k, v in pairs) and all(x is not None for x in pv)
            ladder = allnum and len(pairs) >= 3 and all(b <= a for a, b in zip(pv, pv[1:], strict=False))
            # A decreasing numeric list is only a funnel if the beat is actually about
            # one flow losing people. 「速度 120 / 功耗 45 / 成本 30」 also decreases —
            # that is a comparison of three metrics, and drawing it as a funnel is a lie.
            if ladder and _FUNNEL_MARK.search(s):
                ft = _LEAD_LABEL.match(s)
                return {"i": i, "kind": "funnel", "source": "rules:numeric-ladder",
                        "slots": {"title": (ft.group(1).strip() if ft else ""),
                                  "stages": [{"k": k.strip(), "v": v.strip()} for k, v in pairs[:5]],
                                  "verbatim": True}}
            if allnum and len(set(pv)) >= 2:
                bt = _LEAD_LABEL.match(s)
                return {"i": i, "kind": "bars", "source": "rules:numeric-compare",
                        "slots": {"title": (bt.group(1).strip() if bt else ""),
                                  "rows": [{"k": k.strip(), "v": v.strip()} for k, v in pairs[:6]],
                                  "verbatim": True}}
            return {"i": i, "kind": "table", "source": "rules:kv-pairs",
                    "slots": {"title": "", "rows": [{"k": k.strip(), "v": v.strip()} for k, v in pairs[:6]]}}

        lt, lst = _ladder_stages(s) if figures else ("", [])
        if lst and _FUNNEL_MARK.search(s):
            return {"i": i, "kind": "funnel", "source": "rules:numeric-ladder",
                    "slots": {"title": lt, "stages": lst, "verbatim": True}}

        # cycle: a closed arrow chain is a ring, not a line
        ct, cnodes = _cycle_nodes(s)
        if cnodes:
            return {"i": i, "kind": "cycle", "source": "rules:closed-loop",
                    "slots": {"title": ct, "nodes": cnodes, "verbatim": True}}

        # arch: "…三层" is a stack; without the layer word it stays a mind map
        at, alayers = _layers(s)
        if alayers:
            return {"i": i, "kind": "arch", "source": "rules:layer-stack",
                    "slots": {"title": at, "layers": alayers, "verbatim": True}}

        # V27 flow: an arrow chain renders as connected nodes, not as a sentence.
        # Ahead of `stat` so "效率翻3倍→周期砍半→成本降三成" isn't reduced to one number.
        ft, fnodes = _flow_nodes(s)
        if fnodes:
            return {"i": i, "kind": "flow", "source": "rules:arrow-chain",
                    "slots": {"title": ft, "nodes": fnodes, "verbatim": True}}

        # V31d timeline: ≥2 dated milestones read as an axis, not as a sentence.
        tt, tpts = _timeline(s) if figures else ("", [])
        if tpts:
            return {"i": i, "kind": "timeline", "source": "rules:dated-milestones",
                    "slots": {"title": tt, "rows": tpts, "verbatim": True}}

        # V31f matrix: an explicit quadrant/matrix word turns a 4-item set into a grid.
        mt, mx, my, mcells = _matrix(s)
        if mcells:
            return {"i": i, "kind": "matrix", "source": "rules:quadrant",
                    "slots": {"title": mt, "x_axis": mx, "y_axis": my, "cells": mcells,
                              "verbatim": True}}

        # V31e share: percentages that add up to one whole → a ring. Ahead of kpi
        # because a share set is also a labelled metric list.
        st, sparts = _share(s) if figures else ("", [])
        if sparts:
            return {"i": i, "kind": "share", "source": "rules:part-of-whole",
                    "slots": {"title": st, "rows": sparts, "verbatim": True}}

        # V31d metric list without colons (「日活 120 万，留存 45%」) — _KV never sees it.
        # Bare numbers of one kind are comparable → bars; mixed units are not, so they
        # become KPI cards rather than bars whose lengths would imply a ranking.
        kt, kcards = _kpis(s) if figures else ("", [])
        if kcards:
            vals = [c["v"] for c in kcards]
            if all(re.fullmatch(r"[\d.,]+", v) for v in vals) and len(set(vals)) >= 2:
                return {"i": i, "kind": "bars", "source": "rules:metric-list",
                        "slots": {"title": kt, "rows": kcards, "verbatim": True}}
            return {"i": i, "kind": "kpi", "source": "rules:metric-list",
                    "slots": {"title": kt, "rows": kcards, "verbatim": True}}

        # V31e trend: a run of numbers (or an explicit 从…到…) reads as a line, not a list.
        rt, rseries = _trend(s) if figures else ("", [])
        if rseries:
            return {"i": i, "kind": "trend", "source": "rules:number-series",
                    "slots": {"title": rt, "series": rseries, "verbatim": True}}

        # stat: a dominant number/percent/price token. Read from the masked copy: the hero
        # figure must be a number the script claims, not a formula's exponent.
        nums = [x.strip() for x in _NUM.findall(sm) if any(c.isdigit() for c in x)]
        if len(nums) == 1 and len(s) <= 44 and not _not_a_statistic(sm, nums[0]):
            label = _strip_number(s) or s
            return {"i": i, "kind": "stat", "source": "rules:number",
                    "slots": {"value": nums[0], "unit": "", "label": label}}

        # definition: "X 是 Y" — but 是 is common; require a real noun term (no negation/pronoun)
        dm = _DEF.match(s)
        if dm and len(dm.group(1)) >= 2 and not _DEF_BAD_TERM.search(dm.group(1)) and len(dm.group(2)) >= 4:
            return {"i": i, "kind": "definition", "source": "rules:definition",
                    "slots": {"term": dm.group(1), "gloss": self._clean(dm.group(2))}}

        # V27 radial: a hub term owning an enumeration → mind-map (center + branches).
        rt, rnodes = _radial(s)
        if rnodes:
            return {"i": i, "kind": "radial", "source": "rules:hub-enumeration",
                    "slots": {"hub": rt, "nodes": rnodes, "verbatim": True}}

        # V27 steps: inline ordinals (①②③ / 第一步…) → numbered timeline
        st, ssteps = _steps(s)
        if ssteps:
            return {"i": i, "kind": "steps", "source": "rules:ordinal-chain",
                    "slots": {"title": st, "steps": ssteps, "verbatim": True}}

        # list: true 、-enumeration of 3+ short parallel items
        if "、" in s:
            # The lead-in rides on the first chunk ("拆成七步：写稿") and gets it killed by
            # the length filter, silently dropping an item. Cut at the colon first.
            src = s.split("：")[-1] if "：" in s else s
            items = [x.strip(" 。.") for x in _ENUM.split(src) if 2 <= len(x.strip(" 。.")) <= 12]
            if len(items) >= 3:
                return {"i": i, "kind": "list", "source": "rules:enumeration",
                        "slots": {"title": "", "items": items[:8]}}

        if _SECTION_MARK.match(s):
            ts = self._text_slots(b)
            return {"i": i, "kind": "section", "source": "rules:section-mark",
                    "slots": {"title": ts["headline"], "verbatim": ts["verbatim"]}}

        # default: statement — slide shows a distilled keyword, caption carries the sentence
        ts = self._text_slots(b)
        return {"i": i, "kind": "statement", "source": "rules:default",
                "slots": {"headline": ts["headline"], "verbatim": ts["verbatim"]}}


def plan_scenes(beats: list[str], **kw: object) -> list[dict]:
    return RulePlanner().plan(beats, **kw)  # type: ignore[arg-type]


def _ladder_stages(s: str) -> tuple[str, list[dict]]:
    lead = _LEAD_LABEL.match(s)
    body = lead.group(2) if lead else s
    parts = [x.strip() for x in re.split(r"、|[，,]", body) if x.strip()]
    stages: list[dict] = []
    for x in parts:
        m = _STEP.match(x)
        if m:
            stages.append({"k": m.group(1).strip(" ：:"), "v": m.group(2).strip()})
    if len(stages) < 3 or (lead and len(lead.group(1)) > 10):
        return "", []
    # A funnel means LOSS. An enumeration that grows ("2019 年、2020 年、2021 年") is a
    # timeline, and drawing it as a funnel would flat-line into a misleading block.
    vals = [_num_of(s["v"]) for s in stages]
    if any(v is None for v in vals) or any(b > a for a, b in zip(vals, vals[1:], strict=False)):
        return "", []
    return (lead.group(1).strip() if lead else ""), stages[:5]


def _num_of(v: str) -> float | None:
    """The leading number of a value like "3,400 人" (unit ignored), or None."""
    m = re.match(r"^([-+]?[\d.,]+)", (v or "").strip())
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", ""))
    except ValueError:
        return None
