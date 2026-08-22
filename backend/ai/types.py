"""Provider protocols — business logic depends only on these shapes.

AXIOM §2.2: swapping DeepSeek for a local model must touch one file.
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


@dataclass
class ChatMessage:
    role: str  # system | user | assistant
    content: str


@dataclass
class ImageResult:
    path: Path
    width: int = 0
    height: int = 0
    seed: int | None = None


@dataclass
class ScoreResult:
    total: float
    dimensions: dict[str, float] = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)
    fallback: bool = False


@dataclass
class TitleResult:
    title: str
    tags: list[str] = field(default_factory=list)
    description: str = ""
    # v0.15 标题 N 选 1：备选候选（≤3），审核/发布卡可切换选用
    alternatives: list[str] = field(default_factory=list)


class LLMProvider(Protocol):
    """Streaming chat completion."""

    async def chat_stream(
        self,
        messages: list[ChatMessage],
        *,
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> AsyncIterator[str]: ...

    async def aclose(self) -> None: ...


class ImageProvider(Protocol):
    """Text-to-image generation."""

    async def generate(
        self,
        prompt: str,
        negative_prompt: str = "",
        *,
        width: int = 1024,
        height: int = 1024,
        steps: int = 20,
        seed: int | None = None,
    ) -> ImageResult: ...

    async def aclose(self) -> None: ...


class TTSProvider(Protocol):
    """Text-to-speech synthesis."""

    async def synthesize(self, text: str, voice: str) -> bytes: ...

    async def aclose(self) -> None: ...
