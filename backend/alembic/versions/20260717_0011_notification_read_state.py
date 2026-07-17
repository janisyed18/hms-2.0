"""persist in-app notification read state

Revision ID: 20260717_0011
Revises: 20260713_0010
Create Date: 2026-07-17
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260717_0011"
down_revision: str | None = "20260713_0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "notifications",
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_notifications_read_at", "notifications", ["read_at"])


def downgrade() -> None:
    op.drop_index("ix_notifications_read_at", table_name="notifications")
    op.drop_column("notifications", "read_at")
