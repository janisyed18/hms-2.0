"""move site access requirements from customers to customer locations

Revision ID: 20261009_0017
Revises: 20260915_0016
Create Date: 2026-10-09
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261009_0017"
down_revision: str | None = "20260915_0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("customer_locations") as batch_op:
        batch_op.add_column(
            sa.Column(
                "ppe_requirements",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'[]'"),
            )
        )
        batch_op.add_column(
            sa.Column(
                "additional_requirements",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'[]'"),
            )
        )

    bind = op.get_bind()
    customers = sa.table(
        "customers",
        sa.column("id", sa.String()),
        sa.column("ppe_requirements", sa.JSON()),
        sa.column("additional_requirements", sa.JSON()),
    )
    locations = sa.table(
        "customer_locations",
        sa.column("customer_id", sa.String()),
        sa.column("ppe_requirements", sa.JSON()),
        sa.column("additional_requirements", sa.JSON()),
    )
    for row in bind.execute(
        sa.select(
            customers.c.id,
            customers.c.ppe_requirements,
            customers.c.additional_requirements,
        )
    ).mappings():
        bind.execute(
            locations.update()
            .where(locations.c.customer_id == row["id"])
            .values(
                ppe_requirements=row["ppe_requirements"] or [],
                additional_requirements=row["additional_requirements"] or [],
            )
        )

    with op.batch_alter_table("customers") as batch_op:
        batch_op.drop_column("additional_requirements")
        batch_op.drop_column("ppe_requirements")


def downgrade() -> None:
    # shortcut: distinct location requirements cannot be represented on a customer,
    # upgrade again to restore location-level requirements.
    with op.batch_alter_table("customers") as batch_op:
        batch_op.add_column(
            sa.Column(
                "ppe_requirements",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'[]'"),
            )
        )
        batch_op.add_column(
            sa.Column(
                "additional_requirements",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'[]'"),
            )
        )

    with op.batch_alter_table("customer_locations") as batch_op:
        batch_op.drop_column("additional_requirements")
        batch_op.drop_column("ppe_requirements")
