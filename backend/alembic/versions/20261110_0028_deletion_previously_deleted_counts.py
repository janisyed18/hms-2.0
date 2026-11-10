"""Record how many archived rows were already soft-deleted before the customer was.

Additive on purpose: 20261110_0027 may already be applied somewhere, so this
column is added in its own revision instead of editing that one.
"""

import sqlalchemy as sa

from alembic import op

revision: str = "20261110_0028"
down_revision: str | None = "20261110_0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "history_customer_deletions",
        sa.Column(
            "previously_deleted_counts",
            sa.JSON(),
            nullable=False,
            server_default="{}",
        ),
    )


def downgrade() -> None:
    op.drop_column("history_customer_deletions", "previously_deleted_counts")
