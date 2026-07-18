"""add asset profile fields

Revision ID: 20260718_0013
Revises: 20260718_0012
Create Date: 2026-07-18
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260718_0013"
down_revision: str | None = "20260718_0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "assets", sa.Column("asset_name", sa.String(length=200), nullable=True)
    )
    op.add_column(
        "assets",
        sa.Column("purchase_order_number", sa.String(length=120), nullable=True),
    )
    op.add_column("assets", sa.Column("installation_date", sa.Date(), nullable=True))
    op.add_column("assets", sa.Column("grave_date", sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column("assets", "grave_date")
    op.drop_column("assets", "installation_date")
    op.drop_column("assets", "purchase_order_number")
    op.drop_column("assets", "asset_name")
