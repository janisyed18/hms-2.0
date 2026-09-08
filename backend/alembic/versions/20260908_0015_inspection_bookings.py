"""add inspection bookings

Revision ID: 20260908_0015
Revises: 20260908_0014
Create Date: 2026-09-08
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260908_0015"
down_revision: str | None = "20260908_0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def syncable_columns() -> list[sa.Column[object]]:
    return [
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("legacy_system", sa.String(length=80), nullable=True),
        sa.Column("legacy_table", sa.String(length=80), nullable=True),
        sa.Column("legacy_id", sa.String(length=120), nullable=True),
        sa.Column("legacy_payload", sa.JSON(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    ]


def upgrade() -> None:
    op.create_table(
        "inspection_bookings",
        sa.Column("customer_id", sa.String(length=36), nullable=False),
        sa.Column("location_id", sa.String(length=36), nullable=False),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("additional_information", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=40), nullable=False),
        sa.Column("requested_by_user_id", sa.String(length=36), nullable=False),
        sa.Column("reviewed_by_user_id", sa.String(length=36), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rejection_reason", sa.Text(), nullable=True),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
        sa.ForeignKeyConstraint(["location_id"], ["customer_locations.id"]),
    )
    op.create_index(
        "ix_inspection_bookings_customer_id", "inspection_bookings", ["customer_id"]
    )
    op.create_index(
        "ix_inspection_bookings_location_id", "inspection_bookings", ["location_id"]
    )

    op.create_table(
        "inspection_booking_assets",
        sa.Column("booking_id", sa.String(length=36), nullable=False),
        sa.Column("asset_id", sa.String(length=36), nullable=False),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"]),
        sa.ForeignKeyConstraint(["booking_id"], ["inspection_bookings.id"]),
        sa.UniqueConstraint(
            "booking_id", "asset_id", name="uq_inspection_booking_asset"
        ),
    )
    op.create_index(
        "ix_inspection_booking_assets_booking_id",
        "inspection_booking_assets",
        ["booking_id"],
    )
    op.create_index(
        "ix_inspection_booking_assets_asset_id",
        "inspection_booking_assets",
        ["asset_id"],
    )

    with op.batch_alter_table("inspections") as batch_op:
        batch_op.add_column(
            sa.Column("booking_id", sa.String(length=36), nullable=True)
        )
        batch_op.alter_column(
            "inspector_user_id", existing_type=sa.String(length=36), nullable=True
        )
        batch_op.create_foreign_key(
            "fk_inspections_booking_id",
            "inspection_bookings",
            ["booking_id"],
            ["id"],
        )
        batch_op.create_index("ix_inspections_booking_id", ["booking_id"])


def downgrade() -> None:
    with op.batch_alter_table("inspections") as batch_op:
        batch_op.drop_index("ix_inspections_booking_id")
        batch_op.drop_constraint("fk_inspections_booking_id", type_="foreignkey")
        batch_op.alter_column(
            "inspector_user_id", existing_type=sa.String(length=36), nullable=False
        )
        batch_op.drop_column("booking_id")

    op.drop_index(
        "ix_inspection_booking_assets_asset_id", table_name="inspection_booking_assets"
    )
    op.drop_index(
        "ix_inspection_booking_assets_booking_id",
        table_name="inspection_booking_assets",
    )
    op.drop_table("inspection_booking_assets")
    op.drop_index(
        "ix_inspection_bookings_location_id", table_name="inspection_bookings"
    )
    op.drop_index(
        "ix_inspection_bookings_customer_id", table_name="inspection_bookings"
    )
    op.drop_table("inspection_bookings")
