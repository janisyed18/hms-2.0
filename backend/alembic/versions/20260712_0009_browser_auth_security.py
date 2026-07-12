"""browser authentication security persistence

Revision ID: 20260712_0009
Revises: 20260707_0008
Create Date: 2026-07-12
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260712_0009"
down_revision: str | None = "20260707_0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(
            sa.Column(
                "account_status",
                sa.String(length=20),
                server_default="ACTIVE",
                nullable=False,
            )
        )
        batch_op.add_column(
            sa.Column(
                "must_change_password",
                sa.Boolean(),
                server_default=sa.false(),
                nullable=False,
            )
        )
        batch_op.add_column(
            sa.Column("password_changed_at", sa.DateTime(timezone=True), nullable=True)
        )
        batch_op.add_column(
            sa.Column(
                "mfa_enabled",
                sa.Boolean(),
                server_default=sa.false(),
                nullable=False,
            )
        )
        batch_op.add_column(
            sa.Column("mfa_secret_ciphertext", sa.String(length=1000), nullable=True)
        )
        batch_op.add_column(
            sa.Column("mfa_secret_key_version", sa.Integer(), nullable=True)
        )
        batch_op.add_column(
            sa.Column("mfa_last_accepted_step", sa.Integer(), nullable=True)
        )
        batch_op.add_column(
            sa.Column(
                "failed_password_attempts",
                sa.Integer(),
                server_default="0",
                nullable=False,
            )
        )
        batch_op.add_column(
            sa.Column(
                "failed_mfa_attempts",
                sa.Integer(),
                server_default="0",
                nullable=False,
            )
        )
        batch_op.add_column(
            sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True)
        )
        batch_op.add_column(
            sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True)
        )
        batch_op.create_index("ix_users_email", ["email"], unique=False)

    with op.batch_alter_table("users") as batch_op:
        batch_op.alter_column("account_status", server_default=None)
        batch_op.alter_column("must_change_password", server_default=None)
        batch_op.alter_column("mfa_enabled", server_default=None)
        batch_op.alter_column("failed_password_attempts", server_default=None)
        batch_op.alter_column("failed_mfa_attempts", server_default=None)

    op.create_table(
        "browser_auth_challenges",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("stage", sa.String(length=40), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_index(
        "ix_browser_auth_challenges_token_hash",
        "browser_auth_challenges",
        ["token_hash"],
    )
    op.create_index(
        "ix_browser_auth_challenges_user_id",
        "browser_auth_challenges",
        ["user_id"],
    )

    op.create_table(
        "browser_refresh_sessions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("family_id", sa.String(length=36), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("idle_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("replaced_by_id", sa.String(length=36), nullable=True),
        sa.Column("user_agent", sa.String(length=500), nullable=True),
        sa.Column("ip_address", sa.String(length=45), nullable=True),
        sa.ForeignKeyConstraint(["replaced_by_id"], ["browser_refresh_sessions.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_index(
        "ix_browser_refresh_sessions_family_id",
        "browser_refresh_sessions",
        ["family_id"],
    )
    op.create_index(
        "ix_browser_refresh_sessions_token_hash",
        "browser_refresh_sessions",
        ["token_hash"],
    )
    op.create_index(
        "ix_browser_refresh_sessions_user_revoked",
        "browser_refresh_sessions",
        ["user_id", "revoked_at"],
    )

    op.create_table(
        "mfa_recovery_codes",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("code_digest", sa.String(length=64), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "code_digest", name="uq_mfa_recovery_codes_user_digest"
        ),
    )
    op.create_index(
        "ix_mfa_recovery_codes_user_id", "mfa_recovery_codes", ["user_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_mfa_recovery_codes_user_id", table_name="mfa_recovery_codes")
    op.drop_table("mfa_recovery_codes")

    op.drop_index(
        "ix_browser_refresh_sessions_user_revoked",
        table_name="browser_refresh_sessions",
    )
    op.drop_index(
        "ix_browser_refresh_sessions_token_hash",
        table_name="browser_refresh_sessions",
    )
    op.drop_index(
        "ix_browser_refresh_sessions_family_id",
        table_name="browser_refresh_sessions",
    )
    op.drop_table("browser_refresh_sessions")

    op.drop_index(
        "ix_browser_auth_challenges_user_id", table_name="browser_auth_challenges"
    )
    op.drop_index(
        "ix_browser_auth_challenges_token_hash",
        table_name="browser_auth_challenges",
    )
    op.drop_table("browser_auth_challenges")

    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_index("ix_users_email")
        batch_op.drop_column("last_login_at")
        batch_op.drop_column("locked_until")
        batch_op.drop_column("failed_mfa_attempts")
        batch_op.drop_column("failed_password_attempts")
        batch_op.drop_column("mfa_last_accepted_step")
        batch_op.drop_column("mfa_secret_key_version")
        batch_op.drop_column("mfa_secret_ciphertext")
        batch_op.drop_column("mfa_enabled")
        batch_op.drop_column("password_changed_at")
        batch_op.drop_column("must_change_password")
        batch_op.drop_column("account_status")
