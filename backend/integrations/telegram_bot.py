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
from datetime import UTC, datetime
from pathlib import Path

import httpx
from sqlalchemy import select

from backend.config import settings
from backend.models.session import session_factory
from backend.models.system import TelegramNotification

logger = logging.getLogger(__name__)

_API = "https://api.telegram.org/bot{token}/{method}"
_ACTIONS = ("approve", "reject", "back_to_prep")
_POLL_TIMEOUT_S = 25  # long-polling 挂起时长


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
    """待审核且未推送过卡片的条目（按 seq 升序，FIFO 待办提醒语义）。

    v0.19：已通知排除下沉到 SQL（NOT IN 子查询）；排序取**最新优先**
    （seq desc）——审核员关心新内容，历史积压不应饿死新条目（全量测试
    暴露的真实缺陷）。极老积压仍在队列页可见，bot 只是提醒通道之一。
    """
    from backend.models.item import Item, ItemStatus
    from backend.pipeline.publish_queue import PHASE_NONE

    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item)
                .where(
                    Item.status == ItemStatus.QUEUED,
                    Item.archived.is_(False),
                    Item.queue_phase == PHASE_NONE,
                    Item.id.not_in(select(TelegramNotification.item_id)),
                )
                .order_by(Item.seq.desc())
                .limit(limit)
            )
        ).scalars().all()
    return list(rows)


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


# ---------- 周报（v0.19） ----------


async def weekly_report_tick(service) -> None:
    """每周一次产能/花费/爆款摘要（7 天节流，重启重置最多延后不发重）。"""
    import time as _time

    if not enabled() or not bool(getattr(settings, "telegram_weekly", True)):
        return
    now_ts = _time.time()
    last = getattr(weekly_report_tick, "_last", 0.0)
    if now_ts - last < 7 * 86400:
        return

    from datetime import timedelta as _td

    from sqlalchemy import func

    from backend.models.item import Item, ItemStatus

    rate = float(getattr(settings, "cost_usd_rate", 7.2) or 1.0)
    currency = str(getattr(settings, "cost_currency", "CNY") or "CNY")
    symbol = {"CNY": "¥", "USD": "$"}.get(currency.upper(), "$")
    since = datetime.now(UTC) - _td(days=7)

    async with session_factory() as session:
        pub_rows = (
            await session.execute(
                select(Item).where(
                    Item.status == ItemStatus.PUBLISHED,
                    Item.published_at >= since,
                    Item.archived.is_(False),
                )
            )
        ).scalars().all()
        queued_n = await session.scalar(
            select(func.count(Item.id)).where(
                Item.status == ItemStatus.QUEUED, Item.archived.is_(False),
            )
        )
        holding_n = await session.scalar(
            select(func.count(Item.id)).where(
                Item.queue_phase == "holding", Item.archived.is_(False))
        )

    from backend.ai.costs import estimate_cost

    # 近 7 天 AI 花费：从 ai_calls 取（与成本页同口径）
    week_cost = 0.0
    from backend.models.ai_registry import AICall

    async with session_factory() as session:
        call_rows = (
            await session.execute(
                select(AICall.prompt_tokens, AICall.completion_tokens,
                       AICall.model_key).where(AICall.created_at >= since)
            )
        ).all()
    prices_map = dict(getattr(settings, "ai_model_prices", {}) or {})
    for pt, ct, mk in call_rows:
        c = estimate_cost(mk, pt, ct, prices_map)
        if c is not None:
            week_cost += c
    week_cost = round(week_cost * rate, 2)

    def _views(it):
        return ((it.publish_json or {}).get("stats") or {}).get("view") or 0

    top = max(pub_rows, key=_views) if pub_rows else None
    top_views = _views(top) if top else 0

    lines = [
        f"📊 Hertz 周报（{since.strftime('%m-%d')} 起）",
        f"· 本周发布 {len(pub_rows)} 条 · AI 成本 {symbol}{week_cost}",
    ]
    if top is not None and top_views:
        stats = (top.publish_json or {}).get("stats") or {}
        lines.append(f"· 最高播放：《{(top.title or '')[:40]}》{stats.get('view')}次")
    lines.append(f"· 待审 {queued_n} · 囤货 {holding_n}")
    budget = float(getattr(settings, "cost_monthly_budget", 0.0) or 0.0)
    if budget > 0:
        lines.append(f"· 月预算 {symbol}{budget}（详见成本页阶梯提示）")
    report = "\n".join(lines)

    async with httpx.AsyncClient() as client:
        result = await _call(client, "sendMessage",
                             {"json": {"chat_id": _chat_id(), "text": report}})
    if result:
        weekly_report_tick._last = now_ts
        logger.info("tg weekly report sent (%d published)", len(pub_rows))


# ---------- 告警通道（预算/制作失败复用） ----------


async def push_alert(text: str) -> None:
    """告警入口：预算阶梯、批量失败等复用 bot 通道（best-effort）。"""
    if not enabled():
        return
    async with httpx.AsyncClient() as client:
        await _call(client, "sendMessage",
                    {"json": {"chat_id": _chat_id(), "text": html.escape(text[:1000])}})
