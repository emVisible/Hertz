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
