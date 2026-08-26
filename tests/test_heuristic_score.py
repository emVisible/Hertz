"""启发式评分引擎测试（v0.25）：多信号打分 + 灰区判定 + ScoreStep 接线。"""

from backend.pipeline.producers.heuristic_score import (
    heuristic_score,
    is_gray_zone,
)


def test_high_engagement_scores_high() -> None:
    total, dims = heuristic_score(
        reddit_score=500, upvote_ratio=0.95, num_comments=80,
        title="This amazing trick will blow your mind!",
        item_type="video_raw", created_utc=__import__("time").time(),
    )
    assert total >= 6.0, f"高热度内容应 ≥6，实际 {total}"
    assert dims["community"] > 3
    assert dims["type_match"] > 5


def test_low_signal_scores_low() -> None:
    total, _ = heuristic_score(
        reddit_score=0, upvote_ratio=0.3, num_comments=0,
        title="nsfw politics war death",
        item_type="text_only", created_utc=0,  # 很旧
    )
    assert total < 4.0


def test_gray_zone_detection() -> None:
    assert is_gray_zone(5.8) is True   # 阈值 6.0 ± 0.5 内
    assert is_gray_zone(9.0) is False  # 明确高分
    assert is_gray_zone(2.0) is False  # 明确低分


def test_freshness_decay() -> None:
    import time
    now = time.time()
    fresh_total, _ = heuristic_score(
        created_utc=now - 3600,  # 1h 前
    )
    old_total, _ = heuristic_score(
        created_utc=now - 7 * 86400,  # 7 天前
    )
    assert fresh_total > old_total, "新内容应比旧内容得分高"


def test_title_quality_signals() -> None:
    good = heuristic_score(title="5 amazing facts about space you never knew!")
    bad = heuristic_score(title="nsfw politics spoiler")
    assert good[0] >= bad[0], "含吸引词标题应优于负面词标题"
