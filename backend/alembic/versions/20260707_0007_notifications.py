"""notifications subsystem

Revision ID: 20260707_0007
Revises: 20260707_0006
Create Date: 2026-07-07
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260707_0007"
down_revision: str | None = "20260707_0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _add_contact_verification(table: str) -> None:
    op.add_column(
        table,
        sa.Column(
            "email_verified",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(table, sa.Column("phone_e164", sa.String(length=20), nullable=True))
    op.add_column(
        table,
        sa.Column(
            "phone_verified",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def upgrade() -> None:
    # --- contact verification columns ---
    _add_contact_verification("users")
    _add_contact_verification("customer_contacts")
    # Backfill: treat existing (synthetic) email contacts as verified so the demo
    # can deliver email notifications. Phones remain unverified (SMS opt-in gated).
    op.execute("UPDATE users SET email_verified = true")
    op.execute(
        "UPDATE customer_contacts SET email_verified = true WHERE email IS NOT NULL"
    )

    # --- transactional outbox ---
    op.create_table(
        "notification_outbox",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("event_type", sa.String(length=80), nullable=False),
        sa.Column("aggregate_type", sa.String(length=80), nullable=False),
        sa.Column("aggregate_id", sa.String(length=36), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("dedupe_key", sa.String(length=200), nullable=True, unique=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_notification_outbox_event_type", "notification_outbox", ["event_type"]
    )
    op.create_index(
        "ix_notification_outbox_aggregate_id", "notification_outbox", ["aggregate_id"]
    )
    op.create_index(
        "ix_notification_outbox_processed_at", "notification_outbox", ["processed_at"]
    )

    # --- notifications ---
    op.create_table(
        "notifications",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("legacy_system", sa.String(length=80), nullable=True),
        sa.Column("legacy_table", sa.String(length=80), nullable=True),
        sa.Column("legacy_id", sa.String(length=120), nullable=True),
        sa.Column("legacy_payload", sa.JSON(), nullable=True),
        sa.Column("event_ref", sa.String(length=120), nullable=False),
        sa.Column("category", sa.String(length=60), nullable=False),
        sa.Column("tier", sa.String(length=20), nullable=False),
        sa.Column("recipient_type", sa.String(length=30), nullable=False),
        sa.Column("recipient_id", sa.String(length=36), nullable=False),
        sa.Column("recipient_address", sa.String(length=320), nullable=True),
        sa.Column("channel", sa.String(length=20), nullable=False),
        sa.Column("template_key", sa.String(length=120), nullable=False),
        sa.Column("template_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("subject", sa.String(length=320), nullable=True),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column("body_html", sa.Text(), nullable=True),
        sa.Column(
            "status", sa.String(length=20), nullable=False, server_default="PENDING"
        ),
        sa.Column("provider_message_id", sa.String(length=200), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("idempotency_key", sa.String(length=64), nullable=False),
        sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("customer_id", sa.String(length=36), nullable=True),
        sa.Column("asset_id", sa.String(length=36), nullable=True),
        sa.UniqueConstraint("idempotency_key", name="uq_notification_idempotency_key"),
    )
    op.create_index("ix_notifications_event_ref", "notifications", ["event_ref"])
    op.create_index("ix_notifications_category", "notifications", ["category"])
    op.create_index("ix_notifications_recipient_id", "notifications", ["recipient_id"])
    op.create_index("ix_notifications_status", "notifications", ["status"])
    op.create_index("ix_notifications_customer_id", "notifications", ["customer_id"])
    op.create_index("ix_notifications_asset_id", "notifications", ["asset_id"])

    # --- preferences ---
    op.create_table(
        "notification_preferences",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("party_type", sa.String(length=30), nullable=False),
        sa.Column("party_id", sa.String(length=36), nullable=False),
        sa.Column("category", sa.String(length=60), nullable=False),
        sa.Column("channel", sa.String(length=20), nullable=False),
        sa.Column("opted_in", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "party_type", "party_id", "category", "channel", name="uq_notification_pref"
        ),
    )
    op.create_index(
        "ix_notification_preferences_party_id",
        "notification_preferences",
        ["party_id"],
    )

    # --- templates ---
    op.create_table(
        "notification_templates",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("key", sa.String(length=120), nullable=False),
        sa.Column("channel", sa.String(length=20), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("locale", sa.String(length=10), nullable=False, server_default="en"),
        sa.Column("subject", sa.String(length=320), nullable=True),
        sa.Column("body_text", sa.Text(), nullable=False),
        sa.Column("body_html", sa.Text(), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "key", "channel", "locale", "version", name="uq_notification_template"
        ),
    )
    op.create_index(
        "ix_notification_templates_key", "notification_templates", ["key"]
    )

    # --- phone verifications ---
    op.create_table(
        "phone_verifications",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("party_type", sa.String(length=30), nullable=False),
        sa.Column("party_id", sa.String(length=36), nullable=False),
        sa.Column("phone_e164", sa.String(length=20), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_phone_verifications_party_id", "phone_verifications", ["party_id"]
    )


def downgrade() -> None:
    op.drop_table("phone_verifications")
    op.drop_index("ix_notification_templates_key", table_name="notification_templates")
    op.drop_table("notification_templates")
    op.drop_index(
        "ix_notification_preferences_party_id",
        table_name="notification_preferences",
    )
    op.drop_table("notification_preferences")
    for idx in (
        "ix_notifications_asset_id",
        "ix_notifications_customer_id",
        "ix_notifications_status",
        "ix_notifications_recipient_id",
        "ix_notifications_category",
        "ix_notifications_event_ref",
    ):
        op.drop_index(idx, table_name="notifications")
    op.drop_table("notifications")
    for idx in (
        "ix_notification_outbox_processed_at",
        "ix_notification_outbox_aggregate_id",
        "ix_notification_outbox_event_type",
    ):
        op.drop_index(idx, table_name="notification_outbox")
    op.drop_table("notification_outbox")
    for table in ("customer_contacts", "users"):
        op.drop_column(table, "phone_verified")
        op.drop_column(table, "phone_e164")
        op.drop_column(table, "email_verified")
