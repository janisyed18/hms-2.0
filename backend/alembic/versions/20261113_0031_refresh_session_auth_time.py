"""Record when each browser session last presented its credentials.

Additive and nullable. The refresh rotation copies it forward unchanged, so an
access token's ``auth_time`` reflects the sign-in (or step-up), not the refresh.
Existing rows stay NULL, which the recent-sign-in guard treats as "never": a
sensitive action asks the user to confirm their password once.
"""

import sqlalchemy as sa

from alembic import op

revision: str = "20261113_0031"
down_revision: str | None = "20261113_0030"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "browser_refresh_sessions",
        sa.Column("auth_time", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("browser_refresh_sessions", "auth_time")
