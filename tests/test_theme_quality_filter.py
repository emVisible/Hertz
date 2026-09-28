"""v0.34 A：未评分区「情感主题轴 + 质量轴 + 正文轴」服务端筛选。

存在理由（用户原话）：「未评分中我需要能筛选到情感相关的，因为我现在准备直接做
情感相关的一个垂直服务……现在我更注重质量，很多东西需要我后面去加工」。

三件事各自只有一个作者，本文件把它们钉住：
- 「哪些 subreddit 算情感」= `category.THEME_SUBREDDITS`；
- 三档质量阈值 + 正文字数门槛 = `quality.QUALITY_TIERS` / `quality.MIN_STORY_CHARS`；
- WHERE 条件本身 = `service_queries.axis_filters()`（列表与 facets 共用一份）。

测试**不依赖开发库存量**：合成行走专属 `source`，跑完删掉。
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete

from backend.models.item import Item
from backend.models.session import session_factory

#: 合成行专属 source 标记——测试库里别的测试留了历史数据，按 source 收口才不会被串扰
SOURCE = "v034a-probe"

#: 情感主题成员（照 `category.py`「# 情感类」注释下的那 17 条，逐条抄录）
SENTIMENT_MEMBERS = [
    "MadeMeSmile",
    "MadeMeCry",
    "HumansBeingBros",
    "wholesome",
    "wholesomememes",
    "TikTokCringe",
    "ContagiousLaughter",
    "WatchPeopleDieInside",
    "AmItheAsshole",
    "TrueOffMyChest",
    "offmychest",
    "relationship_advice",
    "relationships",
    "JustNoFamily",
    "BestofRedditorUpdates",
    "confessions",
    "happycryingdads",
]

#: 改动**前**的 SUBREDDIT_TID_MAP 快照（85 键，按 key 排序固化）。
#: 主题化重构的等价性判据：逐键相等，零行为变化。这不是「看起来一样」——
#: 情感类和日常类共用 tid 21，注释块边界一旦读错就会静默改掉 17 条的归属。
FROZEN_SUBREDDIT_TID_MAP: dict[str, int] = {
    "AbruptChaos": 138,
    "AmItheAsshole": 21,
    "AnimalsBeingBros": 152,
    "AnimalsBeingDerps": 152,
    "AnimalsBeingJerks": 152,
    "animalsdoingstuff": 152,
    "AskReddit": 36,
    "aww": 152,
    "awwnverts": 152,
    "BeAmazed": 21,
    "BestofRedditorUpdates": 21,
    "blackmagicfuckery": 21,
    "bodybuilding": 158,
    "cats": 152,
    "chemistry": 85,
    "confessions": 21,
    "ContagiousLaughter": 21,
    "Cooking": 23,
    "Damnthatsinteresting": 21,
    "dogpictures": 152,
    "EarthPorn": 152,
    "explainlikeimfive": 36,
    "facepalm": 138,
    "fitness": 158,
    "food": 23,
    "FoodPorn": 23,
    "funny": 138,
    "gadgets": 71,
    "gamedev": 4,
    "Games": 4,
    "gaming": 4,
    "gifs": 21,
    "happycryingdads": 21,
    "holdmyfeedingtube": 138,
    "HumansBeingBros": 21,
    "IdiotsInCars": 138,
    "instant_regret": 138,
    "interestingasfuck": 21,
    "JustNoFamily": 21,
    "likeus": 152,
    "MadeMeCry": 21,
    "MadeMeSmile": 21,
    "math": 36,
    "maybemaybemaybe": 138,
    "mildlyinfuriating": 138,
    "mildlyinteresting": 21,
    "nature": 152,
    "NatureIsFuckingLit": 152,
    "nextfuckinglevel": 21,
    "nonononoyes": 138,
    "oddlysatisfying": 21,
    "offmychest": 21,
    "pcgaming": 4,
    "petsthefast": 152,
    "physics": 85,
    "pics": 21,
    "programming": 71,
    "progresspics": 158,
    "PublicFreakout": 138,
    "rarepuppers": 152,
    "recipes": 23,
    "relationship_advice": 21,
    "relationships": 21,
    "running": 158,
    "science": 85,
    "space": 85,
    "StartledCats": 152,
    "technology": 71,
    "therewasanattempt": 138,
    "TikTokCringe": 21,
    "todayilearned": 36,
    "toptalent": 21,
    "travel": 155,
    "traveltips": 155,
    "TrueOffMyChest": 21,
    "Unexpected": 21,
    "VideoEditing": 71,
    "videos": 21,
    "WatchPeopleDieInside": 21,
    "weightlifting": 158,
    "Whatcouldgowrong": 138,
    "wholesome": 21,
    "wholesomememes": 21,
    "WTF": 138,
    "yesyesyesno": 138,
}


# ---------- 1. 主题化重构的等价性（机械化证明，不靠眼看） ----------


def test_tid_map_is_key_for_key_identical_after_theming() -> None:
    """快照逐键相等：分区分配零行为变化。"""
    from backend.pipeline.category import SUBREDDIT_TID_MAP

    assert len(FROZEN_SUBREDDIT_TID_MAP) == 85, "快照本身就错了"
    assert set(SUBREDDIT_TID_MAP) == set(FROZEN_SUBREDDIT_TID_MAP), (
        "键集合漂移：多出来的 = "
        f"{sorted(set(SUBREDDIT_TID_MAP) - set(FROZEN_SUBREDDIT_TID_MAP))}，"
        f"丢掉的 = {sorted(set(FROZEN_SUBREDDIT_TID_MAP) - set(SUBREDDIT_TID_MAP))}"
    )
    for subreddit, tid in FROZEN_SUBREDDIT_TID_MAP.items():
        assert SUBREDDIT_TID_MAP[subreddit] == tid, f"{subreddit} 分区被改了"


def test_sentiment_theme_membership() -> None:
    """`THEME_SUBREDDITS["sentiment"]` 就是「# 情感类」注释下那 17 条，不增不减。"""
    from backend.pipeline.category import THEME_SUBREDDITS

    members = THEME_SUBREDDITS["sentiment"]
    assert len(members) == 17, f"情感名单应恰好 17 条，实际 {len(members)}"
    assert set(members) == set(SENTIMENT_MEMBERS), (
        f"名单不符：多出 {sorted(set(members) - set(SENTIMENT_MEMBERS))}，"
        f"缺少 {sorted(set(SENTIMENT_MEMBERS) - set(members))}"
    )
    assert all(members), "名单里有空串"


def test_assign_bili_tid_unchanged_for_every_frozen_member() -> None:
    """端到端一步：自动分区函数对 85 个 subreddit 的返回值一个都没变。"""
    from backend.pipeline.category import assign_bili_tid

    for subreddit, tid in FROZEN_SUBREDDIT_TID_MAP.items():
        assert assign_bili_tid(subreddit) == tid, subreddit
    # 情感类落 21（生活日常）——B 站没有情感一级分区
    assert assign_bili_tid("MadeMeSmile") == 21
    # 兜底与默认分支没被主题化波及
    assert assign_bili_tid("unknownsub", "image_gallery") == 202
    assert assign_bili_tid("unknownsub", "video_raw") == 21


def test_sentiment_names_have_one_author_in_category_source() -> None:
    """每个情感名在 `category.py` 里只许出现一次（名单本身）。

    主题化的目的就是把「哪些算情感」收成单一作者；只要有任何一条名字又手写回
    映射表，这里就红——而不是留给人工 review 去数。
    """
    from pathlib import Path

    src = (Path(__file__).resolve().parents[1] / "backend/pipeline/category.py").read_text(
        encoding="utf-8"
    )
    repeated = [name for name in SENTIMENT_MEMBERS if src.count(f'"{name}"') != 1]
    assert not repeated, f"这些情感名在 category.py 里出现了第二遍：{repeated}"


# ---------- 2. 阈值与门槛的单一作者 ----------


def test_quality_tiers_match_agreed_thresholds() -> None:
    """三档阈值是**这一个** dict，别处不许再抄一遍。"""
    from backend.pipeline.quality import QUALITY_TIERS

    assert QUALITY_TIERS == {
        "loose": {"min_score": 100, "min_ratio": 0.80},
        "standard": {"min_score": 500, "min_ratio": 0.90},
        "strict": {"min_score": 1500, "min_ratio": 0.94},
    }


def test_unfilled_score_cohort_is_addressable() -> None:
    """「分数没采到」是一档，不是被三档静默排除的隐形池。

    实测未评分活口 2659 条里 **458 条（17.2%）`reddit_score == 0` 且
    `upvote_ratio == 0`**（两字段一起为 0 = 采集没拿到，不是真的没人点赞），
    情感 747 条里占 42 条。双门槛把它们挡在 loose/standard/strict 之外，
    于是「命中 252」读起来像「另外 495 条是低质量」——那是误导。
    所以这一档必须**能被单独筛出来**、能被数出来。
    """
    from backend.pipeline.quality import QUALITY_UNFILLED

    assert QUALITY_UNFILLED == "unfilled"
    # 0 是「没采到」的哨兵值，也只有一个作者（筛选条件里不许裸写第二个 0）
    from backend.pipeline.quality import MISSING_METRIC_VALUE

    assert MISSING_METRIC_VALUE == 0


def test_theme_merge_refuses_to_pick_by_dict_order() -> None:
    """主题表与基础表撞名时**必须报错**，不许后写的一方静默胜出。

    `{**base, **theme}` 看起来无害，但一旦有人把某个 subreddit 既写进基础表
    （tid A）又加进主题集（tid B），赢家由字典顺序决定——读代码的人看不出来。
    """
    from backend.pipeline.category import _merge_tid_map

    # 负样本：同名词两边 tid 不同 → 报错
    with pytest.raises(ValueError):
        _merge_tid_map({"pics": 21}, {"sentiment": frozenset({"pics"})}, {"sentiment": 138})
    # 正样本对照组：tid 相同则合并成功（否则上面的「报错」可以是任何原因造成的假绿）
    merged = _merge_tid_map(
        {"pics": 21}, {"sentiment": frozenset({"MadeMeSmile"})}, {"sentiment": 21}
    )
    assert merged == {"pics": 21, "MadeMeSmile": 21}
    # 两个主题之间撞名同样要报
    with pytest.raises(ValueError):
        _merge_tid_map({}, {"a": frozenset({"x"}), "b": frozenset({"x"})}, {"a": 21, "b": 138})


@pytest.mark.asyncio
async def test_quality_unfilled_selects_the_missing_cohort(seeded) -> None:
    from backend.pipeline.quality import QUALITY_UNFILLED

    ids = await _seed(
        [
            # 两字段都为 0 = 没采到（第 5 条同形，用于证明它数得出）
            {
                "source_id": "u-none",
                "subreddit": "MadeMeSmile",
                "reddit_score": 0,
                "upvote_ratio": 0.0,
            },
            {
                "source_id": "u-none2",
                "subreddit": "MadeMeSmile",
                "reddit_score": 0,
                "upvote_ratio": 0.0,
            },
            # 有 ratio 没 score：不算「没采到」（两字段缺一不算同一形状）
            {
                "source_id": "u-ratio",
                "subreddit": "MadeMeSmile",
                "reddit_score": 0,
                "upvote_ratio": 0.9,
            },
            # 有 score 没 ratio：也不算
            {
                "source_id": "u-score",
                "subreddit": "MadeMeSmile",
                "reddit_score": 800,
                "upvote_ratio": 0.0,
            },
            # 正常条目
            {
                "source_id": "u-ok",
                "subreddit": "MadeMeSmile",
                "reddit_score": 800,
                "upvote_ratio": 0.95,
            },
        ]
    )
    pipe = _pipe()
    rows = await pipe.list_items(
        status="discovered", source=SOURCE, quality=QUALITY_UNFILLED, limit=100
    )
    assert {r["id"] for r in rows} == {ids[0], ids[1]}, "「没采到分数」档命中集不对"

    # 三档都不许收这批缺值条目（缺值 ≠ 低质量，但也不等于进了档）
    for tier in ("loose", "standard", "strict"):
        got = {
            r["id"]
            for r in await pipe.list_items(
                status="discovered", source=SOURCE, quality=tier, limit=100
            )
        }
        assert not got & {ids[0], ids[1]}, f"{tier} 档收了缺值条目"

    # facets：unfilled 单独可数，且 = 总数 - 任一模糊口径（此处直接对数）
    facets = await pipe.items_facets(status="discovered", source=SOURCE)
    assert facets["unfilled"] == 2
    assert facets["total"] == 5
    # 「有正文」那一格仍然可数（0 也要显示出来，不许被筛掉）
    assert facets["with_text"] + facets["without_text"] == facets["total"]


@pytest.mark.asyncio
async def test_facets_unfilled_is_denominator_wide(seeded) -> None:
    """unfilled 跟着其余轴走：筛情感时它数的是情感里的缺值条数。"""
    from backend.pipeline.quality import QUALITY_UNFILLED

    await _seed(
        [
            {
                "source_id": "u-sent",
                "subreddit": "MadeMeSmile",
                "reddit_score": 0,
                "upvote_ratio": 0.0,
            },
            {"source_id": "u-plain", "subreddit": "aww", "reddit_score": 0, "upvote_ratio": 0.0},
            {
                "source_id": "u-ok",
                "subreddit": "MadeMeSmile",
                "reddit_score": 800,
                "upvote_ratio": 0.95,
            },
        ]
    )
    plain = await _pipe().items_facets(status="discovered", source=SOURCE)
    assert plain["unfilled"] == 2
    themed = await _pipe().items_facets(status="discovered", source=SOURCE, theme="sentiment")
    assert themed["unfilled"] == 1, "unfilled 没跟着主题轴走"
    assert themed["hit"] == 2

    both = await _pipe().items_facets(
        status="discovered", source=SOURCE, theme="sentiment", quality=QUALITY_UNFILLED
    )
    assert both["hit"] == 1 and both["unfilled"] == 1

    # 缺值档与阈值档不重叠（重叠就会让「命中 252」又把同一条数进缺值）
    tiers: set[str] = set()
    for tier in ("loose", "standard", "strict"):
        tiers |= {
            r["id"]
            for r in await _pipe().list_items(
                status="discovered", source=SOURCE, quality=tier, limit=100
            )
        }
    unfilled = {
        r["id"]
        for r in await _pipe().list_items(
            status="discovered", source=SOURCE, quality=QUALITY_UNFILLED, limit=100
        )
    }
    assert not (tiers & unfilled), "缺值档与阈值档重叠"


@pytest.mark.asyncio
async def test_neither_tier_nor_unfilled_cohort_exists(seeded) -> None:
    """有 ratio 没 score 的条目谁都不收——这是第三格，界面不许把它算进「低质量」。"""
    from backend.pipeline.quality import QUALITY_UNFILLED

    ids = await _seed(
        [
            {
                "source_id": "v-half",
                "subreddit": "MadeMeSmile",
                "reddit_score": 0,
                "upvote_ratio": 0.9,
            },
        ]
    )
    pipe = _pipe()
    for quality in ("loose", "standard", "strict", QUALITY_UNFILLED):
        got = {
            r["id"]
            for r in await pipe.list_items(
                status="discovered", source=SOURCE, quality=quality, limit=100
            )
        }
        assert ids[0] not in got, f"这条被 {quality} 收了"
    facets = await pipe.items_facets(status="discovered", source=SOURCE)
    assert facets["total"] == 1
    assert facets["hit"] == 1, "不传 quality 时不该被任何档排除"
    assert facets["unfilled"] == 0
    assert sum(facets["by_quality"].values()) == 0


def test_filter_builder_reuses_the_authors_not_new_numbers() -> None:
    """`service_queries` 里既不能自己写 50，也不能自己写三档阈值。"""
    from pathlib import Path

    src = (Path(__file__).resolve().parents[1] / "backend/pipeline/service_queries.py").read_text(
        encoding="utf-8"
    )
    assert "MIN_STORY_CHARS" in src, "正文门槛没复用 quality 的作者"
    assert "QUALITY_TIERS" in src, "质量阈值没复用 quality 的作者"
    assert "MISSING_METRIC_VALUE" in src, "缺值哨兵没复用 quality 的作者"
    for bare in ("min_score=500", ">= 500", ">= 1500", ">= 0.94", "min_score=100"):
        assert bare not in src, f"筛选里裸写了阈值数字：{bare}"


# ---------- 合成行 ----------


async def _seed(rows: list[dict]) -> list[str]:
    """插合成行（status=discovered、非归档、未隔离），返回 id 列表。"""
    ids: list[str] = []
    async with session_factory() as session:
        for row in rows:
            item = Item(
                source=SOURCE,
                source_id=row["source_id"],
                status="discovered",
                subreddit=row["subreddit"],
                title=row.get("title", row["source_id"]),
                item_type=row.get("item_type", "video_raw"),
                media_url=row.get("media_url", "https://v.redd.it/v034probe/DASHPlaylist.mpd"),
                reddit_score=row.get("reddit_score", 0),
                upvote_ratio=row.get("upvote_ratio", 1.0),
                selftext=row.get("selftext"),
            )
            session.add(item)
            await session.flush()
            ids.append(str(item.id))
        await session.commit()
    return ids


@pytest.fixture
async def seeded():
    """每用例独立的合成池，用完删干净（不给测试库留垃圾）。"""
    await _clean()
    yield
    await _clean()


async def _clean() -> None:
    async with session_factory() as session:
        await session.execute(delete(Item).where(Item.source == SOURCE))
        await session.commit()


def _pipe():
    from backend.factory.registry import ServiceRegistry

    return ServiceRegistry.get().pipeline


# ---------- 3. theme 轴 ----------


@pytest.mark.asyncio
async def test_theme_filter_keeps_only_sentiment_rows(seeded) -> None:
    """情感 subreddit 回数，非情感的（同 tid 的日常类 / 其他分区）不回。"""
    ids = await _seed(
        [
            {"source_id": "a-sent", "subreddit": "MadeMeSmile"},
            {"source_id": "a-sent2", "subreddit": "relationship_advice"},
            {"source_id": "a-plain", "subreddit": "oddlysatisfying"},  # 同 tid 21，但不是情感
            {"source_id": "a-other", "subreddit": "aww"},
        ]
    )
    rows = await _pipe().list_items(
        status="discovered", source=SOURCE, theme="sentiment", limit=100
    )
    got = {r["id"] for r in rows}
    assert {ids[0], ids[1]} <= got, "情感条目被筛掉了"
    assert ids[2] not in got and ids[3] not in got, "非情感条目漏进主题筛选"
    assert all(r["subreddit"] in SENTIMENT_MEMBERS for r in rows)


@pytest.mark.asyncio
async def test_theme_none_keeps_everything(seeded) -> None:
    """不传 theme = 不加条件（默认必须是「全部」，不能默认情感）。"""
    await _seed(
        [
            {"source_id": "b-sent", "subreddit": "MadeMeSmile"},
            {"source_id": "b-plain", "subreddit": "aww"},
        ]
    )
    rows = await _pipe().list_items(status="discovered", source=SOURCE, limit=100)
    assert len(rows) == 2


# ---------- 4. 未知 theme 必须报错，不许静默空集 ----------


@pytest.mark.asyncio
async def test_unknown_theme_raises_valueerror(seeded) -> None:
    """未知主题 → ValueError。

    静默返回空集会拿「名单没配」伪装成「今天没有情感内容」——本仓反复登记过的
    那种静默退化形状。
    """
    await _seed([{"source_id": "c-1", "subreddit": "MadeMeSmile"}])
    with pytest.raises(ValueError):
        await _pipe().list_items(status="discovered", source=SOURCE, theme="感情")
    with pytest.raises(ValueError):
        await _pipe().list_items(status="discovered", source=SOURCE, theme="made-me-smile")


@pytest.mark.asyncio
async def test_known_theme_does_not_raise(seeded) -> None:
    """负样本对照组：拼对的 key 必须走通（否则上面两条「报错」可以是假绿）。"""
    await _seed([{"source_id": "c-2", "subreddit": "MadeMeSmile"}])
    rows = await _pipe().list_items(status="discovered", source=SOURCE, theme="sentiment")
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_unknown_quality_raises_valueerror(seeded) -> None:
    await _seed(
        [
            {
                "source_id": "c-3",
                "subreddit": "MadeMeSmile",
                "reddit_score": 500,
                "upvote_ratio": 0.95,
            },
        ]
    )
    with pytest.raises(ValueError):
        await _pipe().list_items(status="discovered", source=SOURCE, quality="high")
    # 正样本对照：拼对的档位必须真的走得通（否则「报错」可以是任何原因造成的假绿）
    rows = await _pipe().list_items(status="discovered", source=SOURCE, quality="loose")
    assert len(rows) == 1


# ---------- 5. 质量轴 ----------


@pytest.mark.asyncio
async def test_quality_tier_gates(seeded) -> None:
    """各档命中形状（阈值见 `quality.QUALITY_TIERS`）。

    注：简报正文有一句「reddit_score=600, upvote_ratio=0.95 → 三档全命中」，与
    同简报的阈值表（strict 要求 ≥1500）自相矛盾。这里按**阈值表**断言：
    600/0.95 命中 loose + standard，不命中 strict；strict 用 1600/0.95 单独证明
    它可达（不是死档）。矛盾已写进 task 报告，不当没看见。
    """
    ids = await _seed(
        [
            {
                "source_id": "d-mid",
                "subreddit": "MadeMeSmile",
                "reddit_score": 600,
                "upvote_ratio": 0.95,
            },
            {
                "source_id": "d-strict",
                "subreddit": "MadeMeSmile",
                "reddit_score": 1600,
                "upvote_ratio": 0.95,
            },
            {
                "source_id": "d-low",
                "subreddit": "MadeMeSmile",
                "reddit_score": 50,
                "upvote_ratio": 0.5,
            },
            {
                "source_id": "d-ratio",
                "subreddit": "MadeMeSmile",
                "reddit_score": 900,
                "upvote_ratio": 0.85,
            },
        ]
    )
    pipe = _pipe()

    async def hit(quality: str) -> set[str]:
        rows = await pipe.list_items(status="discovered", source=SOURCE, quality=quality, limit=100)
        return {r["id"] for r in rows}

    assert await hit("loose") == {ids[0], ids[1], ids[3]}, "loose 档（≥100/≥0.80）命中集不对"
    assert await hit("standard") == {ids[0], ids[1]}, "standard 档（≥500/≥0.90）命中集不对"
    assert await hit("strict") == {ids[1]}, "strict 档（≥1500/≥0.94）命中集不对"
    # 50 分一条不命中（低质量档也进不来）
    for tier in ("loose", "standard", "strict"):
        assert ids[2] not in await hit(tier), f"50 分条目命中了 {tier}"
    # ratio 单独卡住：900 分但 ratio 0.85 → 只有 loose 收
    assert ids[3] not in await hit("standard")


# ---------- 6. 正文轴 ----------


@pytest.mark.asyncio
async def test_has_text_axis(seeded) -> None:
    """has_text 是真筛据：够长正文 / 空正文 / NULL 各归其位。"""
    from backend.pipeline.quality import MIN_STORY_CHARS

    ids = await _seed(
        [
            {"source_id": "e-empty", "subreddit": "MadeMeSmile", "selftext": ""},
            {"source_id": "e-null", "subreddit": "MadeMeSmile", "selftext": None},
            {
                "source_id": "e-long",
                "subreddit": "MadeMeSmile",
                "selftext": "故" * MIN_STORY_CHARS,
            },
            {
                "source_id": "e-short",
                "subreddit": "MadeMeSmile",
                "selftext": "故" * (MIN_STORY_CHARS - 1),
            },
        ]
    )
    pipe = _pipe()
    with_text = {
        r["id"]
        for r in await pipe.list_items(status="discovered", source=SOURCE, has_text=True, limit=100)
    }
    without_text = {
        r["id"]
        for r in await pipe.list_items(
            status="discovered", source=SOURCE, has_text=False, limit=100
        )
    }
    assert with_text == {ids[2]}, "has_text=True 命中集不对（门槛 = MIN_STORY_CHARS）"
    assert without_text == {ids[0], ids[1], ids[3]}, "has_text=False 漏了空/NULL/差一个字"
    # 两档互补、不重叠、并起来是全量
    assert not (with_text & without_text)
    total = await pipe.list_items(status="discovered", source=SOURCE, limit=100)
    assert len(with_text) + len(without_text) == len(total)


# ---------- 7. facets ----------


@pytest.mark.asyncio
async def test_facets_total_is_not_hit(seeded) -> None:
    """total 与 hit 是两个数：把筛后当全量是本仓被坑过的形状。"""
    from backend.pipeline.quality import MIN_STORY_CHARS

    await _seed(
        [
            {"source_id": "f-sent", "subreddit": "MadeMeSmile", "reddit_score": 600},
            {
                "source_id": "f-sent2",
                "subreddit": "TikTokCringe",
                "selftext": "故" * MIN_STORY_CHARS,
            },
            {"source_id": "f-plain", "subreddit": "aww"},
        ]
    )
    pipe = _pipe()

    plain = await pipe.items_facets(status="discovered", source=SOURCE)
    assert plain["total"] == 3
    assert plain["hit"] == 3
    assert plain["with_text"] + plain["without_text"] == plain["total"]

    themed = await pipe.items_facets(status="discovered", source=SOURCE, theme="sentiment")
    assert themed["total"] == 3, "total 应是不加轴的全量分母"
    assert themed["hit"] == 2, "hit 应是加了主题轴之后的数"
    assert themed["total"] != themed["hit"]
    assert themed["with_text"] + themed["without_text"] == themed["hit"]
    assert themed["with_text"] == 1 and themed["without_text"] == 1
    assert themed["by_quality"] == {"loose": 1, "standard": 1, "strict": 0}


@pytest.mark.asyncio
async def test_facets_shares_the_lists_where(seeded) -> None:
    """facets.hit 与 list_items 条数在同样参数下必须一模一样（同一个条件构造）。"""
    await _seed(
        [
            {
                "source_id": "g-1",
                "subreddit": "MadeMeSmile",
                "reddit_score": 1600,
                "upvote_ratio": 0.95,
            },
            {
                "source_id": "g-2",
                "subreddit": "MadeMeSmile",
                "reddit_score": 60,
                "upvote_ratio": 0.5,
            },
            {"source_id": "g-3", "subreddit": "aww", "reddit_score": 2000, "upvote_ratio": 0.99},
        ]
    )
    pipe = _pipe()
    for kwargs in (
        {},
        {"theme": "sentiment"},
        {"theme": "sentiment", "quality": "standard"},
        {"theme": "sentiment", "quality": "strict", "has_text": False},
    ):
        listed = await pipe.list_items(status="discovered", source=SOURCE, limit=100, **kwargs)
        facets = await pipe.items_facets(status="discovered", source=SOURCE, **kwargs)
        assert facets["hit"] == len(listed), kwargs


@pytest.mark.asyncio
async def test_facets_unknown_theme_raises(seeded) -> None:
    with pytest.raises(ValueError):
        await _pipe().items_facets(status="discovered", source=SOURCE, theme="nope")


# ---------- 8. HTTP 层：参数透传 + 非法值 422 ----------


@pytest.mark.asyncio
async def test_items_endpoint_passes_filters(client, seeded) -> None:
    await _seed(
        [
            {"source_id": "h-1", "subreddit": "MadeMeSmile", "reddit_score": 600},
            {"source_id": "h-2", "subreddit": "aww", "reddit_score": 600},
        ]
    )
    resp = await client.get(
        "/api/pipeline/items",
        params={"status": "discovered", "source": SOURCE, "theme": "sentiment"},
    )
    assert resp.status_code == 200
    ids = {i["id"] for i in resp.json()}
    assert len(ids) == 1
    assert resp.json()[0]["subreddit"] == "MadeMeSmile"


@pytest.mark.asyncio
async def test_items_endpoint_rejects_bad_theme_with_422(client, seeded) -> None:
    """非法 theme → 422（不吞成 200 空列表，也不落 500）。"""
    resp = await client.get("/api/pipeline/items", params={"status": "discovered", "theme": "情感"})
    assert resp.status_code == 422, resp.status_code


@pytest.mark.asyncio
async def test_items_endpoint_rejects_bad_quality_with_422(client, seeded) -> None:
    resp = await client.get(
        "/api/pipeline/items", params={"status": "discovered", "quality": "premium"}
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_facets_endpoint(client, seeded) -> None:
    await _seed(
        [
            {"source_id": "j-1", "subreddit": "MadeMeSmile", "reddit_score": 600},
            {"source_id": "j-2", "subreddit": "aww"},
        ]
    )
    resp = await client.get(
        "/api/pipeline/items/facets", params={"status": "discovered", "source": SOURCE}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"total", "hit", "by_quality", "with_text", "without_text", "unfilled"}
    assert body["total"] == 2
    bad = await client.get(
        "/api/pipeline/items/facets", params={"status": "discovered", "theme": "???"}
    )
    assert bad.status_code == 422
