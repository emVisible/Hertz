"""一次性告警去重（v0.32 S4）——原来这份逻辑长在 `translate_engine` 里。

语义：同一告警 key 在一个周期内只推一次 Telegram；成功恢复后由调用方 `reset()`
让下一轮失败重新可以告警。模型下载这类「后台静默失败」若每次转写都推一条会
变成噪音，完全不推又会像 D-189 那次事故一样没人知道——单次去重是折中。
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_alerted: set[str] = set()


def notify_once(key: str, text: str) -> None:
    """同一 key 只推一次（best-effort，绝不阻塞主流程）。"""
    if key in _alerted:
        return
    _alerted.add(key)
    _send(text)


def reset(key: str) -> None:
    """成功/状态恢复后复位，使下一次异常仍能告警一次。"""
    _alerted.discard(key)


def _send(text: str) -> None:
    import asyncio

    from backend.integrations.telegram_bot import push_alert

    async def _push() -> None:
        try:
            await push_alert(text)
        except Exception as exc:  # noqa: BLE001 — 告警通道本身失败不能拖垮业务
            logger.warning("alert push failed (%s): %s", type(exc).__name__, exc)

    try:
        asyncio.get_running_loop().create_task(_push())
    except RuntimeError:  # 无运行中事件循环（同步上下文/测试）
        logger.info("无事件循环，跳过告警投递：%s", text.splitlines()[0] if text else "")
