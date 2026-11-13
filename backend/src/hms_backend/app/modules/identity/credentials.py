"""Credential changes: one place that ends every session signed in under the old ones.

A password change (self-service, admin reset, reset by link, forced change at
sign-in) must do three things together:

* bump ``users.credential_version`` atomically, so overlapping changes can never
  share a value and a token issued under the old one is refused;
* revoke the user's refresh sessions;
* consume the user's outstanding sign-in challenges, so a half-finished login from
  before the change cannot be completed afterwards.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from hms_backend.app.modules.identity.models import (
    BrowserAuthChallenge,
    BrowserRefreshSession,
    User,
)


async def bump_credential_version(session: AsyncSession, user: User) -> int:
    """Increment the user's credential version in the database and return it.

    The increment is a single ``UPDATE ... RETURNING``: the row lock serialises
    overlapping changes, and each waits for the other's commit before it reads the
    value it increments, so no two changes can produce the same version.
    """
    new_version = await session.scalar(
        update(User)
        .where(User.id == user.id)
        .values(credential_version=User.credential_version + 1)
        .returning(User.credential_version)
        .execution_options(synchronize_session=False)
    )
    if new_version is None:  # the user row is gone
        raise LookupError("User not found")
    # The database already holds this value; do not queue a second write of it.
    set_committed_value(user, "credential_version", new_version)
    return new_version


async def rotate_credentials(
    session: AsyncSession, user: User, *, now: datetime | None = None
) -> int:
    """Bump the version and end every session and unfinished sign-in of the user."""
    moment = now or datetime.now(UTC)
    version = await bump_credential_version(session, user)
    await session.execute(
        update(BrowserRefreshSession)
        .where(
            BrowserRefreshSession.user_id == user.id,
            BrowserRefreshSession.revoked_at.is_(None),
        )
        .values(revoked_at=moment)
    )
    await session.execute(
        update(BrowserAuthChallenge)
        .where(
            BrowserAuthChallenge.user_id == user.id,
            BrowserAuthChallenge.consumed_at.is_(None),
        )
        .values(consumed_at=moment)
    )
    return version
