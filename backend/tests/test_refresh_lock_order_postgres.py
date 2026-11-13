"""Refresh and a credential change must take locks in the same order (user, session).

A credential change locks the user row and then revokes the user's refresh sessions.
A refresh that locked the session row first and the user second could wait on the
user while the change waits on the session: a deadlock. The interleaving is forced
here, so a regression shows up as a PostgreSQL deadlock rather than as flakiness.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.core.config import settings
from hms_backend.app.core.session_tokens import generate_opaque_token
from hms_backend.app.models import foundation  # noqa: F401 - register AuditEvent
from hms_backend.app.modules.assets import models as _assets  # noqa: F401
from hms_backend.app.modules.certificates import models as _certs  # noqa: F401
from hms_backend.app.modules.customers import models as _customers  # noqa: F401
from hms_backend.app.modules.identity.browser_auth import (
    BrowserAuthError,
    BrowserAuthService,
)
from hms_backend.app.modules.identity.credentials import bump_credential_version
from hms_backend.app.modules.identity.models import BrowserRefreshSession, User
from hms_backend.app.modules.inspections import models as _insp  # noqa: F401
from hms_backend.app.modules.notifications import models as _notif  # noqa: F401
from hms_backend.app.modules.products import models as _products  # noqa: F401
from hms_backend.app.modules.reference import models as _reference  # noqa: F401
from hms_backend.app.modules.scheduling import models as _sched  # noqa: F401

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)
Factory = async_sessionmaker[AsyncSession]


@pytest.fixture(autouse=True)
def _config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "auth_bearer_hmac_secret", "lock-order-secret")


@pytest_asyncio.fixture
async def factory() -> AsyncIterator[Factory]:
    assert POSTGRES_URL is not None
    database_name = make_url(POSTGRES_URL).database
    if database_name is None or not database_name.endswith("_test"):
        raise ValueError("These tests require a database name ending in _test")
    engine = create_async_engine(POSTGRES_URL, pool_size=8)
    try:
        async with engine.connect() as connection:
            version = await connection.scalar(
                text("SELECT version_num FROM alembic_version")
            )
            head = ScriptDirectory.from_config(Config("alembic.ini")).get_current_head()
            assert version == head, "Migrate the test database first"
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


async def _account(factory: Factory) -> tuple[str, str]:
    """A user with one live refresh session; returns (user id, raw token)."""
    tag = uuid4().hex[:12]
    token = generate_opaque_token()
    now = datetime.now(UTC)
    async with factory() as session, session.begin():
        user = User(
            oidc_subject=f"lock-{tag}",
            email=f"lock-{tag}@example.test",
            role="HMS_ADMIN",
        )
        session.add(user)
        await session.flush()
        session.add(
            BrowserRefreshSession(
                user_id=user.id,
                family_id=str(uuid4()),
                token_hash=token.digest,
                expires_at=now + timedelta(days=30),
                idle_expires_at=now + timedelta(hours=8),
                auth_time=now,
            )
        )
        return user.id, token.raw


async def _wait_until_someone_is_blocked(factory: Factory) -> None:
    """Poll PostgreSQL until a backend is waiting on a lock held by another."""
    async with factory() as session:
        for _ in range(100):
            waiting = await session.scalar(
                text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE wait_event_type = 'Lock' AND datname = current_database()"
                )
            )
            if waiting:
                return
            await asyncio.sleep(0.05)
    raise AssertionError("the refresh never blocked on the credential change")


@pytest.mark.asyncio
async def test_a_credential_change_and_a_refresh_cannot_deadlock(
    factory: Factory,
) -> None:
    user_id, raw = await _account(factory)
    locked, finish = asyncio.Event(), asyncio.Event()

    async def credential_change() -> None:
        async with factory() as session:
            user = await session.get(User, user_id)
            assert user is not None
            await bump_credential_version(session, user)  # takes the user row lock
            locked.set()
            await finish.wait()  # the refresh arrives while the user is locked
            await BrowserAuthService().revoke_all_sessions(session, user_id)
            await session.commit()

    async def refresh() -> BrowserAuthError | None:
        async with factory() as session:
            try:
                await BrowserAuthService().refresh(session, refresh_token=raw)
            except BrowserAuthError as exc:
                await session.commit()
                return exc
            await session.commit()
            return None

    change = asyncio.create_task(credential_change())
    await locked.wait()
    refreshing = asyncio.create_task(refresh())
    await _wait_until_someone_is_blocked(factory)
    finish.set()

    # A deadlock would surface as a PostgreSQL error from one side (or a hang).
    outcome = await asyncio.wait_for(refreshing, timeout=15)
    await asyncio.wait_for(change, timeout=15)

    assert isinstance(outcome, BrowserAuthError)  # the session was revoked meanwhile
    async with factory() as session:
        live = (
            await session.scalars(
                select(BrowserRefreshSession).where(
                    BrowserRefreshSession.user_id == user_id,
                    BrowserRefreshSession.revoked_at.is_(None),
                )
            )
        ).all()
    assert live == []
