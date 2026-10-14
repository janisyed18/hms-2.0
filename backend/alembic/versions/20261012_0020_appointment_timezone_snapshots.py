"""preserve appointment revision timezone intent

Revision ID: 20261012_0020
Revises: 20261012_0019
Create Date: 2026-10-12
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261012_0020"
down_revision: str | None = "20261012_0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | None = None


def upgrade() -> None:
    with op.batch_alter_table("inspection_appointment_revisions") as batch_op:
        batch_op.add_column(
            sa.Column("timezone_id", sa.String(length=64), nullable=True)
        )
        batch_op.add_column(
            sa.Column("local_start_snapshot", sa.String(length=32), nullable=True)
        )
        batch_op.add_column(
            sa.Column("local_end_snapshot", sa.String(length=32), nullable=True)
        )
        batch_op.add_column(
            sa.Column("utc_offset_start", sa.String(length=9), nullable=True)
        )
        batch_op.add_column(
            sa.Column("utc_offset_end", sa.String(length=9), nullable=True)
        )
        batch_op.add_column(
            sa.Column("tzdata_version", sa.String(length=32), nullable=True)
        )

    # Existing revisions were created before local-time scheduling. Preserve their
    # original UTC agreement rather than deriving a value from mutable location data.
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute(
            "UPDATE inspection_appointment_revisions SET "
            "timezone_id = 'UTC', "
            "local_start_snapshot = to_char(starts_at AT TIME ZONE 'UTC', "
            "'YYYY-MM-DD\"T\"HH24:MI:SS'), "
            "local_end_snapshot = to_char(ends_at AT TIME ZONE 'UTC', "
            "'YYYY-MM-DD\"T\"HH24:MI:SS'), "
            "utc_offset_start = '+00:00', utc_offset_end = '+00:00', "
            "tzdata_version = 'legacy-utc'"
        )
    else:
        op.execute(
            "UPDATE inspection_appointment_revisions SET "
            "timezone_id = 'UTC', "
            "local_start_snapshot = substr(starts_at, 1, 19), "
            "local_end_snapshot = substr(ends_at, 1, 19), "
            "utc_offset_start = '+00:00', utc_offset_end = '+00:00', "
            "tzdata_version = 'legacy-utc'"
        )

    with op.batch_alter_table("inspection_appointment_revisions") as batch_op:
        batch_op.alter_column("timezone_id", nullable=False)
        batch_op.alter_column("local_start_snapshot", nullable=False)
        batch_op.alter_column("local_end_snapshot", nullable=False)
        batch_op.alter_column("utc_offset_start", nullable=False)
        batch_op.alter_column("utc_offset_end", nullable=False)
        batch_op.alter_column("tzdata_version", nullable=False)


def downgrade() -> None:
    with op.batch_alter_table("inspection_appointment_revisions") as batch_op:
        batch_op.drop_column("tzdata_version")
        batch_op.drop_column("utc_offset_end")
        batch_op.drop_column("utc_offset_start")
        batch_op.drop_column("local_end_snapshot")
        batch_op.drop_column("local_start_snapshot")
        batch_op.drop_column("timezone_id")
