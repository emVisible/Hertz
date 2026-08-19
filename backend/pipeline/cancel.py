"""单条制作协作式取消（wave11）：produce 期间前端可随时取消。

取消 = 模块级标志位 + 产线检查点轮询（单进程桌面应用，模块级单例足够）：
- 前端点「取消制作」→ 路由置位 request_cancel(item_id)
- produce_item 各耗时阶段之间 / _run_cmd ffmpeg 轮询（0.25s 粒度）命中 →
  抛 ItemCancelledError → produce_one 捕获 → 清理半成品 → 条目回 downloaded
- 制作结束（成功/失败/取消）由 produce_one 的 finally 统一清除标志，
  避免「取消后立即重制被陈旧标志立刻打断」；produce_one 开头也会先清一次。
"""

import logging
import uuid
from contextvars import ContextVar, Token

logger = logging.getLogger(__name__)


class ItemCancelledError(Exception):
    """协作式取消信号：produce 产线检查点抛出。

    继承 Exception（而非 asyncio.CancelledError）——engine._process_item 的
    ``except Exception`` 不会吞掉它（显式重抛），也不会被 asyncio 任务机制
    误当任务取消（我们只传播语义，不做 task.cancel）。
    """


_cancelled: set[str] = set()

# 当前制作中的条目（ContextVar，按任务隔离）：产线内部（_run_cmd 轮询 /
# 检查点）无需透传 item_id 参数即可查取消标志——各函数签名保持不动。
_active_item: ContextVar[str | None] = ContextVar("produce_active_item", default=None)


def request_cancel(item_id: uuid.UUID | str) -> None:
    """登记取消请求（幂等；条目未在制作中也无害——produce_one 开头会清）。"""
    _cancelled.add(str(item_id))
    logger.info("produce cancel requested for item %s", item_id)


def is_cancelled(item_id: uuid.UUID | str | None) -> bool:
    return item_id is not None and str(item_id) in _cancelled


def clear_cancel(item_id: uuid.UUID | str) -> None:
    _cancelled.discard(str(item_id))


def set_active_item(item_id: uuid.UUID | str | None) -> Token[str | None]:
    """登记当前制作条目（produce_item 入口调用，finally 复位）。"""
    return _active_item.set(str(item_id) if item_id is not None else None)


def reset_active_item(token: Token[str | None]) -> None:
    _active_item.reset(token)


def active_item() -> str | None:
    return _active_item.get()
