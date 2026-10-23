"""index inspection bookings by scheduled time

The Staff scheduling calendar reads bookings by a bounded time range. Without an
index on ``scheduled_at`` PostgreSQL scans the whole table for every calendar view
(about 42 ms and 2,700 buffers at 150,000 rows, against about 2 ms and 29 buffers
with the index and the range lower bound the query adds).

Revision ID: 20261023_0023
Revises: 20261022_0022
Create Date: 2026-10-23
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20261023_0023"
down_revision: str | None = "20261022_0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_index(
        "ix_inspection_bookings_scheduled_at",
        "inspection_bookings",
        ["scheduled_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_inspection_bookings_scheduled_at", table_name="inspection_bookings"
    )
