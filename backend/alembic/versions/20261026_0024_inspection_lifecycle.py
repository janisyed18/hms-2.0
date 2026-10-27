"""inspection lifecycle: when work started, and why changes are required

An inspection now moves DRAFT -> IN_PROGRESS -> SUBMITTED -> APPROVED, and a rejected
one is reworked through IN_PROGRESS again. ``started_at`` records when work first
began (set once, kept through rework) and ``rejection_reason`` carries the reviewer's
explanation so "Changes required" is never shown without one.

Both columns are nullable and additive: every existing row stays valid as it is.
Nothing is backfilled, because no historical inspection has a known start time or a
stored reason (the reason was only ever sent in the notification).

Revision ID: 20261026_0024
Revises: 20261023_0023
Create Date: 2026-10-26
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261026_0024"
down_revision: str | None = "20261023_0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | None = None


def upgrade() -> None:
    started_at = sa.Column("started_at", sa.DateTime(timezone=True), nullable=True)
    rejection_reason = sa.Column("rejection_reason", sa.Text(), nullable=True)
    op.add_column("inspections", started_at)
    op.add_column("inspections", rejection_reason)


def downgrade() -> None:
    with op.batch_alter_table("inspections") as batch:
        batch.drop_column("rejection_reason")
        batch.drop_column("started_at")
