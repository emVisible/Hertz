"""Shared application error base (AXIOM §24.1 — stable machine-readable codes)."""


class HertzError(RuntimeError):
    """Application error carrying a stable code for ops classification."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")
