"""Pipeline domain errors — typed failures for the review/run surfaces.

Mirrors download/errors.py and orchestration/errors.py so routers can map
each failure class to the correct HTTP status (404 vs 409 vs 422) instead of
collapsing everything into one code (AXIOM §4.2 / §28).
"""


class PipelineError(RuntimeError):
    """Base class for pipeline domain errors."""


class ItemNotFoundError(PipelineError):
    """The referenced item does not exist (→ 404)."""


class InvalidItemStateError(PipelineError):
    """The item exists but is not in a state that allows the action (→ 409)."""


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
    if "timeout" in text or "timed out" in text:
        return "timeout"
    if any(k in text for k in ("edge_tts", "edge-tts", "tts ")):
        return "tts"
    if "ffmpeg" in text or "command timed out" in text:
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
