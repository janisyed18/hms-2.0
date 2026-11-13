"""Give each user a credential version that access tokens and sign-in challenges
are checked against.

Additive: a non-null integer column defaulting to 0 on users, and the same on
browser_auth_challenges (the version the user had when the challenge was issued).
Access tokens issued before this change carry no version and count as 0, so every
existing session stays valid until the user's credentials next change.
"""

import sqlalchemy as sa

from alembic import op

revision: str = "20261113_0030"
down_revision: str | None = "20261110_0029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "credential_version",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


    op.add_column(
        "browser_auth_challenges",
        sa.Column(
            "credential_version",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    op.drop_column("browser_auth_challenges", "credential_version")
    op.drop_column("users", "credential_version")
