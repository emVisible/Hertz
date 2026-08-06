"""OpenAI-compatible LLM provider (deepseek / openai / ollama / xinference / siliconflow).

All providers speak the OpenAI chat-completions protocol; the only
differences are base URL, key and model name. One implementation serves
them all (AXIOM §1.2: 同一协议不重复实现). v2.0 起支持 /v1/models 拉取。
v4.2：支持 enable_thinking（硅基流动 DeepSeek-V3.2 等思考模型）——
创作任务默认关闭思考链，避免 40s+ 推理延迟卡住编排（实测 46s → 2.5s）。
"""

import json
from collections.abc import AsyncIterator

import httpx

from backend.ai.types import ChatMessage


class OpenAICompatProvider:
    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.deepseek.com/v1",
        model: str = "deepseek-chat",
    ) -> None:
        self.model = model
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}"} if api_key else {},
            timeout=httpx.Timeout(30.0, read=180.0),
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
        async with self._client.stream("POST", "/chat/completions", json=payload) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data == "[DONE]":
                    break
                try:
                    delta = json.loads(data)["choices"][0]["delta"].get("content")
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
                if delta:
                    yield delta

    async def list_models(self) -> list[str]:
        """GET /v1/models — 拉取远端模型列表（v2.0 模型库）。"""
        resp = await self._client.get("/models")
        resp.raise_for_status()
        data = resp.json()
        return [str(m["id"]) for m in data.get("data", []) if isinstance(m, dict) and m.get("id")]

    async def aclose(self) -> None:
        await self._client.aclose()
