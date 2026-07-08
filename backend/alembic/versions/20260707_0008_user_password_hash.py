"""user password hash (Argon2 local login)

Revision ID: 20260707_0008
Revises: 20260707_0007
Create Date: 2026-07-07
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260707_0008"
down_revision: str | None = "20260707_0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users", sa.Column("password_hash", sa.String(length=200), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("users", "password_hash")
