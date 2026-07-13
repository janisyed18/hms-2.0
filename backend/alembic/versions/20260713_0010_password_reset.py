"""password reset persistence

Revision ID: 20260713_0010
Revises: 20260712_0009
Create Date: 2026-07-13
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260713_0010"
down_revision: str | None = "20260712_0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "password_reset_tokens",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("superseded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("requested_ip", sa.String(length=45), nullable=True),
        sa.Column("requested_user_agent", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_index(
        "ix_password_reset_tokens_user_id",
        "password_reset_tokens",
        ["user_id"],
    )

    op.create_table(
        "password_reset_deliveries",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("reset_id", sa.String(length=36), nullable=False),
        sa.Column("recipient_email", sa.String(length=320), nullable=False),
        sa.Column("ciphertext", sa.Text(), nullable=True),
        sa.Column("key_version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("provider_message_id", sa.String(length=200), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["reset_id"],
            ["password_reset_tokens.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_password_reset_deliveries_reset_id",
        "password_reset_deliveries",
        ["reset_id"],
        unique=True,
    )
    op.create_index(
        "ix_password_reset_deliveries_scheduled_for",
        "password_reset_deliveries",
        ["scheduled_for"],
    )
    op.create_index(
        "ix_password_reset_deliveries_status",
        "password_reset_deliveries",
        ["status"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_password_reset_deliveries_status",
        table_name="password_reset_deliveries",
    )
    op.drop_index(
        "ix_password_reset_deliveries_scheduled_for",
        table_name="password_reset_deliveries",
    )
    op.drop_index(
        "ix_password_reset_deliveries_reset_id",
        table_name="password_reset_deliveries",
    )
    op.drop_table("password_reset_deliveries")

    op.drop_index(
        "ix_password_reset_tokens_user_id",
        table_name="password_reset_tokens",
    )
    op.drop_table("password_reset_tokens")
