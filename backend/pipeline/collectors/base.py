"""Source collectors — adapters that turn external feeds into RawPost items."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from backend.pipeline.base import StepContext


@dataclass
class RawPost:
    """Normalized post shape produced by every collector."""

    source_id: str
    title: str
    source_url: str
    media_url: str = ""
    author: str = ""
    score: int = 0
    upvote_ratio: float = 0.0
    num_comments: int = 0
    created_utc: float = 0.0
    is_video: bool = False
    item_type: str = "video_raw"
    # 文字帖正文（v0.11.7）：text_only 帖的 selftext，非文字帖为空
    selftext: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


class SourceCollector(ABC):
    """One content source (reddit, …). Fetches posts, dedupes, persists."""

    name: str = ""

    @abstractmethod
    async def collect(self, ctx: StepContext, channel: str, limit: int) -> list[RawPost]:
        """Return posts for one channel, newest first. Raise CollectorError on failure."""
        ...
