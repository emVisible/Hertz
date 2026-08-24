"""多源采集路由（v0.22 非破坏性扩展）。

通道命名：`<source_type>/<inner>`——`reddit/sub`、`ai-story/情感夜话`、`rss/tech`。
裸通道名（无斜杠）= Reddit 兼容路径：存量 pipeline_sources（纯 subreddit 名）
零改动继续工作；显式 `reddit/sub` 前缀同样接受。

设计约束（D-186 非破坏性三律）：Reddit 仍是默认 collector，路由只做「加法」——
未注册的前缀抛错并走既有失败分类/冷却记账，不影响其他源。
"""

from backend.pipeline.collectors.base import SourceCollector

DEFAULT_SOURCE_TYPE = "reddit"


def split_channel(raw: str) -> tuple[str, str]:
    """通道串 → (source_type, inner)。裸名返回 ("reddit", 原名)。"""
    text = (raw or "").strip()
    if "/" in text:
        prefix, inner = text.split("/", 1)
        return prefix.strip(), inner.strip()
    return DEFAULT_SOURCE_TYPE, text


def resolve_collector(
    raw: str,
    default: SourceCollector,
    extra: dict[str, SourceCollector],
) -> SourceCollector:
    """按通道前缀解析 collector。

    - 裸名 / reddit/* → default（Reddit 实例）
    - 其他前缀查 extra 注册表；未知前缀 RuntimeError（调用方记失败+冷却）
    """
    source_type, _inner = split_channel(raw)
    if source_type == DEFAULT_SOURCE_TYPE:
        return default
    collector = extra.get(source_type)
    if collector is None:
        available = ", ".join(sorted(extra)) or "无"
        raise RuntimeError(
            f"未知采集源类型 '{source_type}/'（可用: {available}；"
            f"通道格式为 '<类型>/<名称>' 或裸 subreddit 名）"
        )
    return collector
