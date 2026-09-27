"""Monoline 融合域 Phase 1.2：纯逻辑移植语义锁（monoline/ 为参照实现）。"""

from backend.monoline import display_text, markdown, narration, segment, subtitles, themes


def test_segment_chinese_text() -> None:
    beats = segment.segment_text("第一段内容。第二段内容！第三段内容？")
    assert len(beats) == 3
    assert beats[0] == "第一段内容。"


def test_segment_strips_markdown() -> None:
    beats = segment.segment_text("# 标题\n\n- 列表项一。\n\n正文段落。")
    joined = "".join(beats)
    assert "#" not in joined and "- " not in joined


def test_markdown_blocks_and_normalize() -> None:
    text = "# T\n\n第一段。\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"
    blks = markdown.blocks(text)
    assert len(blks) >= 2
    norm = markdown.normalize(text)
    assert "|" not in norm  # 表格分隔不上屏


def test_display_text_tidy() -> None:
    # 首尾冗余标点清理（句中标点保留）：与 monoline 上游同语义
    assert display_text.tidy("你好，世界。。。") == "你好，世界"
    assert display_text.tidy("中English 混排") == "中English 混排"


def test_narration_clean() -> None:
    spoken = narration.clean("需求->设计->开发。")
    assert "->" not in spoken


def test_subtitles_srt_shape() -> None:
    segs = [
        {"text": "第一句", "start": 0.0, "end": 1.5},
        {"text": "", "start": 1.5, "end": 2.0},  # 空文本被跳过
        {"text": "第三句", "start": 1.5, "end": 3.0},
    ]
    srt = subtitles.to_srt(segs)
    assert srt.startswith("1\n00:00:00,000 --> 00:00:01,500\n第一句")
    assert "第三句" in srt


def test_themes_available_and_resolve() -> None:
    ids = [t["id"] for t in themes.available()]
    assert ids == ["mono-ink", "mono-noir", "mono-paper", "mono-slate"]
    assert themes.resolve({}).id == "mono-ink"
    assert themes.resolve({"theme": "no-such"}).id == "mono-ink"  # 回退默认
    accented = themes.resolve({"accent": "#FFFFFF"})
    assert accented.tokens["color"]["accent"] == "#FFFFFF"
