"""Download domain errors with stable machine-readable codes (AXIOM §24.1)."""

from backend.errors import HertzError


class DownloadError(HertzError):
    """Download failure carrying a stable code for ops classification."""


class URLNotSupportedError(DownloadError):
    def __init__(self, message: str = "URL not supported") -> None:
        super().__init__("URL_NOT_SUPPORTED", message)


class SSRFBlockedError(DownloadError):
    def __init__(self, message: str = "URL rejected by security policy") -> None:
        super().__init__("SSRF_BLOCKED", message)


class NoRangesError(DownloadError):
    def __init__(self, message: str = "Server does not support range requests") -> None:
        super().__init__("NO_RANGES", message)


class HTTPStatusError(DownloadError):
    def __init__(self, status: int, message: str = "") -> None:
        self.status = status
        super().__init__(f"HTTP_{status}", message or f"HTTP {status}")
