"""add location scheduling calendars

Revision ID: 20261012_0019
Revises: 20261012_0018
Create Date: 2026-10-12
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261012_0019"
down_revision: str | None = "20261012_0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("customer_locations") as batch_op:
        batch_op.add_column(
            sa.Column(
                "scheduling_timezone",
                sa.String(length=64),
                nullable=False,
                server_default="UTC",
            )
        )
        batch_op.add_column(
            sa.Column(
                "scheduling_open_time",
                sa.String(length=5),
                nullable=False,
                server_default="08:00",
            )
        )
        batch_op.add_column(
            sa.Column(
                "scheduling_close_time",
                sa.String(length=5),
                nullable=False,
                server_default="17:00",
            )
        )
        batch_op.add_column(
            sa.Column(
                "scheduling_weekdays",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'[0, 1, 2, 3, 4]'"),
            )
        )
        batch_op.add_column(
            sa.Column(
                "scheduling_blackout_dates",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'[]'"),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("customer_locations") as batch_op:
        batch_op.drop_column("scheduling_blackout_dates")
        batch_op.drop_column("scheduling_weekdays")
        batch_op.drop_column("scheduling_close_time")
        batch_op.drop_column("scheduling_open_time")
        batch_op.drop_column("scheduling_timezone")
