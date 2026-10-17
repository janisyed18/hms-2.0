"""certificate integrity evidence

Adds the immutable issuance snapshot, stored-PDF digest and signature evidence
used by public verification. All columns are nullable: existing certificates keep
NULLs and are reported LEGACY_UNVERIFIED until reviewed or reissued.

Revision ID: 20261017_0021
Revises: 20261012_0020
Create Date: 2026-10-17
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261017_0021"
down_revision: str | None = "20261012_0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | None = None


def upgrade() -> None:
    with op.batch_alter_table("certificates") as batch_op:
        batch_op.add_column(sa.Column("issuance_facts", sa.JSON(), nullable=True))
        batch_op.add_column(
            sa.Column("pdf_sha256", sa.String(length=64), nullable=True)
        )
        batch_op.add_column(
            sa.Column("signer_common_name", sa.String(length=255), nullable=True)
        )
        batch_op.add_column(
            sa.Column("signed_at", sa.DateTime(timezone=True), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table("certificates") as batch_op:
        batch_op.drop_column("signed_at")
        batch_op.drop_column("signer_common_name")
        batch_op.drop_column("pdf_sha256")
        batch_op.drop_column("issuance_facts")
