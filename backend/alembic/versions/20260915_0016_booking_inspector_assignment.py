"""assign an inspector to approved inspection bookings

Revision ID: 20260915_0016
Revises: 20260908_0015
Create Date: 2026-09-15
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260915_0016"
down_revision: str | None = "20260908_0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("inspection_bookings") as batch_op:
        batch_op.add_column(
            sa.Column("inspector_user_id", sa.String(length=36), nullable=True)
        )
        batch_op.create_foreign_key(
            "fk_inspection_bookings_inspector_user_id",
            "users",
            ["inspector_user_id"],
            ["id"],
        )
        batch_op.create_index(
            "ix_inspection_bookings_inspector_user_id", ["inspector_user_id"]
        )


def downgrade() -> None:
    with op.batch_alter_table("inspection_bookings") as batch_op:
        batch_op.drop_index("ix_inspection_bookings_inspector_user_id")
        batch_op.drop_constraint(
            "fk_inspection_bookings_inspector_user_id", type_="foreignkey"
        )
        batch_op.drop_column("inspector_user_id")
