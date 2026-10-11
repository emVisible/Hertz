"""条目质量判据（v0.33 单一作者）——「这条到底有没有可产出的东西」。

存在理由：判据此前散在两个地方各写一半（`classify_media` 的兜底猜视频 +
采集器里裸写的 `len(selftext) < 50`），结果是 2011 条既无媒体又无正文的条目被
标成 `video_raw` 放进了可操作队列。这里只放**判据**，不打标、不写库——写库由
`steps/collect.py` 负责，回填由脚本负责，巡检由 `integrity.py` 负责，三者共用
本模块，不许各自再写一份。

判据刻意不认「media_url == source_url」这种形式线索：YouTube/Bilibili 等源的
`media_url` 本来就可以是播放页（交给 yt-dlp 解析），按 URL 相等去判会把它们
误隔离成空壳。真正的判据只有一条：**媒体直链落到了 Reddit 的页面域上**
（那里是 HTML + 机器人拦截，不是可下载文件；实测同机 v.redd.it 直链 200、
www.reddit.com 页面 403）。
"""

from __future__ import annotations

from urllib.parse import urlparse

from backend.models.item import ItemType

#: Reddit 的页面域：返回 HTML/JSON，不含可下载媒体。媒体域是 v./i./preview./shreddit.*redd.it。
REDDIT_PAGE_HOSTS = frozenset({
    "reddit.com",
    "www.reddit.com",
    "old.reddit.com",
    "new.reddit.com",
    "np.reddit.com",
    "oauth.reddit.com",
})

#: 文字产线的最低正文长度（此前在 collectors/reddit.py 里裸写 50，挪到此处成唯一作者）
MIN_STORY_CHARS = 50

#: 质量档阈值（v0.34 A 未评分区筛选）：reddit_score 与 upvote_ratio 双门槛同时满足。
#: 阈值**只**写在这一份 dict 里——SQL 条件由 `service_queries.axis_filters()` 读它
#: 构造，前端展示档位名即可。别处再抄一遍数字，就会出现「改了筛选没改判据」。
#: standard 档与存量口径一致（实测「高质量档 reddit_score≥500 且 upvote_ratio≥0.90」
#: 在 747 条情感活口里命中 252 条），loose/strict 是它的两侧延伸。
QUALITY_TIERS: dict[str, dict[str, float]] = {
    "loose": {"min_score": 100, "min_ratio": 0.80},
    "standard": {"min_score": 500, "min_ratio": 0.90},
    "strict": {"min_score": 1500, "min_ratio": 0.94},
}

#: 「分数没采到」哨兵值：Reddit 采集没返回 score/ratio 时，两个字段都落 0
#: （`RawPost` 的默认值就是 0，不是「1 分都没有」）。缺值 ≠ 低质量。
MISSING_METRIC_VALUE = 0

#: 第四档档名（v0.34 A）：两字段同时为 `MISSING_METRIC_VALUE` 的条目走这一档。
#:
#: 为什么必须有这一档（实测 2026-09-28 dev 库，未评分活口 2659 条）：其中
#: **458 条（17.2%）`reddit_score` 与 `upvote_ratio` 一起为 0**，情感 747 条里占 42 条。
#: 双门槛把它们挡在 loose/standard/strict 之外，于是界面报「情感 747 里标准档 252」
#: 会被读成「另外 495 条是低质量」——那是误导：那 42 条**无从判断**。
#: 所以缺值必须能单独筛、能单独数（`items_facets` 的 `unfilled`），而不是静默消失。
#:
#: 已知的第三格（诚实起见此条不许被省略）：`reddit_score=0` 但 `upvote_ratio>0`
#: 的条目（活口里另有 312 条，情感里 71 条）**既不进任何阈值档、也不算缺值档**——
#: 它有 ratio 没分数，分不清「真 0 分」和「只缺一个字段」。所以
#: 「三档 + 缺值档 = 全量」今天**不成立**（实测 loose 1255 + 缺值 458 = 1713，
#: 距 2659 还差 946 条），界面不许那样宣称；补齐要靠采集侧把两个字段一起写全
#: （不在本片范围）。
QUALITY_UNFILLED = "unfilled"


#: 素材类型档（筛选轴）：图文 / 视频 / 文字帖。
#:
#: 档名到 `items.item_type` 的映射**只**写在这一份 dict 里——SQL 条件由
#: `service_queries.axis_filters()` 读它构造。别处再抄一遍字符串，就会出现
#: 「改了筛选没改判据」。
#:
#: 为什么三档互斥且覆盖全部：`item_type` 本身就是这三值（见 `models/item.ItemType`），
#: 没有第四种素材形态——所以这一轴是**划分**而非**分级**，「图文 / 视频 / 文字帖」
#: 三档并起来恒等于分母（与 `quality` 那种「三档 + 缺值档 ≠ 全量」的
#: `QUALITY_UNFILLED` 情形不同，此轴不存在第四格）。
#:
#: 档名说明：`image` 档在界面上叫「图文」——Reddit 图帖（image_gallery）本身
#: 就是「文字 + 图」的图文形态，单独叫「图片」反而不准。
MATERIAL_TIERS: dict[str, str] = {
    "image": ItemType.IMAGE_GALLERY,   # 图文（图片帖）
    "video": ItemType.VIDEO_RAW,       # 视频
    "text": ItemType.TEXT_ONLY,        # 文字帖（无媒体，走文字产线）
}

#: 隔离原因码（进 items.error_class；人可读解释进 items.error）
INVALID_REASON = "invalid_media"


def is_reddit_page_url(url: str | None) -> bool:
    """URL 指向 Reddit 帖子页/列表页（HTML）而不是媒体直链。"""
    raw = (url or "").strip()
    if not raw:
        return False
    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower()
    if host not in REDDIT_PAGE_HOSTS:
        return False
    path = parsed.path or ""
    # /comments/<id>/ 详情页、/r/<sub> 列表页、以及只有域名的残缺值
    return "/comments" in path or path.rstrip("/") in ("", "/") or path.startswith("/r/")


def has_downloadable_media(media_url: str | None) -> bool:
    """有非空的、且不落在 Reddit 页面域上的媒体链接。"""
    raw = (media_url or "").strip()
    return bool(raw) and not is_reddit_page_url(raw)


def shell_reason(*, media_url: str | None, selftext: str | None) -> str | None:
    """可产出性判定：返回 None 表示「有活可干」，否则给出隔离原因。

    两条出路任一成立就不隔离：①有媒体直链（视频/图集产线）；②正文够长（文字产线）。
    """
    if has_downloadable_media(media_url):
        return None
    if len((selftext or "").strip()) >= MIN_STORY_CHARS:
        return None
    if not (media_url or "").strip():
        return "无媒体直链，正文也不足文字产线门槛"
    return "media_url 落在 Reddit 页面域（HTML 且被反爬拦截），无可用媒体直链，正文也不足门槛"


#: 可隔离的状态：**只有还会被产线取走的条目**才值得打隔离标。
#: published / rejected 是终态，数字要进看板、审核统计与内容日历——拿这条判据扫
#: 开发库时它会连带命中 5 条已发布 + 284 条已拒绝，标掉等于让历史数据凭空蒸发。
QUARANTINABLE_STATUSES = frozenset({
    "discovered", "scored", "downloaded", "queued", "approved", "failed",
})


def quarantine_reason(item) -> str | None:
    """该条目是否处在「可被隔离」的状态且形状为空壳，返回原因（None = 不该动它）。"""
    if not is_quarantinable(item):
        return None
    return shell_reason(media_url=item.media_url, selftext=item.selftext)


def is_quarantinable(item) -> bool:
    return str(getattr(item, "status", "") or "") in QUARANTINABLE_STATUSES


def stamp(item) -> None:
    """给一个待入库/待回填的条目就地打质量标（**唯一**的打标动作）。

    为什么必须有这一个函数而不是让各写入口自己判：实测有两条路径在写
    `status=discovered`（采集步骤与工坊草稿建条目）。闸只装在一条上，另一条
    照样灌空壳——`tests/test_shell_items.py` 的守卫要求「凡建 discovered 条目处
    必须表过态」。回填脚本与数据体检共用本函数，三处判得一模一样。

    做两件事（终态条目一律不动，见 QUARANTINABLE_STATUSES）：
    ①内容类型不许冒充：无媒体直链时，够长正文 → text_only，否则「未判定」空串。
      这一步**不能**等隔离判据成立才做——有长正文的空壳不会被隔离，但它那条
      `media_url=帖子页` 仍然会把下游产线骗成视频（实测 2011 条的形状）。
    ②真空壳打 `is_invalid` + 原因；已有失败记录的条目**不覆盖** error_class/error
      —— 失败历史比隔离原因更有诊断价值。
    """
    if not is_quarantinable(item):
        return
    if not has_downloadable_media(item.media_url):
        story_like = len((item.selftext or "").strip()) >= MIN_STORY_CHARS
        item.item_type = "text_only" if story_like else ""
    reason = shell_reason(media_url=item.media_url, selftext=item.selftext)
    if not reason:
        return
    item.is_invalid = True
    if not (item.error_class or "").strip():
        item.error_class = INVALID_REASON
        item.error = reason


def reassess(item) -> bool:
    """重新评估隔离标：**理由不再成立就把标摘掉**，返回是否改了。

    为什么 `stamp` 之外还需要这一个：`stamp` 的语义是「只加标、不清标」（它要在
    每个写入口安全地被调用一次，清标动作放进它会让人工标记被机器抹掉）。但正文
    回填之后必须有人把 `is_invalid` 摘掉，否则 1982 条文字帖永远躺在异常区。
    由本模块提供这个出口，回填脚本就不必自己写 `item.is_invalid = False`——
    自己写就是第二个作者，会被 v0.33 那条「隔离标记只由 quality 写」的纪律按住。

    三条保守规则：
    ①终态一律不动（复用 `is_quarantinable`，不另列一份状态白名单）；
    ②`shell_reason` 仍然成立 → 原样返回 False，连文案都不改；
    ③`error_class` 不是本模块写的那个原因码时**不清标**——隔离位上挂着别人的
      失败记录（例如 `download_failed`）说明还有别的理由让它待在异常区，
      这里静默摘标等于替别人宣布「问题解决了」。
    """
    if not is_quarantinable(item):
        return False
    if shell_reason(media_url=item.media_url, selftext=item.selftext):
        return False
    if not item.is_invalid:
        return False
    if (item.error_class or "").strip() not in ("", INVALID_REASON):
        return False
    item.is_invalid = False
    if (item.error_class or "") == INVALID_REASON:
        item.error_class = ""
        item.error = None
    if not has_downloadable_media(item.media_url):
        story_like = len((item.selftext or "").strip()) >= MIN_STORY_CHARS
        item.item_type = "text_only" if story_like else ""
    return True
