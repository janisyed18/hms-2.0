"""add immutable inspection appointment scheduling

Revision ID: 20261012_0018
Revises: 20261009_0017
Create Date: 2026-10-12
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261012_0018"
down_revision: str | None = "20261009_0017"
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
        "inspection_availability_quotes",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("customer_id", sa.String(length=36), nullable=False),
        sa.Column("location_id", sa.String(length=36), nullable=False),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("candidate_inspector_ids", sa.JSON(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
        sa.ForeignKeyConstraint(["location_id"], ["customer_locations.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_inspection_availability_quotes_customer_id",
        "inspection_availability_quotes",
        ["customer_id"],
    )
    op.create_index(
        "ix_inspection_availability_quotes_location_id",
        "inspection_availability_quotes",
        ["location_id"],
    )

    with op.batch_alter_table("inspection_bookings") as batch_op:
        batch_op.add_column(
            sa.Column("scheduled_end_at", sa.DateTime(timezone=True), nullable=True)
        )
        batch_op.add_column(
            sa.Column("availability_quote_id", sa.String(length=36), nullable=True)
        )
        batch_op.create_foreign_key(
            "fk_inspection_bookings_availability_quote_id",
            "inspection_availability_quotes",
            ["availability_quote_id"],
            ["id"],
        )

    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute(
            "UPDATE inspection_bookings "
            "SET scheduled_end_at = scheduled_at + INTERVAL '1 hour' "
            "WHERE scheduled_end_at IS NULL"
        )
    else:
        op.execute(
            "UPDATE inspection_bookings "
            "SET scheduled_end_at = datetime(scheduled_at, '+1 hour') "
            "WHERE scheduled_end_at IS NULL"
        )

    op.create_table(
        "inspection_appointments",
        sa.Column("booking_id", sa.String(length=36), nullable=False),
        sa.Column("customer_id", sa.String(length=36), nullable=False),
        sa.Column("location_id", sa.String(length=36), nullable=False),
        sa.Column("status", sa.String(length=40), nullable=False),
        sa.Column("current_revision_number", sa.Integer(), nullable=False),
        sa.Column("cancelled_reason", sa.Text(), nullable=True),
        sa.Column("cancelled_by_user_id", sa.String(length=36), nullable=True),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["booking_id"], ["inspection_bookings.id"]),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
        sa.ForeignKeyConstraint(["location_id"], ["customer_locations.id"]),
        sa.UniqueConstraint("booking_id"),
    )
    op.create_index(
        "ix_inspection_appointments_customer_id",
        "inspection_appointments",
        ["customer_id"],
    )
    op.create_index(
        "ix_inspection_appointments_location_id",
        "inspection_appointments",
        ["location_id"],
    )

    op.create_table(
        "inspection_appointment_revisions",
        sa.Column("appointment_id", sa.String(length=36), nullable=False),
        sa.Column("revision_number", sa.Integer(), nullable=False),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("inspector_user_id", sa.String(length=36), nullable=False),
        sa.Column("change_reason", sa.Text(), nullable=True),
        sa.Column("created_by_user_id", sa.String(length=36), nullable=False),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["appointment_id"], ["inspection_appointments.id"]),
        sa.ForeignKeyConstraint(["inspector_user_id"], ["users.id"]),
        sa.UniqueConstraint(
            "appointment_id",
            "revision_number",
            name="uq_inspection_appointment_revision",
        ),
    )
    op.create_index(
        "ix_inspection_appointment_revisions_appointment_id",
        "inspection_appointment_revisions",
        ["appointment_id"],
    )
    op.create_index(
        "ix_inspection_appointment_revisions_inspector_user_id",
        "inspection_appointment_revisions",
        ["inspector_user_id"],
    )

    op.create_table(
        "inspection_resource_allocations",
        sa.Column("revision_id", sa.String(length=36), nullable=False),
        sa.Column("resource_type", sa.String(length=40), nullable=False),
        sa.Column("resource_id", sa.String(length=36), nullable=False),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("state", sa.String(length=40), nullable=False),
        *syncable_columns(),
        sa.ForeignKeyConstraint(
            ["revision_id"], ["inspection_appointment_revisions.id"]
        ),
    )
    op.create_index(
        "ix_inspection_resource_allocations_revision_id",
        "inspection_resource_allocations",
        ["revision_id"],
    )
    op.create_index(
        "ix_inspection_resource_allocations_resource_id",
        "inspection_resource_allocations",
        ["resource_id"],
    )

    op.create_table(
        "inspection_appointment_change_requests",
        sa.Column("booking_id", sa.String(length=36), nullable=False),
        sa.Column("appointment_id", sa.String(length=36), nullable=False),
        sa.Column("availability_quote_id", sa.String(length=36), nullable=False),
        sa.Column("requested_by_user_id", sa.String(length=36), nullable=False),
        sa.Column("proposed_inspector_user_id", sa.String(length=36), nullable=True),
        sa.Column("status", sa.String(length=50), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("emergency", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("reviewed_by_user_id", sa.String(length=36), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["booking_id"], ["inspection_bookings.id"]),
        sa.ForeignKeyConstraint(["appointment_id"], ["inspection_appointments.id"]),
        sa.ForeignKeyConstraint(
            ["availability_quote_id"], ["inspection_availability_quotes.id"]
        ),
    )
    op.create_index(
        "ix_inspection_appointment_change_requests_booking_id",
        "inspection_appointment_change_requests",
        ["booking_id"],
    )
    op.create_index(
        "ix_inspection_appointment_change_requests_appointment_id",
        "inspection_appointment_change_requests",
        ["appointment_id"],
    )

    if bind.dialect.name == "postgresql":
        op.execute("CREATE EXTENSION IF NOT EXISTS btree_gist")
        op.execute(
            "ALTER TABLE inspection_resource_allocations "
            "ADD CONSTRAINT ex_inspection_resource_allocation_overlap "
            "EXCLUDE USING gist ("
            "resource_type WITH =, "
            "resource_id WITH =, "
            "tstzrange(starts_at, ends_at, '[)') WITH &&"
            ") WHERE ("
            "state = 'CONFIRMED' AND deleted_at IS NULL"
            ")"
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute(
            "ALTER TABLE inspection_resource_allocations "
            "DROP CONSTRAINT IF EXISTS ex_inspection_resource_allocation_overlap"
        )

    op.drop_index(
        "ix_inspection_appointment_change_requests_appointment_id",
        table_name="inspection_appointment_change_requests",
    )
    op.drop_index(
        "ix_inspection_appointment_change_requests_booking_id",
        table_name="inspection_appointment_change_requests",
    )
    op.drop_table("inspection_appointment_change_requests")
    op.drop_index(
        "ix_inspection_resource_allocations_resource_id",
        table_name="inspection_resource_allocations",
    )
    op.drop_index(
        "ix_inspection_resource_allocations_revision_id",
        table_name="inspection_resource_allocations",
    )
    op.drop_table("inspection_resource_allocations")
    op.drop_index(
        "ix_inspection_appointment_revisions_inspector_user_id",
        table_name="inspection_appointment_revisions",
    )
    op.drop_index(
        "ix_inspection_appointment_revisions_appointment_id",
        table_name="inspection_appointment_revisions",
    )
    op.drop_table("inspection_appointment_revisions")
    op.drop_index(
        "ix_inspection_appointments_location_id",
        table_name="inspection_appointments",
    )
    op.drop_index(
        "ix_inspection_appointments_customer_id",
        table_name="inspection_appointments",
    )
    op.drop_table("inspection_appointments")

    with op.batch_alter_table("inspection_bookings") as batch_op:
        batch_op.drop_constraint(
            "fk_inspection_bookings_availability_quote_id", type_="foreignkey"
        )
        batch_op.drop_column("availability_quote_id")
        batch_op.drop_column("scheduled_end_at")

    op.drop_index(
        "ix_inspection_availability_quotes_location_id",
        table_name="inspection_availability_quotes",
    )
    op.drop_index(
        "ix_inspection_availability_quotes_customer_id",
        table_name="inspection_availability_quotes",
    )
    op.drop_table("inspection_availability_quotes")
