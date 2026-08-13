"""Step registry — mirrors the phase registry pattern (orchestration/phases).

StepEngine looks steps up by key. Collect is the only step with no input
status (it creates items); every other step consumes a specific status and
emits the next one.

流程顺序单一真相源（v0.8.4）：PIPELINE_ORDER 同时供 run_chain 与 step_keys 使用，
避免两处维护分叉（engine.py 曾另存一份 STEP_ORDER）。
"""

from backend.pipeline.base import Pipe

# 全流程顺序（含 collect）；step_keys 按此顺序过滤可运行步骤
PIPELINE_ORDER: tuple[str, ...] = ("collect", "score", "download", "produce", "publish")

_STEP_INDEX: dict[str, type[Pipe]] = {}


def get_step(key: str) -> type[Pipe]:
    try:
        return _STEP_INDEX[key]
    except KeyError:
        raise KeyError(f"unknown pipeline step '{key}'") from None


def step_keys() -> list[str]:
    """按流程顺序返回可运行步骤（collect 无输入状态，单独管理）。"""
    return [k for k in PIPELINE_ORDER if k in _STEP_INDEX]


from backend.pipeline.steps.download import DownloadStep  # noqa: E402
from backend.pipeline.steps.produce import ProduceStep  # noqa: E402
from backend.pipeline.steps.publish import PublishStep  # noqa: E402
from backend.pipeline.steps.score import ScoreStep  # noqa: E402

for _cls in (DownloadStep, ProduceStep, PublishStep, ScoreStep):
    _STEP_INDEX[_cls.name] = _cls
