"""asset end fitting and size labels

Revision ID: 20260706_0004
Revises: 20260628_0003
Create Date: 2026-07-06
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260706_0004"
down_revision: str | None = "20260628_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "asset_end_configurations",
        sa.Column("fitting", sa.String(length=160), nullable=True),
    )
    op.add_column(
        "asset_end_configurations",
        sa.Column("size", sa.String(length=80), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("asset_end_configurations", "size")
    op.drop_column("asset_end_configurations", "fitting")
