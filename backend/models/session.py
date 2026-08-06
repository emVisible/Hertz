"""Convenience async session factory for service-layer database access."""

from backend.database import async_session_factory as session_factory

__all__ = ["session_factory"]
