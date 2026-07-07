"""customer and asset notes

Revision ID: 20260707_0005
Revises: 20260706_0004
Create Date: 2026-07-07
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260707_0005"
down_revision: str | None = "20260706_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("customers", sa.Column("notes", sa.Text(), nullable=True))
    op.add_column("assets", sa.Column("notes", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("assets", "notes")
    op.drop_column("customers", "notes")
