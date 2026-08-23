"""热点监控通道（v0.16）：TrendRadar 词法精华借鉴。

采集源的第二种形态——「主动雷达」：对指定 subreddit 以 rising 等排序高频
拉取，并用三段词法预筛（普通词任一命中 / +必须词全部满足 / !排除词一票否决）。
命中的条目走正常评分流水线（不绕过审核闸门）；词法只是把评分额度花在
源头更可能爆的内容上。

纯函数模块：解析、匹配、通道构造；DB 写入仍归 steps/collect.py。
"""

from backend.config import Settings


def parse_keywords(raw: str | None) -> list[str]:
    """空格或逗号分隔 → 去重保序的小写词表。"""
    seen: list[str] = []
    for part in (raw or "").replace(",", " ").split():
        w = part.strip().lower()
        if w and w not in seen:
            seen.append(w)
    return seen


def matches(
    title: str,
    *,
    any_kw: list[str],
    all_kw: list[str],
    exclude_kw: list[str],
    extra_text: str = "",
) -> bool:
    """三段词法判定（大小写不敏感；extra_text = selftext 等附加匹配面）。

    - any_kw 空 = 不限关键词
    - all_kw 必须全部命中
    - exclude_kw 任一命中即否决
    """
    hay = f"{title}\n{extra_text}".lower()
    if any(kw in hay for kw in exclude_kw):
        return False
    if all_kw and not all(kw in hay for kw in all_kw):
        return False
    if any_kw and not any(kw in hay for kw in any_kw):
        return False
    return True


def watch_channels(settings: Settings) -> list[str]:
    """watch 通道列表：`sub:{sort}`；开关关闭/无订阅返回空。"""
    if not bool(getattr(settings, "pipeline_watch_enabled", False)):
        return []
    subs = [
        s.strip()
        for s in str(getattr(settings, "pipeline_watch_subreddits", "") or "").split(",")
        if s.strip()
    ]
    sort = str(getattr(settings, "pipeline_watch_sort", "rising") or "rising")
    return [f"{sub}:{sort}" for sub in subs]


def predicate(settings: Settings):
    """由配置构造词法谓词（RawPost → bool）；供 run_collect(filter_fn=) 使用。"""
    any_kw = parse_keywords(str(getattr(settings, "pipeline_watch_keywords_any", "") or ""))
    all_kw = parse_keywords(str(getattr(settings, "pipeline_watch_keywords_all", "") or ""))
    exclude_kw = parse_keywords(str(getattr(settings, "pipeline_watch_exclude", "") or ""))
    min_score = int(getattr(settings, "pipeline_watch_min_score", 0) or 0)

    def _pred(post) -> bool:
        if min_score > 0 and int(post.score or 0) < min_score:
            return False
        # 标题 + selftext 一并纳入匹配面（大小写不敏感，matches 内部 lower）
        text = " ".join(
            (str(part) or "").split()
            for part in (post.title, getattr(post, "selftext", "") or "")
            if part
        )
        return matches(
            text,
            any_kw=any_kw, all_kw=all_kw, exclude_kw=exclude_kw,
        )

    return _pred


__all__ = ["matches", "parse_keywords", "predicate", "watch_channels"]
