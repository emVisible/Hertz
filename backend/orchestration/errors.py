"""Orchestration domain errors."""

from backend.errors import HertzError


class OrchestrationError(HertzError):
    """Base error for the orchestration domain (message carries a code prefix)."""


class NotFoundError(OrchestrationError):
    def __init__(self, message: str = "Resource not found") -> None:
        super().__init__("not_found", message)


class AlreadyRunningError(OrchestrationError):
    def __init__(self, message: str = "A run is already in progress") -> None:
        super().__init__("already_running", message)


class InvalidPlanError(OrchestrationError):
    def __init__(self, message: str = "Invalid plan") -> None:
        super().__init__("invalid_plan", message)
