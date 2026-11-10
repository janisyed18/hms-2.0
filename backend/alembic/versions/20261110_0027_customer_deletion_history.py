"""historical archive for customers deleted from active HMS

Four insert-only tables. On PostgreSQL a trigger rejects UPDATE and DELETE so an
archived snapshot cannot be altered through the application or by mistake.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261110_0027"
down_revision: str | None = "20261103_0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | None = None

_TABLES = (
    "history_customer_deletions",
    "history_records",
    "history_relationships",
    "history_evidence_objects",
)


def upgrade() -> None:
    op.create_table(
        "history_customer_deletions",
        sa.Column("id", sa.String(36), primary_key=True, nullable=False),
        sa.Column("deletion_number", sa.String(24), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("customer_id", sa.String(36), nullable=False),
        sa.Column("customer_code", sa.String(40), nullable=False),
        sa.Column("customer_name", sa.String(200), nullable=False),
        sa.Column("customer_version", sa.Integer(), nullable=False),
        sa.Column("actor_id", sa.String(120), nullable=False),
        sa.Column("actor_name", sa.String(320), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("idempotency_key", sa.String(80), nullable=True),
        sa.Column(
            "snapshot_schema_version", sa.Integer(), nullable=False, server_default="1"
        ),
        sa.Column("record_counts", sa.JSON(), nullable=False),
        sa.Column("total_records", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("evidence_files", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("evidence_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("impact_fingerprint", sa.String(64), nullable=False),
        sa.Column("manifest_sha256", sa.String(64), nullable=True),
        sa.Column("retention_until", sa.Date(), nullable=True),
        sa.Column("retention_basis", sa.Text(), nullable=True),
        sa.Column("failure_detail", sa.Text(), nullable=True),
        sa.Column("audit_event_sequence", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("deletion_number"),
        sa.UniqueConstraint("idempotency_key"),
    )
    op.create_index(
        "ix_history_customer_deletions_status", "history_customer_deletions", ["status"]
    )
    op.create_index(
        "ix_history_customer_deletions_customer_id",
        "history_customer_deletions",
        ["customer_id"],
    )
    op.create_index(
        "ix_history_customer_deletions_created_at",
        "history_customer_deletions",
        ["created_at"],
    )

    op.create_table(
        "history_records",
        sa.Column("id", sa.String(36), primary_key=True, nullable=False),
        sa.Column("batch_id", sa.String(36), nullable=False),
        sa.Column("record_type", sa.String(80), nullable=False),
        sa.Column("original_id", sa.String(36), nullable=False),
        sa.Column("original_version", sa.Integer(), nullable=True),
        sa.Column("schema_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("payload_sha256", sa.String(64), nullable=False),
        sa.ForeignKeyConstraint(["batch_id"], ["history_customer_deletions.id"]),
        sa.UniqueConstraint(
            "batch_id", "record_type", "original_id", name="uq_history_record"
        ),
    )
    op.create_index(
        "ix_history_records_batch_type", "history_records", ["batch_id", "record_type"]
    )
    op.create_index(
        "ix_history_records_original_id", "history_records", ["original_id"]
    )

    op.create_table(
        "history_relationships",
        sa.Column("id", sa.String(36), primary_key=True, nullable=False),
        sa.Column("batch_id", sa.String(36), nullable=False),
        sa.Column("child_type", sa.String(80), nullable=False),
        sa.Column("child_id", sa.String(36), nullable=False),
        sa.Column("fk_column", sa.String(80), nullable=False),
        sa.Column("parent_type", sa.String(80), nullable=False),
        sa.Column("parent_id", sa.String(36), nullable=False),
        sa.Column("parent_retained", sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(["batch_id"], ["history_customer_deletions.id"]),
    )
    op.create_index(
        "ix_history_relationships_batch", "history_relationships", ["batch_id"]
    )

    op.create_table(
        "history_evidence_objects",
        sa.Column("id", sa.String(36), primary_key=True, nullable=False),
        sa.Column("batch_id", sa.String(36), nullable=False),
        sa.Column("kind", sa.String(40), nullable=False),
        sa.Column("record_type", sa.String(80), nullable=False),
        sa.Column("original_id", sa.String(36), nullable=False),
        sa.Column("label", sa.String(200), nullable=False),
        sa.Column("source_key", sa.String(500), nullable=False),
        sa.Column("history_key", sa.String(600), nullable=False),
        sa.Column("content_type", sa.String(80), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column(
            "verified_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(["batch_id"], ["history_customer_deletions.id"]),
    )
    op.create_index(
        "ix_history_evidence_batch", "history_evidence_objects", ["batch_id"]
    )

    if op.get_bind().dialect.name == "postgresql":
        op.execute(
            """
            CREATE FUNCTION history_reject_change() RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION
                    'history tables are insert-only (% on %)', TG_OP, TG_TABLE_NAME;
            END;
            $$ LANGUAGE plpgsql
            """
        )
        for table in _TABLES:
            op.execute(
                f"CREATE TRIGGER {table}_insert_only "
                f"BEFORE UPDATE OR DELETE ON {table} "
                "FOR EACH ROW EXECUTE FUNCTION history_reject_change()"
            )


def downgrade() -> None:
    # Dropping the archive destroys retained evidence metadata. The downgrade exists
    # for local development; see docs/design/customer-deletion-history.md first.
    if op.get_bind().dialect.name == "postgresql":
        for table in _TABLES:
            op.execute(f"DROP TRIGGER IF EXISTS {table}_insert_only ON {table}")
        op.execute("DROP FUNCTION IF EXISTS history_reject_change()")
    op.drop_table("history_evidence_objects")
    op.drop_table("history_relationships")
    op.drop_table("history_records")
    op.drop_table("history_customer_deletions")
