"""素材库 AI 整理域（v0.22.x B 系下沉，自 routers/library.py 迁出）。

职责单一：prompt 构造 / LLM 调用 / 宽松 JSON 解析 / 结果映射。
路由层只保留：输入校验（批次上限/路径围栏）、LLM 可用性检查、
HTTP 语义转译。
"""

import json
import logging
import re
from pathlib import Path

from backend.ai.types import ChatMessage

logger = logging.getLogger(__name__)

_MAX_BATCH = 20

_SYSTEM = (
    "你是素材库整理助手。根据文件名与常见约定推断内容主题，给出整理建议。\n"
    '只输出 JSON，格式：{"items":[{"tags":["标签1","标签2"],'
    '"suggested_name":"建议文件名（含扩展名）"}]}\n'
    "数组顺序与输入一致，不要包含路径字段。规则：\n"
    "① tags 2-5 个、用中文、概括内容主题与类型；无法判断的给空数组；\n"
    "② suggested_name 简洁可读、保留扩展名；无法判断的给原文件名；\n"
    "③ 只输出 JSON，不要解释。"
)


def _extract_json(text: str) -> dict | None:
    """宽松解析 LLM 输出：优先 ```json 代码块，其次纯 JSON。"""
    text = text.strip()
    match = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.DOTALL)
    candidate = match.group(1) if match else text
    try:
        data = json.loads(candidate)
        return data if isinstance(data, dict) else None
    except ValueError:
        return None


async def suggest_organization(ai, targets: list[Path]) -> list[dict]:
    """为文件列表生成整理建议（tags + suggested_name），按输入顺序映射回路径。

    LLM 幻造的 path 字段被忽略——批次内路径围栏兜底。解析失败抛 RuntimeError
    （调用方转 HTTP 502）。
    """
    listing = "\n".join(f"- {t.name}（{t.suffix or '无扩展名'}）" for t in targets)
    messages = [
        ChatMessage(role="system", content=_SYSTEM),
        ChatMessage(role="user", content=f"以下文件需要整理（按顺序对应输出）：\n{listing}"),
    ]
    text = await ai.chat_messages(messages, role="fast", max_tokens=1200)

    data = _extract_json(text)
    raw_items = (data or {}).get("items") if data else None
    if not isinstance(raw_items, list):
        raise RuntimeError("AI 返回格式无法解析")

    results: list[dict] = []
    for i, item in enumerate(raw_items[:_MAX_BATCH]):
        if i >= len(targets) or not isinstance(item, dict):
            continue
        tags = [str(x).strip() for x in item.get("tags") or [] if str(x).strip()][:8]
        name = str(item.get("suggested_name") or "").strip()
        results.append({"path": str(targets[i]), "tags": tags, "suggested_name": name})
    return results
