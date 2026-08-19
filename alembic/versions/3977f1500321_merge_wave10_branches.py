"""merge wave10 branches

Revision ID: 3977f1500321
Revises: wave10_item_archive, wave10_publish_queue
Create Date: 2026-08-19 12:58:24.103358

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '3977f1500321'
down_revision: Union[str, None] = ('wave10_item_archive', 'wave10_publish_queue')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
