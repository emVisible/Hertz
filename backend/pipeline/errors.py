"""Pipeline domain errors — typed failures for the review/run surfaces.

继承共享 HertzError（AXIOM §24.1 稳定 code）：全局 handler 按 code 映射
HTTP 状态（404/409），路由层不再需要逐端点 try/except 包装（v0.8 查漏补缺）。
"""

from backend.errors import HertzError


class PipelineError(HertzError):
    """Base class for pipeline domain errors."""

    def __init__(self, message: str, code: str = "pipeline_error") -> None:
        super().__init__(code, message)


class ItemNotFoundError(PipelineError):
    """The referenced item does not exist (→ 404)."""

    def __init__(self, item_id) -> None:
        super().__init__(f"item not found: {item_id}", code="item_not_found")


class InvalidItemStateError(PipelineError):
    """The item exists but is not in a state that allows the action (→ 409)."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="invalid_item_state")


# 失败分类（参考原项目 Autarkeia 失败看板）：按类聚合统计 + 同类批量重试
FAILURE_CLASSES = (
    "blocked",  # 403/404/405 被拒或拒绝访问
    "rate_limit",  # 429/限流
    "timeout",  # 超时
    "llm",  # LLM 服务/配置
    "tts",  # 语音合成
    "ffmpeg",  # 媒体处理命令
    "download",  # 下载引擎
    "publish",  # 发布目标
    "internal",  # 未分类的内部崩溃
    "other",
)


def classify_error(error: str, step: str = "") -> str:
    """按错误文本归入失败类别（顺序敏感：先特异性后通用）。"""
    text = (error or "").lower()
    if any(k in text for k in ("403", "405", "404", "refused", "forbidden", "blocked")):
        return "blocked"
    if any(k in text for k in ("429", "rate limit", "too many")):
        return "rate_limit"
    if "command timed out" in text:
        return "ffmpeg"  # ffmpeg 命令超时归媒体处理
    if "timeout" in text or "timed out" in text:
        return "timeout"
    if any(k in text for k in ("edge_tts", "edge-tts", "tts ")):
        return "tts"
    if "ffmpeg" in text:
        return "ffmpeg"
    if any(k in text for k in ("llm", "provider", "not configured")):
        return "llm"
    if "publish" in text or step == "publish":
        return "publish"
    if "download" in text or step == "download":
        return "download"
    if "internal" in text:
        return "internal"
    return "other"
