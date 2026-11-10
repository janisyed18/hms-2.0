"""Pin archived evidence to an S3 object version and record its retention.

Additive: new nullable columns on the evidence rows (a null version means the
evidence was written by the local/test store, which has no versions), and a list of
protected objects abandoned by a failed deletion so they can be reconciled later.
"""

import sqlalchemy as sa

from alembic import op

revision: str = "20261110_0029"
down_revision: str | None = "20261110_0028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "history_evidence_objects",
        sa.Column("history_version_id", sa.String(length=1024), nullable=True),
    )
    op.add_column(
        "history_evidence_objects",
        sa.Column("retention_mode", sa.String(length=20), nullable=True),
    )
    op.add_column(
        "history_evidence_objects",
        sa.Column("retain_until", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "history_customer_deletions",
        sa.Column(
            "orphaned_evidence", sa.JSON(), nullable=False, server_default="[]"
        ),
    )


def downgrade() -> None:
    op.drop_column("history_customer_deletions", "orphaned_evidence")
    op.drop_column("history_evidence_objects", "retain_until")
    op.drop_column("history_evidence_objects", "retention_mode")
    op.drop_column("history_evidence_objects", "history_version_id")
