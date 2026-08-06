"""wave8_ai_registry: AI 底座 v2.0 注册表（providers/models/calls）。

新增三张表：ai_providers（多 Provider 并存）、ai_models（模型库）、
ai_calls（调用链/用量追踪）。全部增量，无破坏。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave8_ai_registry"
down_revision = "wave7d_output_dirs"


def upgrade() -> None:
    op.create_table(
        "ai_providers",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("template", sa.String(64), server_default="custom", nullable=False),
        sa.Column("protocol", sa.String(32), server_default="openai_compat", nullable=False),
        sa.Column("base_url", sa.String(255), server_default="", nullable=False),
        sa.Column("encrypted_keys", sa.Text, server_default="", nullable=False),
        sa.Column("enabled", sa.Boolean, server_default=sa.true(), nullable=False),
        sa.Column("sort_order", sa.Integer, server_default="0", nullable=False),
    )
    op.create_index("ix_ai_providers_key", "ai_providers", ["key"], unique=True)

    op.create_table(
        "ai_models",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("provider_id", sa.Uuid(), sa.ForeignKey("ai_providers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("key", sa.String(120), nullable=False),
        sa.Column("name", sa.String(120), server_default="", nullable=False),
        sa.Column("capability", sa.String(32), server_default="chat", nullable=False),
        sa.Column("context_window", sa.Integer(), nullable=True),
        sa.Column("enabled", sa.Boolean, server_default=sa.true(), nullable=False),
        sa.Column("sort_order", sa.Integer, server_default="0", nullable=False),
    )
    op.create_index("ix_ai_models_provider_id", "ai_models", ["provider_id"])

    op.create_table(
        "ai_calls",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("task_id", sa.String(64), nullable=True),
        sa.Column("caller", sa.String(64), server_default="", nullable=False),
        sa.Column("provider_key", sa.String(64), server_default="", nullable=False),
        sa.Column("model_key", sa.String(120), server_default="", nullable=False),
        sa.Column("role", sa.String(32), server_default="", nullable=False),
        sa.Column("operation", sa.String(32), server_default="", nullable=False),
        sa.Column("duration_ms", sa.Integer, server_default="0", nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), nullable=True),
        sa.Column("completion_tokens", sa.Integer(), nullable=True),
        sa.Column("cost_estimate", sa.Float(), nullable=True),
        sa.Column("status", sa.String(16), server_default="ok", nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("result_summary", sa.Text(), nullable=True),
        sa.Column("meta_json", sa.JSON(), nullable=True),
    )
    op.create_index("ix_ai_calls_task_id", "ai_calls", ["task_id"])


def downgrade() -> None:
    op.drop_table("ai_calls")
    op.drop_table("ai_models")
    op.drop_table("ai_providers")
