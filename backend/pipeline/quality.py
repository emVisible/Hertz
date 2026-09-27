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
