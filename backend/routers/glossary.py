"""Glossary routes (v0.15): 翻译术语表 CRUD + AI 辅助生成候选。

职责单一：本路由只管术语数据与候选抽取；prompt 注入在
pipeline/producers/media.py（消费侧）。
"""

import json
import logging
import uuid

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select

from backend.factory.registry import ServiceRegistry
from backend.models.glossary import GlossaryTerm
from backend.models.session import session_factory

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/glossary", tags=["glossary"])


def _serialize(r: GlossaryTerm) -> dict:
    return {
        "id": str(r.id),
        "source_term": r.source_term,
        "target_term": r.target_term,
        "domain": r.domain,
        "enabled": r.enabled,
    }


@router.get("")
async def list_terms(
    query: str = Query("", max_length=100),
    limit: int = Query(200, ge=1, le=500),
) -> dict:
    async with session_factory() as session:
        stmt = select(GlossaryTerm).order_by(GlossaryTerm.updated_at.desc()).limit(limit)
        if query.strip():
            like = f"%{query.strip()}%"
            stmt = stmt.where(
                or_(
                    GlossaryTerm.source_term.ilike(like),
                    GlossaryTerm.target_term.ilike(like),
                )
            )
        rows = (await session.execute(stmt)).scalars().all()
    return {"terms": [_serialize(r) for r in rows]}


class TermBody(BaseModel):
    source_term: str = Field(min_length=1, max_length=120)
    target_term: str = Field(min_length=1, max_length=120)
    domain: str = Field(default="", max_length=32)


@router.post("")
async def add_term(body: TermBody) -> dict:
    """新增/更新（source_term 幂等：已存在则更新译名与分类）。"""
    src = body.source_term.strip()
    if not src:
        raise HTTPException(status_code=422, detail="source_term is required")
    async with session_factory() as session:
        row = (
            await session.execute(
                select(GlossaryTerm).where(GlossaryTerm.source_term == src)
            )
        ).scalar_one_or_none()
        if row is None:
            row = GlossaryTerm(source_term=src)
            session.add(row)
        row.target_term = body.target_term.strip()
        row.domain = body.domain
        await session.commit()
        await session.refresh(row)
        return _serialize(row)


class TermUpdate(BaseModel):
    target_term: str | None = Field(default=None, min_length=1, max_length=120)
    domain: str | None = Field(default=None, max_length=32)
    enabled: bool | None = None


@router.put("/{term_id}")
async def update_term(term_id: uuid.UUID, body: TermUpdate) -> dict:
    async with session_factory() as session:
        row = await session.get(GlossaryTerm, term_id)
        if row is None:
            raise HTTPException(status_code=404, detail="term not found")
        if body.target_term is not None:
            row.target_term = body.target_term.strip()
        if body.domain is not None:
            row.domain = body.domain
        if body.enabled is not None:
            row.enabled = body.enabled
        await session.commit()
        await session.refresh(row)
        return _serialize(row)


@router.delete("/{term_id}")
async def delete_term(term_id: uuid.UUID) -> dict:
    async with session_factory() as session:
        row = await session.get(GlossaryTerm, term_id)
        if row is None:
            raise HTTPException(status_code=404, detail="term not found")
        await session.delete(row)
        await session.commit()
    return {"id": str(term_id), "deleted": True}


class SuggestBody(BaseModel):
    text: str = Field(min_length=10, max_length=20_000)


@router.post("/suggest")
async def suggest_terms(body: SuggestBody) -> dict:
    """AI 辅助生成候选术语对（fast 池，不自动入库——前端勾选后走 POST）。"""
    from backend.ai.types import ChatMessage

    ai = ServiceRegistry.get().ai
    messages = [
        ChatMessage(role="system", content=(
            "你是字幕组术语审校。从文本中提取值得统一译法的专有名词"
            "（人名/频道名/品牌/地名/网络梗），输出 JSON 数组，每项：\n"
            '{"source": "原文", "target": "中文译名", "domain": "person|brand|term"}\n'
            "最多 15 个；普通词不要；无法确定译名的不要编造。只输出 JSON 数组。"
        )),
        ChatMessage(role="user", content=body.text[:8000]),
    ]
    try:
        raw = await ai.chat_messages(
            messages, role="fast", max_tokens=1500,
            operation="glossary", caller="pipeline",
        )
    except RuntimeError as exc:  # LLM 未配置等
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — 抽取失败降级为空候选
        logger.warning("glossary suggest failed: %s", exc)
        return {"candidates": [], "warning": str(exc)[:200]}

    # 解析：剥 markdown 栅栏后取第一个 JSON 数组；失败返回空（不阻塞）
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`").lstrip("json").strip()
    start, end = text.find("["), text.rfind("]")
    candidates: list[dict] = []
    if start != -1 and end > start:
        try:
            parsed = json.loads(text[start : end + 1])
            for item in parsed if isinstance(parsed, list) else []:
                if (
                    isinstance(item, dict)
                    and str(item.get("source") or "").strip()
                    and str(item.get("target") or "").strip()
                ):
                    candidates.append(
                        {
                            "source_term": str(item["source"]).strip()[:120],
                            "target_term": str(item["target"]).strip()[:120],
                            "domain": str(item.get("domain") or "term")[:32],
                        }
                    )
        except ValueError:
            logger.warning("glossary suggest: unparseable LLM output")
    return {"candidates": candidates[:15]}
