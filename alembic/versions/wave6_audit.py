"""Wave 6 audit fixes: items.media_url + (source, source_id) uniqueness.

Idempotent: inspects the live schema before adding anything, so it can be
re-run against dev databases that drifted via create_all (AXIOM §22.1).
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "wave6_audit"
down_revision = "wave5_conversation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    if "items" in inspector.get_table_names():
        columns = {c["name"] for c in inspector.get_columns("items")}
        if "media_url" not in columns:
            op.add_column("items", sa.Column("media_url", sa.Text(), nullable=True))
        indexes = {ix["name"] for ix in inspector.get_indexes("items")}
        if "uq_items_source_source_id" not in indexes:
            # dedupe before enforcing (legacy in-memory dedupe may have drifted)
            op.execute(
                "DELETE FROM items a USING items b "
                "WHERE a.source = b.source AND a.source_id = b.source_id AND a.id > b.id"
            )
            op.create_unique_constraint(
                "uq_items_source_source_id", "items", ["source", "source_id"]
            )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "items" in inspector.get_table_names():
        constraints = {c["name"] for c in inspector.get_unique_constraints("items")}
        if "uq_items_source_source_id" in constraints:
            op.drop_constraint("uq_items_source_source_id", "items", type_="unique")
        columns = {c["name"] for c in inspector.get_columns("items")}
        if "media_url" in columns:
            op.drop_column("items", "media_url")
