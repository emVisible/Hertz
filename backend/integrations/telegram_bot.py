"""Telegram 审核 Bot（v0.18）：把审核闸门装进口袋——移动端过审。

架构决策：
- **手写 long-polling 客户端**（httpx getUpdates）而非 python-telegram-bot 依赖、
  而非 webhook——本地桌面零公网暴露面（AXIOM §8 安全模型契合）
- 只响应配置的 telegram_chat_id，其余 chat 的回调静默忽略
- 待审推送去重：tg_notifications 表（item 唯一），重启不重推
- 回调动作白名单：approve / reject / back_to_prep——直接复用 PipelineService.act，
  与桌面端审核完全同源（同一闸门，不同入口）
- 封面图 multipart 直传（sendPhoto files），无公网文件服务也能发图

职责单一：本模块只做 Telegram 协议与推送/回调编排；业务动作全部委托
PipelineService（与桌面端同源）。
"""

import html
import logging
import uuid
from pathlib import Path

import httpx
from sqlalchemy import String, select
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.config import settings
from backend.models.base import BaseModel
from backend.models.session import session_factory

logger = logging.getLogger(__name__)

_API = "https://api.telegram.org/bot{token}/{method}"
_ACTIONS = ("approve", "reject", "back_to_prep")
_POLL_TIMEOUT_S = 25  # long-polling 挂起时长


class TelegramNotification(BaseModel):
    """已推送的 bot 通知（去重：同一条目同一动作只推一次）。"""

    __tablename__ = "tg_notifications"

    item_id: Mapped[uuid.UUID] = mapped_column(PGUUID(as_uuid=True), index=True)
    kind: Mapped[str] = mapped_column(String(32), default="review")
    message_id: Mapped[int] = mapped_column()


def enabled() -> bool:
    return bool(
        getattr(settings, "telegram_enabled", False)
        and getattr(settings, "telegram_bot_token", "")
        and getattr(settings, "telegram_chat_id", "")
    )


def _url(method: str) -> str:
    token = str(getattr(settings, "telegram_bot_token", "") or "")
    return _API.format(token=token, method=method)


def _chat_id() -> str:
    return str(getattr(settings, "telegram_chat_id", "") or "")


async def _call(client: httpx.AsyncClient, method: str, payload: dict) -> dict | None:
    """调用 Bot API；失败静默返回 None（bot 故障不拖垮流水线）。"""
    try:
        resp = await client.post(_url(method), **payload, timeout=40)
        data = resp.json()
        if not data.get("ok"):
            logger.warning("telegram %s failed: %s", method, str(data)[:200])
            return None
        return data.get("result")
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.warning("telegram %s error: %s", method, exc)
        return None


# ---------- 待审推送 ----------


async def _queued_unnotified(limit: int = 10) -> list:
    """待审核且未推送过卡片的条目（按 seq 升序）。"""
    from backend.models.item import Item, ItemStatus
    from backend.pipeline.publish_queue import PHASE_NONE

    async with session_factory() as session:
        notified = set(
            (
                await session.execute(select(TelegramNotification.item_id))
            ).scalars()
        )
        rows = (
            await session.execute(
                select(Item)
                .where(
                    Item.status == ItemStatus.QUEUED,
                    Item.archived.is_(False),
                    Item.queue_phase == PHASE_NONE,
                )
                .order_by(Item.seq.asc())
                .limit(limit * 3)
            )
        ).scalars().all()
    return [r for r in rows if r.id not in notified][:limit]


async def _mark_notified(item_id: uuid.UUID, kind: str, message_id: int) -> None:
    async with session_factory() as session:
        session.add(TelegramNotification(item_id=item_id, kind=kind, message_id=message_id))
        await session.commit()


def _caption(item) -> str:
    score = f"{item.score_total:.1f}" if item.score_total is not None else "?"
    return (
        f"<b>{html.escape((item.title or '')[:80])}</b>\n"
        f"r/{html.escape(item.subreddit or '')} · u/{html.escape(item.author or '')}\n"
        f"AI {score} · r{int(item.reddit_score or 0)}\n"
        f"{html.escape(item.source_url or '')}"
    )


def _keyboard(item_id: str) -> dict:
    return {"inline_keyboard": [[
        {"text": "✅ 通过", "callback_data": f"approve:{item_id}"},
        {"text": "↩️ 打回", "callback_data": f"back_to_prep:{item_id}"},
        {"text": "❌ 拒绝", "callback_data": f"reject:{item_id}"},
    ]]}


async def review_push_tick(service) -> None:
    """扫描 queued 新条目 → 推送审核卡片（封面 multipart 直传）。"""
    if not enabled():
        return
    items = await _queued_unnotified()
    if not items:
        return
    from backend.factory.registry import ServiceRegistry

    files = ServiceRegistry.get().files
    async with httpx.AsyncClient() as client:
        for item in items:
            photo = None
            try:
                if item.cover_path:
                    import asyncio as _aio

                    cover = files.resolve(item.cover_path)
                    # §7.2：封面读取走线程池（数百 KB 文件，避免阻塞事件循环）
                    photo = await _aio.to_thread(_read_bytes_safe, cover)
            except Exception:  # noqa: BLE001 — 封面缺失推纯文本
                photo = None
            payload = {
                "data": {
                    "chat_id": _chat_id(),
                    "caption": _caption(item),
                    "parse_mode": "HTML",
                    "reply_markup": _keyboard(str(item.id)),
                }
            }
            if photo is not None:
                payload["files"] = {"photo": ("cover.jpg", photo)}
                result = await _call(client, "sendPhoto", payload)
            else:
                result = await _call(client, "sendMessage", payload)
            if result and result.get("message_id"):
                await _mark_notified(item.id, "review", result["message_id"])
                logger.info("tg push review: %s", (item.title or "")[:40])


def _read_bytes_safe(cover) -> bytes | None:
    """封面字节（线程池调用）；失败返回 None 推纯文本。"""
    try:
        return Path(cover).read_bytes()
    except OSError:
        return None


# ---------- 回调轮询 ----------


def parse_callback(data: str | None) -> tuple[str, str] | None:
    """callback_data → (action, item_id)；非白名单返回 None。"""
    if not data or ":" not in data:
        return None
    action, _, item_id = data.partition(":")
    if action not in _ACTIONS or not item_id.strip():
        return None
    return action, item_id.strip()


async def poll_tick(service) -> None:
    """long-polling getUpdates → 处理审批回调。offset 存内存（重启重放无害：
    已处理条目的 act 幂等返回 InvalidItemStateError 被忽略）。"""
    if not enabled():
        return
    offset = getattr(poll_tick, "_offset", 0)
    async with httpx.AsyncClient() as client:
        result = await _call(
            client, "getUpdates",
            {"json": {"timeout": _POLL_TIMEOUT_S, "offset": offset,
                      "allowed_updates": ["callback_query"]}},
        )
    updates = result or []
    for u in updates:
        offset = max(offset, int(u.get("update_id", 0)) + 1)
        cq = u.get("callback_query")
        if not cq:
            continue
        if str(cq.get("from", {}).get("id")) != _chat_id().lstrip("@"):
            continue  # 非管理员 chat——静默忽略（§8 最小信任面）
        parsed = parse_callback(cq.get("data"))
        if parsed is None:
            continue
        action, item_id = parsed
        try:
            iid = uuid.UUID(item_id)
            await service.act_by_id(iid, action)  # 见 PipelineService.act_by_id
            verdict = {"approve": "已通过", "reject": "已拒绝",
                       "back_to_prep": "已打回预处理"}[action]
        except Exception as exc:  # noqa: BLE001 — 反馈给操作者
            verdict = f"失败：{str(exc)[:120]}"
        async with httpx.AsyncClient() as c2:
            await _call(c2, "answerCallbackQuery",
                        {"json": {"callback_query_id": cq["id"], "text": verdict}})
            msg = cq.get("message") or {}
            if msg.get("message_id"):
                await _call(c2, "editMessageText", {"json": {
                    "chat_id": msg["chat"]["id"],
                    "message_id": msg["message_id"],
                    "text": f"{verdict} · {_plain_caption_from_message(msg)}",
                }})
    poll_tick._offset = offset  # noqa: ATR300


def _plain_caption_from_message(msg: dict) -> str:
    text = str(msg.get("text") or "").split("\n")[0]
    return html.escape(text[:60])


# ---------- 告警通道（预算/制作失败复用） ----------


async def push_alert(text: str) -> None:
    """告警入口：预算阶梯、批量失败等复用 bot 通道（best-effort）。"""
    if not enabled():
        return
    async with httpx.AsyncClient() as client:
        await _call(client, "sendMessage",
                    {"json": {"chat_id": _chat_id(), "text": html.escape(text[:1000])}})
