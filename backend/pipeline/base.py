"""Pipeline abstractions shared by the execution domain.

Contract: a Pipe declares which item statuses it consumes and the status it
produces; the engine owns status persistence. Pipes never write item status
directly — they return a ProcessResult and the engine applies it (AXIOM:
engine as the single authority on state transitions).
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ProcessResult:
    """Outcome of processing one item through one pipe."""

    status: str  # the item status the engine should apply (or keep)
    data: dict = field(default_factory=dict)
    error: str = ""
    # 跳过标记（v0.3.6）：冷却/熔断等非失败跳过——摘要计「跳过」而非「成功」
    skip: bool = False


@dataclass
class StepContext:
    """Per-run context handed to every pipe invocation.

    ``emit`` broadcasts a JSON event to the pipeline topic (EventHub);
    ``settings`` is the app config for feature flags / thresholds;
    ``ai`` is the AIRouter for LLM/score/tts tasks.
    ``scores_used`` 运行内已消费的评分预算（成本闸门，同批共享）。
    """

    run_id: str
    settings: Any
    ai: Any = None
    emit: Any = None
    scores_used: int = 0

    def log(self, message: str, level: str = "info") -> None:
        if self.emit is not None:
            self.emit({"type": "log", "message": message, "level": level})


class Pipe(ABC):
    """One pipeline step, looked up by ``name`` in the step registry."""

    name: str = ""
    # Item statuses this step consumes; empty = no precondition (e.g. collect)
    input_statuses: tuple[str, ...] = ()

    @abstractmethod
    async def process(self, ctx: StepContext, item) -> ProcessResult:
        """Process one item. Raise StepError to mark the item failed."""
        ...


class StepError(RuntimeError):
    """Raised by a pipe to fail the current item with a diagnostic message."""
