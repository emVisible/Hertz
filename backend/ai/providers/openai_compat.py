"""OpenAI-compatible LLM provider (deepseek / openai / ollama / xinference / siliconflow).

All providers speak the OpenAI chat-completions protocol; the only
differences are base URL, key and model name. One implementation serves
them all (AXIOM §1.2: 同一协议不重复实现). v2.0 起支持 /v1/models 拉取。
v4.2：支持 enable_thinking（硅基流动 DeepSeek-V3.2 等思考模型）——
创作任务默认关闭思考链，避免 40s+ 推理延迟卡住编排（实测 46s → 2.5s）。
"""

import asyncio
import json
from collections.abc import AsyncIterator

import httpx

from backend.ai.types import ChatMessage

# 瞬时网关错误：ollama 过载/代理闪断时会吐这些，重试往往就好（幂等 POST）。
_RETRYABLE_STATUS = {502, 503, 504}


def _is_local_url(base_url: str) -> bool:
    lowered = (base_url or "").lower()
    return "localhost" in lowered or "127.0.0.1" in lowered or "::1" in lowered


def _hint_for(base_url: str, model: str, status: int | None) -> str:
    """给前端/日志的可执行下一步（v0.30.2：本地 ollama 502 排障）。"""
    if _is_local_url(base_url):
        return (
            f"本地模型调用失败（{base_url} 模型 {model}，HTTP {status}）。"
            "请检查：1）`ollama serve` 是否在运行；2）`ollama list` 是否有该模型"
            "（没有则 `ollama pull <模型名>`）；3）如开着 Clash/代理，确认 localhost "
            "已走直连（Hertz 已默认绕过环境代理变量）。"
        )
    return f"远端模型调用失败（{base_url} 模型 {model}，HTTP {status}），稍后重试或切换模型。"


class OpenAICompatProvider:
    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.deepseek.com/v1",
        model: str = "deepseek-chat",
        max_retries: int = 2,
    ) -> None:
        self.model = model
        self.max_retries = max_retries
        self.last_usage: dict | None = None  # v0.5 E：流式 usage 探测（成本估算）
        from backend.infrastructure.net import client_kwargs

        base = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=base,
            headers={"Authorization": f"Bearer {api_key}"} if api_key else {},
            # 本地 Provider（Ollama/ComfyUI/xinference 常在 127.0.0.1）必须直连：
            # 代理到不了回环地址，Clash 在时只会回 502；判据在 infrastructure/net。
            # 远端主机则照常跟随环境变量里的代理设置（v0.33 收口后有意的行为变化）。
            **client_kwargs(base, timeout=httpx.Timeout(30.0, read=180.0)),
        )

    async def chat_stream(
        self,
        messages: list[ChatMessage],
        *,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        model: str | None = None,
        response_format: dict | None = None,
        enable_thinking: bool | None = None,
    ) -> AsyncIterator[str]:
        payload: dict = {
            "model": model or self.model,
            "messages": [m.__dict__ for m in messages],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,
        }
        if response_format:
            payload["response_format"] = response_format
        if enable_thinking is not None:
            # 硅基流动等平台：思考模式开关（DeepSeek-V3.2 等推理模型）
            payload["enable_thinking"] = enable_thinking
        last_error: Exception | None = None
        for attempt in range(self.max_retries + 1):
            yielded = False
            try:
                async for token in self._stream_once(payload):
                    yielded = True
                    yield token
                return
            except httpx.HTTPStatusError as exc:
                last_error = exc
                status = exc.response.status_code if exc.response is not None else None
                # 已吐出 token 后再失败不能重放（会重复）——直接带 hint 抛出；
                # 未出 token 的 502/503/504 才值得退避重试（ollama 瞬时过载/代理闪断）。
                if yielded or status not in _RETRYABLE_STATUS or attempt >= self.max_retries:
                    raise RuntimeError(
                        f"{_hint_for(str(self._client.base_url), payload.get('model', ''), status)}"
                        f" 原始错误：{exc}"
                    ) from exc
                await asyncio.sleep(1.0 * (2**attempt))
            except (httpx.ConnectError, httpx.ReadTimeout, httpx.RemoteProtocolError) as exc:
                last_error = exc
                if yielded or attempt >= self.max_retries:
                    raise RuntimeError(
                        f"{_hint_for(str(self._client.base_url), payload.get('model', ''), None)}"
                        f" 原始错误：{exc}"
                    ) from exc
                await asyncio.sleep(1.0 * (2**attempt))
        if last_error is not None:
            raise last_error

    async def _stream_once(self, payload: dict) -> AsyncIterator[str]:
        async with self._client.stream("POST", "/chat/completions", json=payload) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data == "[DONE]":
                    break
                try:
                    parsed = json.loads(data)
                    # v0.5 E 成本估算：探测流式 usage（部分 OpenAI 兼容 API 携带）
                    usage = parsed.get("usage")
                    if isinstance(usage, dict):
                        self.last_usage = {
                            "prompt_tokens": int(usage.get("prompt_tokens") or 0),
                            "completion_tokens": int(usage.get("completion_tokens") or 0),
                        }
                    choice = (parsed.get("choices") or [{}])[0]
                    delta = choice.get("delta") or {}
                    # 推理模型（deepseek-reasoner 的 reasoning_content /
                    # ollama gemma 的 reasoning）只占思考位，不计正文——跳过不吐，
                    # 避免把思考链混进工作流产物。
                    delta_content = delta.get("content")
                except (json.JSONDecodeError, KeyError, IndexError, AttributeError):
                    continue
                if delta_content:
                    yield delta_content

    async def list_models(self) -> list[str]:
        """GET /v1/models — 拉取远端模型列表（v2.0 模型库）。"""
        try:
            resp = await self._client.get("/models")
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code if exc.response is not None else None
            raise RuntimeError(
                f"{_hint_for(str(self._client.base_url), self.model, status)} 原始错误：{exc}"
            ) from exc
        data = resp.json()
        return [str(m["id"]) for m in data.get("data", []) if isinstance(m, dict) and m.get("id")]

    async def aclose(self) -> None:
        await self._client.aclose()
