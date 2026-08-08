"""Step registry — mirrors the phase registry pattern (orchestration/phases).

StepEngine looks steps up by key. Collect is the only step with no input
status (it creates items); every other step consumes a specific status and
emits the next one.
"""

from backend.pipeline.base import Pipe

_STEP_INDEX: dict[str, type[Pipe]] = {}


def get_step(key: str) -> type[Pipe]:
    try:
        return _STEP_INDEX[key]
    except KeyError:
        raise KeyError(f"unknown pipeline step '{key}'") from None


def step_keys() -> list[str]:
    """按流程顺序返回可运行步骤（v5.9：download → score → produce → publish）。"""
    order = ("download", "score", "produce", "publish")
    return [k for k in order if k in _STEP_INDEX]


from backend.pipeline.steps.download import DownloadStep  # noqa: E402
from backend.pipeline.steps.produce import ProduceStep  # noqa: E402
from backend.pipeline.steps.publish import PublishStep  # noqa: E402
from backend.pipeline.steps.score import ScoreStep  # noqa: E402

for _cls in (DownloadStep, ProduceStep, PublishStep, ScoreStep):
    _STEP_INDEX[_cls.name] = _cls
