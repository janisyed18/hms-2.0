"""customer archive: a reversible lifecycle step distinct from delete

``archived_at`` marks a customer as archived: it and its history are kept but it
is excluded from new operational work and selectors. It is nullable and additive,
so every existing customer stays active as it is. Delete remains the separate
``deleted_at`` logical delete.

Revision ID: 20261102_0025
Revises: 20261026_0024
Create Date: 2026-11-02
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261102_0025"
down_revision: str | None = "20261026_0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "customers",
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    with op.batch_alter_table("customers") as batch:
        batch.drop_column("archived_at")
