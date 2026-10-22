"""customer user access

Allows a customer browser user to hold more than one authorized customer scope
without changing the legacy ``users.customer_id`` primary/default scope.

Revision ID: 20261022_0022
Revises: 20261017_0021
Create Date: 2026-10-22
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261022_0022"
down_revision: str | None = "20261017_0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "user_customer_accesses",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("legacy_system", sa.String(length=80), nullable=True),
        sa.Column("legacy_table", sa.String(length=80), nullable=True),
        sa.Column("legacy_id", sa.String(length=120), nullable=True),
        sa.Column("legacy_payload", sa.JSON(), nullable=True),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("customer_id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "customer_id", name="uq_user_customer_access"),
    )
    op.create_index(
        "ix_user_customer_accesses_user_id", "user_customer_accesses", ["user_id"]
    )
    op.create_index(
        "ix_user_customer_accesses_customer_id",
        "user_customer_accesses",
        ["customer_id"],
    )
    op.execute(
        """
        INSERT INTO user_customer_accesses (
            id, version, created_at, updated_at, user_id, customer_id
        )
        SELECT
            id, 1, created_at, updated_at, id, customer_id
        FROM users
        WHERE customer_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_index("ix_user_customer_accesses_customer_id", "user_customer_accesses")
    op.drop_index("ix_user_customer_accesses_user_id", "user_customer_accesses")
    op.drop_table("user_customer_accesses")
