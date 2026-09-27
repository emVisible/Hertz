"""AIRouter task tests with a fake streaming LLM provider."""

import pytest

from backend.ai.router import AIRouter
from backend.ai.types import ChatMessage, ImageResult, ScoreResult


class FakeLLM:
    def __init__(self, responses: list[str]) -> None:
        self.responses = list(responses)
        self.calls: list[list[ChatMessage]] = []

    async def chat_stream(self, messages, *, temperature=0.7, max_tokens=4096):
        self.calls.append(messages)
        for ch in self.responses.pop(0):
            yield ch

    async def aclose(self) -> None:
        pass


class FakeImage:
    async def generate(self, prompt, negative_prompt="", **kw) -> ImageResult:
        return ImageResult(path="out.png", width=1024, height=1024)

    async def aclose(self) -> None:
        pass


@pytest.mark.asyncio
async def test_score_parses_json() -> None:
    llm = FakeLLM(
        ['{"dimensions": {"entertainment": 8}, "total": 7.5, "reasons": ["有趣"]}']
    )
    router = AIRouter(llm=llm, image=None, tts=None)
    result = await router.score(title="T", content="C", source="reddit")
    assert isinstance(result, ScoreResult)
    assert result.total == 7.5
    assert result.reasons == ["有趣"]
    assert not result.fallback


@pytest.mark.asyncio
async def test_score_falls_back_on_bad_json() -> None:
    llm = FakeLLM(["not json at all"])
    router = AIRouter(llm=llm, image=None, tts=None)
    result = await router.score(title="一个很长的标题用来撑分数", content="内容" * 50)
    assert result.fallback is True
    assert 0 <= result.total <= 10


@pytest.mark.asyncio
async def test_score_without_llm_raises() -> None:
    """v2.0 契约：无 fake LLM 且注册表为空时快速失败（AXIOM §4.2）。"""
    from backend.ai.registry import ProviderRegistry

    class _EmptyRegistry(ProviderRegistry):
        async def resolve_role(self, role: str) -> dict | None:
            return None

        async def list_providers(self, include_secrets: bool = False) -> list[dict]:
            return []

    router = AIRouter(registry=_EmptyRegistry(), llm=None, image=None, tts=None)
    with pytest.raises(RuntimeError):
        await router.score(title="T", content="C")


@pytest.mark.asyncio
async def test_image_route_delegates() -> None:
    router = AIRouter(llm=None, image=FakeImage(), tts=None)
    result = await router.generate_image("a cat")
    assert result.path == "out.png"


@pytest.mark.asyncio
async def test_title_tidies_edge_punctuation() -> None:
    """Phase 4.2：AI 标题/描述过 display_text.tidy（首尾冗余标点清理，句中保留）。"""
    llm = FakeLLM(
        ['{"title": "震惊！三句话讲透AI。。。", "tags": ["a"],'
         ' "description": "句中，保留。尾巴。。。",'
         ' "alternatives": ["备选。。。", "震惊！三句话讲透AI。。。"]}']
    )
    router = AIRouter(llm=llm, image=None, tts=None)
    result = await router.title_and_tags(script="正文", content="c")
    assert result.title == "震惊！三句话讲透AI"
    assert result.description == "句中，保留。尾巴"
    # 去重用 tidy 后标题比较：与主标题相同的备选被剔除
    assert result.alternatives == ["备选"]
