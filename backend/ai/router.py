"""TaskRouter — AI 底座任务路由（v2.0 重构）。

职责（对齐 Cherry Studio 的"任务按角色分工"）：
- 应用层调用方（engine/流水线/路由）从不直接碰 Provider——
  只问 TaskRouter 要任务（chat/score/script/title/image/tts）
- 每个任务按「角色」解析模型：创作→main（强）、评分/标题→fast（便宜快）
- 调用链记录（ai_calls）默认开启，供 v2.3 追踪与用量统计

v2.0 兼容性保证：`chat_messages/stream_chat/chat/score/script/title_and_tags/
generate_image/image_reachable/synthesize/aclose/status/llm_available/
image_available/tts_available` 全部保持原有签名——应用层零改动。
"""

import json
import logging
import re
import time
from dataclasses import dataclass

from backend.ai.prompts import score as score_prompts
from backend.ai.prompts import script as script_prompts
from backend.ai.prompts import title as title_prompts
from backend.ai.registry import ProviderRegistry
from backend.ai.types import (
    ChatMessage,
    ImageResult,
    LLMProvider,
    ScoreResult,
    TitleResult,
)

logger = logging.getLogger(__name__)

_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


@dataclass
class _ResolvedModel:
    """一次解析结果：provider + 模型 + 角色信息。"""

    provider_key: str
    model_key: str
    base_url: str
    api_keys: list[str]
    role: str
    operation: str
    caller: str


class TaskRouter:
    def __init__(
        self,
        registry: ProviderRegistry | None = None,
        image=None,  # 兼容旧测试注入（v3.0 起图像走注册表，此参数仅测试兜底）
        tts=None,  # 同上
        llm: LLMProvider | None = None,  # 测试注入的 fake LLM（注册表模式外的兼容入口）
    ) -> None:
        self._registry = registry or ProviderRegistry()
        self._image = image  # 测试兜底；正式路径走注册表
        self._tts = tts
        self._llm_provider: LLMProvider | None = llm  # 测试注入 fake 时使用

    # ----- capability introspection（兼容旧 API） -----

    @property
    def llm_available(self) -> bool:
        return True  # 注册表模式下始终可用（配置与否由 resolve 决定）

    async def _image_resolved(self) -> dict | None:
        """从注册表解析图像角色（comfyui provider + image 模型）。"""
        if self._image is not None:
            return None  # 测试兜底路径
        return await self._registry.resolve_role("image")

    async def _tts_resolved(self) -> dict | None:
        """从注册表解析 TTS 角色（edge_tts provider + tts 模型=音色）。"""
        if self._tts is not None:
            return None  # 测试兜底路径
        return await self._registry.resolve_role("tts")

    @property
    def image_available(self) -> bool:
        return self._image is not None or True  # 注册表模式：配置与否由 resolve 决定

    @property
    def tts_available(self) -> bool:
        return self._tts is not None or True  # 同上

    def status(self) -> dict:
        return {
            "llm": True,
            "image": True,
            "tts": True,
        }

    # ----- 内部：模型解析与调用 -----

    async def _resolve(self, role: str, model_key: str | None) -> _ResolvedModel | None:
        """按 role 解析模型；model_key 提供时优先精确匹配。

        model_key 支持两种格式：裸模型 id（全局首个匹配）或 provider:model。
        """
        if model_key:
            wanted_provider, sep, wanted_model = model_key.partition(":")
            for provider in await self._registry.list_providers():
                if sep and provider["key"] != wanted_provider:
                    continue
                for m in await self._registry.list_models(_uuid(provider["id"])):
                    if m["key"] != (wanted_model if sep else model_key):
                        continue
                    if not m["enabled"]:
                        continue
                    return _ResolvedModel(
                        provider_key=provider["key"],
                        model_key=m["key"],
                        base_url=provider["base_url"],
                        api_keys=provider.get("decrypted_keys", []),
                        role=role,
                        operation="",
                        caller="",
                    )
            return None
        try:
            resolved = await self._registry.resolve_role(role)
        except Exception as exc:  # noqa: BLE001 — 注册表不可用（无 DB/未初始化）
            raise RuntimeError("LLM provider not configured") from exc
        if resolved is None:
            return None
        return _ResolvedModel(
            provider_key=resolved["provider_key"],
            model_key=resolved["model_key"],
            base_url=resolved["base_url"],
            api_keys=resolved["api_keys"],
            role=role,
            operation="",
            caller="",
        )

    async def _collect(
        self,
        messages: list[ChatMessage],
        *,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        role: str = "main",
        operation: str = "chat",
        caller: str = "ai",
        response_format: dict | None = None,
        task_id: str | None = None,
        model_key: str | None = None,  # 显式指定模型（工序/团队配置），优先于角色
    ) -> str:
        # 测试注入 fake LLM 时直连（不查注册表）
        if self._llm_provider is not None:
            chunks: list[str] = []
            async for token in self._llm_provider.chat_stream(
                messages, temperature=temperature, max_tokens=max_tokens
            ):
                chunks.append(token)
            return "".join(chunks)
        resolved = await self._resolve(role, model_key)
        if resolved is None:
            raise RuntimeError("LLM provider not configured — no chat model in registry")
        from backend.ai.providers.openai_compat import OpenAICompatProvider

        # 多 Key 轮询（v2.2）：key 逐个尝试，坏 key 剔除继续，全失败才抛错。
        # 轮询顺序打乱避免固定 key 永远是热点（AXIOM §4.3 重试纪律）。
        keys = resolved.api_keys or ["not-needed"]
        last_error: Exception | None = None
        for key in keys:
            client = OpenAICompatProvider(
                api_key=key,
                base_url=resolved.base_url,
                model=resolved.model_key,
            )
            start = time.perf_counter()
            try:
                chunks: list[str] = []
                # 硅基流动的推理模型（DeepSeek-V3.2 等）默认思考链 40s+ 才出正文，
                # 创作任务关掉思考（实测 46s → 2.5s 短请求）；其他 provider 不传该参数
                # （OpenAI 官方 API 不识别 enable_thinking，传了会 400）。
                thinking = resolved.provider_key == "siliconflow"
                async for token in client.chat_stream(
                    messages, temperature=temperature, max_tokens=max_tokens,
                    response_format=response_format,
                    enable_thinking=False if thinking else None,
                ):
                    chunks.append(token)
                text = "".join(chunks)
                await self._record(
                    task_id=task_id, caller=caller, resolved=resolved,
                    operation=operation, status="ok", started_at=start,
                    # v0.5 E 成本估算：usage 探测（无 usage 的 provider 记 None）
                    prompt_tokens=(
                        client.last_usage.get("prompt_tokens")
                        if client.last_usage else None
                    ),
                    completion_tokens=(
                        client.last_usage.get("completion_tokens")
                        if client.last_usage else None
                    ),
                )
                return text
            except Exception as exc:  # noqa: BLE001 — 记录后尝试下一个 key
                last_error = exc
                logger.debug("provider key attempt failed: %s", exc)
            finally:
                await client.aclose()
        await self._record(
            task_id=task_id, caller=caller, resolved=resolved,
            operation=operation, status="error", started_at=start,
            error=str(last_error)[:500] if last_error else "all keys failed",
        )
        raise last_error or RuntimeError(f"all API keys failed for {resolved.provider_key}")

    async def _record(self, *, task_id, caller, resolved, operation, status,
                      started_at, error=None,
                      prompt_tokens: int | None = None,
                      completion_tokens: int | None = None) -> None:
        """写入 ai_calls（v2.3 追踪）。失败不阻塞调用（尽力而为）。"""
        try:
            from backend.ai.tracing import record_call

            await record_call(
                task_id=task_id,
                caller=caller,
                provider_key=resolved.provider_key,
                model_key=resolved.model_key,
                role=resolved.role or "",
                operation=operation,
                duration_ms=int((time.perf_counter() - started_at) * 1000),
                status=status,
                error=error,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
            )
        except Exception:  # noqa: BLE001
            logger.debug("ai call record failed (non-fatal)")

    # ----- 兼容旧 API 的任务方法 -----

    async def chat(
        self, message: str, system: str | None = None, *, task_id: str | None = None
    ) -> str:
        messages = []
        if system:
            messages.append(ChatMessage(role="system", content=system))
        messages.append(ChatMessage(role="user", content=message))
        return await self._collect(messages, role="main", operation="chat", task_id=task_id)

    async def chat_messages(
        self,
        messages: list[ChatMessage],
        *,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        role: str = "main",
        operation: str = "chat",
        task_id: str | None = None,
        model_key: str | None = None,  # v2.4：工序/团队显式指定模型
        caller: str = "ai",  # v0.14：环节归因（pipeline/orchestrator…）——成本页按此分组
    ) -> str:
        """Chat over pre-built message lists (used by the phase engine)."""
        return await self._collect(
            messages, temperature=temperature, max_tokens=max_tokens,
            role=role, operation=operation, task_id=task_id, model_key=model_key,
            caller=caller,
        )

    async def stream_chat(
        self,
        messages: list[ChatMessage],
        *,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        task_id: str | None = None,
    ):
        """Streamed chat: yields text tokens as they arrive (SSE dialogue)."""
        if self._llm_provider is not None:
            async for token in self._llm_provider.chat_stream(
                messages, temperature=temperature, max_tokens=max_tokens
            ):
                yield token
            return
        resolved = await self._resolve("main", None)
        if resolved is None:
            raise RuntimeError("LLM provider not configured")
        from backend.ai.providers.openai_compat import OpenAICompatProvider

        client = OpenAICompatProvider(
            api_key=resolved.api_keys[0] if resolved.api_keys else "not-needed",
            base_url=resolved.base_url,
            model=resolved.model_key,
        )
        started = time.perf_counter()
        try:
            thinking = resolved.provider_key == "siliconflow"
            async for token in client.chat_stream(
                messages, temperature=temperature, max_tokens=max_tokens,
                enable_thinking=False if thinking else None,
            ):
                yield token
        except Exception as exc:  # noqa: BLE001 — 记录后继续抛出
            await self._record(
                task_id=task_id, caller="ai", resolved=resolved,
                operation="stream_chat", status="error", started_at=started,
                error=str(exc)[:500],
            )
            raise
        finally:
            await client.aclose()
        await self._record(
            task_id=task_id, caller="ai", resolved=resolved,
            operation="stream_chat", status="ok", started_at=started,
        )

    async def score(
        self, *, title: str, content: str, source: str = "", task_id: str | None = None
    ) -> ScoreResult:
        """Rubric scoring: fast 模型 + JSON 结构化输出；失败回退启发式。

        v0.19：有频道洞察时注入 rubric 参考——评分向本账号受众偏好校准
        （数据飞轮一期；洞察生成失败静默跳过，不阻塞评分）。
        v0.25：成本阶梯降级——critical/exceeded 时强制启发式（零 API），
        warning 时仍走 LLM（已有 heuristic 预筛 70% 节省，阶梯在 ScoreStep 再收口）。"""
        # 成本阶梯预检（v0.25）：critical+ 强制本地启发式，节省 API
        try:
            from backend.ai.costs import get_budget_state

            state = await get_budget_state()
            if state is not None and state["level"] in ("critical", "exceeded"):
                logger.info(
                    "score downgraded to heuristic: budget %s (%.0f%%)",
                    state["level"], state["ratio"] * 100,
                )
                return self._heuristic_score(title=title, content=content)
        except Exception:  # noqa: BLE001 — 预算查询失败不阻塞评分
            pass
        msgs = score_prompts.build_score_messages(title=title, content=content, source=source)
        insight_suffix = await self._insight_suffix()
        if insight_suffix:
            msgs[0]["content"] += insight_suffix
        try:
            text = await self._collect(
                [ChatMessage(**m) for m in msgs], temperature=0.3, max_tokens=1024,
                role="fast", operation="score", task_id=task_id,
            )
            data = self._extract_json(text)
            if data is None:
                return self._heuristic_score(title=title, content=content)
            return ScoreResult(
                total=float(data.get("total", 0.0)),
                dimensions=data.get("dimensions") or {},
                reasons=[str(r) for r in (data.get("reasons") or [])],
            )
        except RuntimeError:
            # LLM 完全未配置：契约是报错而非静默（AXIOM §4.2 快速失败）
            raise
        except Exception:  # noqa: BLE001 — LLM 挂了也要能出分
            return self._heuristic_score(title=title, content=content)

    @staticmethod
    def _persona_suffix() -> str:
        """频道人设记忆（v0.18）：配置非空时拼到创作类 system prompt 尾部。
        只影响脚本与标题生成——翻译保持忠实不掺调性。"""
        from backend.config import settings

        persona = str(getattr(settings, "channel_persona", "") or "").strip()
        return f"\n\n频道人设（务必遵守）：\n{persona}" if persona else ""

    @staticmethod
    async def _insight_suffix() -> str:
        """频道洞察注入（v0.19 数据飞轮）：评分 rubric 参考本账号历史表现。
        读取最新洞察；任何异常静默跳过（洞察是增强不是依赖）。"""
        try:
            from backend.pipeline.insights import latest, prompt_suffix

            return prompt_suffix(await latest())
        except Exception:  # noqa: BLE001 — 洞察失败不阻塞评分
            return ""

    async def script(
        self, *, content: str, title: str = "", max_words: int = 90,
        task_id: str | None = None, story: bool = False,
    ) -> str:
        # v0.11.7 情感故事产线：story=True → 中文故事旁白 prompt
        if story:
            msgs = script_prompts.build_story_messages(
                content=content, title=title, max_words=max_words or 450
            )
        else:
            msgs = script_prompts.build_script_messages(
                content=content, title=title, max_words=max_words
            )
        persona = self._persona_suffix()
        insight = await self._insight_suffix()
        if persona or insight:
            msgs[0]["content"] += persona + insight
        return (
            await self._collect(
                [ChatMessage(**m) for m in msgs], temperature=0.8,
                role="fast", operation="script", task_id=task_id,
            )
        ).strip()

    async def title_and_tags(
        self, *, script: str, content: str = "", task_id: str | None = None
    ) -> TitleResult:
        msgs = title_prompts.build_title_messages(script=script, content=content)
        persona = self._persona_suffix()
        if persona:
            msgs[0]["content"] += persona
        try:
            text = await self._collect(
                [ChatMessage(**m) for m in msgs], temperature=0.7, max_tokens=1024,
                role="fast", operation="title", task_id=task_id,
            )
            data = self._extract_json(text)
            if data is None:
                return TitleResult(title=script[:40], tags=[], description="")
            # Phase 4.2 地基回哺：AI 标题/描述过 monoline display_text.tidy——
            # 首尾冗余标点清理（句中保留），上屏/发布标题单一 owner。
            from backend.monoline.display_text import tidy as _tidy

            alts = [_tidy(a)[:80] for a in (data.get("alternatives") or [])]
            alts = [str(a).strip() for a in alts]
            title = _tidy(str(data.get("title", "")))[:80]
            return TitleResult(
                title=title,
                tags=[str(t) for t in (data.get("tags") or [])][:6],
                description=_tidy(str(data.get("description", ""))),
                # v0.15 标题 N 选 1：去重去空、剔除与主标题相同者，最多 3 个
                alternatives=[a for a in alts if a and a != title][:3],
            )
        except Exception:  # noqa: BLE001 — 兜底标题
            return TitleResult(title=script[:40], tags=[], description="")

    async def generate_image(self, prompt: str, **params) -> ImageResult:
        """文生图：从注册表解析 image 角色（comfyui）并调用。"""
        if self._image is not None:
            return await self._image.generate(prompt, **params)  # 测试兜底
        resolved = await self._registry.resolve_role("image")
        if resolved is None:
            raise RuntimeError("Image provider not configured")
        from backend.ai.providers.comfyui import ComfyUIProvider

        output_dir = self._registry.image_output_dir()
        provider = ComfyUIProvider(
            base_url=resolved["base_url"] or "http://127.0.0.1:8188",
            output_dir=output_dir,
        )
        try:
            return await provider.generate(prompt, **params)
        finally:
            await provider.aclose()

    async def image_reachable(self) -> bool:
        if self._image is not None:
            if hasattr(self._image, "is_reachable"):
                return await self._image.is_reachable()
            return True
        resolved = await self._registry.resolve_role("image")
        if resolved is None:
            return False
        from backend.ai.providers.comfyui import ComfyUIProvider

        provider = ComfyUIProvider(base_url=resolved["base_url"] or "http://127.0.0.1:8188")
        try:
            return await provider.is_reachable()
        finally:
            await provider.aclose()

    async def synthesize(self, text: str, voice: str = "", rate: str = "") -> bytes:
        """语音合成：从注册表解析 tts 角色，模型 key 即音色，protocol 决定连接器。
        edge_tts（远端免费）/ kokoro（本地 ONNX，中文声调正确，monoline 融合）。
        v0.8.9：rate 透传（pipeline_tts_rate，对齐原项目 tts_rate）。"""
        if self._tts is not None:
            return await self._tts.synthesize(text, voice)  # 测试兜底
        resolved = await self._registry.resolve_role("tts")
        if resolved is None:
            raise RuntimeError("TTS provider not configured")
        protocol = resolved.get("protocol") or "edge_tts"
        if protocol == "kokoro":
            from backend.ai.providers.kokoro import KokoroProvider

            provider = KokoroProvider()
        else:
            from backend.ai.providers.edge_tts import EdgeTTSProvider

            provider = EdgeTTSProvider()
        try:
            from backend.config import settings

            # 显式 voice 优先；否则用角色配置的音色（模型 key）
            return await provider.synthesize(
                text, voice or resolved["model_key"], rate or settings.pipeline_tts_rate
            )
        finally:
            await provider.aclose()

    # ----- fallbacks -----

    @staticmethod
    def _extract_json(text: str) -> dict | None:
        text = text.strip()
        match = _JSON_BLOCK_RE.search(text)
        if match:
            text = match.group(1).strip()
        try:
            data = json.loads(text)
            return data if isinstance(data, dict) else None
        except json.JSONDecodeError:
            return None

    @staticmethod
    def _heuristic_score(*, title: str, content: str) -> ScoreResult:
        """Cheap content-based scoring when the LLM path fails (AXIOM §4.6-style resilience)."""
        length = len(content) + len(title)
        total = 5.0
        reasons = []
        if length > 200:
            total += 1.0
            reasons.append("内容充实")
        if len(title) > 8:
            total += 0.5
            reasons.append("标题具体")
        total = min(total, 10.0)
        return ScoreResult(total=round(total, 1), reasons=reasons, fallback=True)

    async def aclose(self) -> None:
        for provider in (self._image, self._tts):
            if provider is not None:
                await provider.aclose()


def _uuid(value: str):
    from uuid import UUID

    return UUID(value)


# 兼容旧名（engine/流水线/测试仍用 AIRouter）：v2.0 起 TaskRouter 为正式名
AIRouter = TaskRouter
