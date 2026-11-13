"""Overlapping credential changes on a real PostgreSQL row lock.

Two transactions that both read credential_version 0 and both write 1 would leave a
token issued after the first change valid after the second. The increment is one
``UPDATE ... RETURNING``, so the changes queue on the row and each gets its own value.
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
from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import _persisted_user_principal
from hms_backend.app.models import foundation  # noqa: F401
from hms_backend.app.modules.assets import models as _assets  # noqa: F401
from hms_backend.app.modules.certificates import models as _certs  # noqa: F401
from hms_backend.app.modules.customers import models as _customers  # noqa: F401
from hms_backend.app.modules.identity.credentials import rotate_credentials
from hms_backend.app.modules.identity.models import (
    BrowserAuthChallenge,
    BrowserRefreshSession,
    User,
)
from hms_backend.app.modules.inspections import models as _inspections  # noqa: F401
from hms_backend.app.modules.notifications import models as _notifications  # noqa: F401
from hms_backend.app.modules.products import models as _products  # noqa: F401
from hms_backend.app.modules.reference import models as _reference  # noqa: F401
from hms_backend.app.modules.scheduling import models as _scheduling  # noqa: F401

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)


@pytest_asyncio.fixture
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert POSTGRES_URL is not None
    if not POSTGRES_URL.startswith("postgresql+asyncpg://"):
        raise ValueError("These tests require a dedicated async PostgreSQL database")
    database_name = make_url(POSTGRES_URL).database
    if database_name is None or not database_name.endswith("_test"):
        raise ValueError("These tests require a database name ending in _test")
    engine = create_async_engine(POSTGRES_URL, pool_size=12)
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


@pytest_asyncio.fixture
async def user_id(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[str]:
    tag = uuid4().hex[:12]
    async with session_factory() as session:
        user = User(
            oidc_subject=f"cv-{tag}", email=f"cv-{tag}@example.com", role="INSPECTOR"
        )
        session.add(user)
        await session.commit()
        created = user.id
    yield created
    async with session_factory() as session:
        row = await session.get(User, created)
        if row is not None:
            await session.delete(row)
            await session.commit()


async def _change(
    factory: async_sessionmaker[AsyncSession], user_id: str, *, hold: float = 0.0
) -> int:
    async with factory() as session:
        user = await session.get(User, user_id)
        assert user is not None
        version = await rotate_credentials(session, user)
        if hold:
            await asyncio.sleep(hold)  # keep the row lock while the other change queues
        await session.commit()
        return version


@pytest.mark.asyncio
async def test_a_second_change_waits_for_the_first_and_gets_its_own_version(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> None:
    first = asyncio.create_task(_change(session_factory, user_id, hold=0.6))
    await asyncio.sleep(0.2)  # the first now holds the row lock
    second = asyncio.create_task(_change(session_factory, user_id))
    await asyncio.sleep(0.2)
    assert not second.done(), "the second change should be queued behind the first"
    versions = sorted([await first, await second])
    assert versions == [1, 2]
    async with session_factory() as session:
        stored = await session.scalar(
            select(User.credential_version).where(User.id == user_id)
        )
    assert stored == 2


@pytest.mark.asyncio
async def test_many_overlapping_changes_never_share_a_version(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> None:
    results = await asyncio.gather(
        *(_change(session_factory, user_id) for _ in range(10))
    )
    assert sorted(results) == list(range(1, 11))


@pytest.mark.asyncio
async def test_a_token_issued_between_two_overlapping_changes_is_refused(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> None:
    async with session_factory() as session:
        subject = await session.scalar(
            select(User.oidc_subject).where(User.id == user_id)
        )
    assert subject is not None
    first = asyncio.create_task(_change(session_factory, user_id, hold=0.4))
    await asyncio.sleep(0.15)
    second = asyncio.create_task(_change(session_factory, user_id))
    assert await first == 1
    # A sign-in finishing between the two changes is issued version 1 ...
    await asyncio.sleep(0.05)
    assert await second == 2
    # ... which the second change has since made stale.
    async with session_factory() as session:
        with pytest.raises(HTTPException) as refused:
            await _persisted_user_principal(
                session, subject, token_credential_version=1, check_credential=True
            )
        assert refused.value.status_code == 401
        current = await _persisted_user_principal(
            session, subject, token_credential_version=2, check_credential=True
        )
        assert current is not None


@pytest.mark.asyncio
async def test_a_change_ends_refresh_sessions_and_open_challenges_on_postgres(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> None:
    async with session_factory() as session:
        session.add(
            BrowserRefreshSession(
                user_id=user_id,
                family_id=uuid4().hex[:32],
                token_hash=uuid4().hex + uuid4().hex[:32],
                expires_at=_later(30),
                idle_expires_at=_later(7),
            )
        )
        session.add(
            BrowserAuthChallenge(
                token_hash=uuid4().hex + uuid4().hex[:32],
                user_id=user_id,
                stage="mfa_required",
                expires_at=_later(0.01),
            )
        )
        await session.commit()
    await _change(session_factory, user_id)
    async with session_factory() as session:
        sessions = (
            await session.scalars(
                select(BrowserRefreshSession).where(
                    BrowserRefreshSession.user_id == user_id
                )
            )
        ).all()
        challenges = (
            await session.scalars(
                select(BrowserAuthChallenge).where(
                    BrowserAuthChallenge.user_id == user_id
                )
            )
        ).all()
    assert sessions and all(row.revoked_at is not None for row in sessions)
    assert challenges and all(row.consumed_at is not None for row in challenges)


def _later(days: float) -> datetime:
    return datetime.now(UTC) + timedelta(days=days)
