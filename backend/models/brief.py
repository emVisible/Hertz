"""Orchestration domain models: Brief (creative strategy)."""

from sqlalchemy import String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import BaseModel


class Brief(BaseModel):
    __tablename__ = "briefs"

    name: Mapped[str] = mapped_column(String(255))
    # Pure Markdown creative brief — the authoritative creative direction
    content: Mapped[str] = mapped_column(Text, default="")
    platform_id: Mapped[str] = mapped_column(String(64), default="")
    # Structured config: phase params, output params, publishing params
    config_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
