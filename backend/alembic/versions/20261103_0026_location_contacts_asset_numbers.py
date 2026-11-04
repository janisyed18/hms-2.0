"""add location contacts, location notes and an asset number allocator"""

from collections.abc import Sequence
from uuid import uuid4

import sqlalchemy as sa

from alembic import op

revision: str = "20261103_0026"
down_revision: str | None = "20261102_0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column("customer_locations", sa.Column("notes", sa.Text(), nullable=True))
    op.create_table(
        "customer_location_contacts",
        sa.Column("location_id", sa.String(36), nullable=False),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("role", sa.String(120), nullable=True),
        sa.Column("phone", sa.String(80), nullable=True),
        sa.Column("email", sa.String(320), nullable=True),
        sa.Column("id", sa.String(36), primary_key=True, nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("legacy_system", sa.String(80), nullable=True),
        sa.Column("legacy_table", sa.String(80), nullable=True),
        sa.Column("legacy_id", sa.String(120), nullable=True),
        sa.Column("legacy_payload", sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(["location_id"], ["customer_locations.id"]),
    )
    op.create_index(
        "ix_customer_location_contacts_location_id",
        "customer_location_contacts",
        ["location_id"],
    )
    op.create_table(
        "asset_number_counters",
        sa.Column("id", sa.BigInteger(), primary_key=True, nullable=False),
        sa.Column("next_number", sa.BigInteger(), nullable=False),
    )
    bind = op.get_bind()
    numeric_values = bind.execute(sa.text("SELECT asset_number FROM assets")).scalars()
    numeric_max = max(
        (int(value) for value in numeric_values if value and value.isdecimal()),
        default=0,
    )
    bind.execute(
        sa.text(
            "INSERT INTO asset_number_counters (id, next_number) VALUES (1, :next)"
        ),
        {"next": int(numeric_max) + 1},
    )
    locations = bind.execute(
        sa.text(
            """SELECT id, site_contact_name, site_contact_mobile, site_contact_email
            FROM customer_locations
            WHERE site_contact_name IS NOT NULL AND TRIM(site_contact_name) <> ''"""
        )
    )
    for location in locations:
        bind.execute(
            sa.text(
                """INSERT INTO customer_location_contacts
                (id, location_id, name, phone, email)
                VALUES (:id, :location_id, :name, :phone, :email)"""
            ),
            {
                "id": str(uuid4()),
                "location_id": location.id,
                "name": location.site_contact_name,
                "phone": location.site_contact_mobile,
                "email": location.site_contact_email,
            },
        )


def downgrade() -> None:
    op.drop_index(
        "ix_customer_location_contacts_location_id",
        table_name="customer_location_contacts",
    )
    op.drop_table("customer_location_contacts")
    op.drop_table("asset_number_counters")
    op.drop_column("customer_locations", "notes")
