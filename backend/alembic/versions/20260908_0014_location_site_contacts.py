"""add location site contacts

Revision ID: 20260908_0014
Revises: 20260718_0013
Create Date: 2026-09-08
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260908_0014"
down_revision: str | None = "20260718_0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "customer_locations",
        sa.Column("site_contact_name", sa.String(length=160), nullable=True),
    )
    op.add_column(
        "customer_locations",
        sa.Column("site_contact_mobile", sa.String(length=80), nullable=True),
    )
    op.add_column(
        "customer_locations",
        sa.Column("site_contact_email", sa.String(length=320), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("customer_locations", "site_contact_email")
    op.drop_column("customer_locations", "site_contact_mobile")
    op.drop_column("customer_locations", "site_contact_name")
