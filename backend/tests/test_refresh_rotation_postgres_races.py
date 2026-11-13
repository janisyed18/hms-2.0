"""Concurrent refresh-token rotation on a dedicated, migrated PostgreSQL database."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from uuid import uuid4

import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.core.config import settings
from hms_backend.app.core.session_tokens import (
    digest_opaque_token,
    generate_opaque_token,
)
from hms_backend.app.models import foundation  # noqa: F401 - register AuditEvent
from hms_backend.app.modules.assets import models as _assets  # noqa: F401
from hms_backend.app.modules.certificates import models as _certs  # noqa: F401
from hms_backend.app.modules.customers import models as _customers  # noqa: F401
from hms_backend.app.modules.identity.browser_auth import (
    BrowserAuthError,
    BrowserAuthService,
    RefreshResult,
)
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


@pytest.fixture(autouse=True)
def _config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "auth_bearer_hmac_secret", "race-test-secret")


@pytest_asyncio.fixture
async def database() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert POSTGRES_URL is not None
    if not POSTGRES_URL.startswith("postgresql+asyncpg://"):
        raise ValueError("Race tests require a dedicated async PostgreSQL database")
    database_name = make_url(POSTGRES_URL).database
    if database_name is None or not database_name.endswith("_test"):
        raise ValueError("Race tests require a database name ending in _test")
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


async def _signed_in_family(
    database: async_sessionmaker[AsyncSession],
) -> tuple[str, str]:
    """A user with one live refresh session; returns (raw token, family id)."""
    token = generate_opaque_token()
    suffix = uuid4().hex[:12]
    now = datetime.now(UTC)
    ttl = settings.auth_browser_refresh_absolute_ttl_seconds
    async with database() as session, session.begin():
        user = User(
            oidc_subject=f"oidc:{suffix}",
            email=f"{suffix}@example.test",
            role="HMS_ADMIN",
        )
        session.add(user)
        await session.flush()
        row = BrowserRefreshSession(
            user_id=user.id,
            family_id=str(uuid4()),
            token_hash=token.digest,
            expires_at=datetime.fromtimestamp(now.timestamp() + ttl, UTC),
            idle_expires_at=datetime.fromtimestamp(now.timestamp() + 3600, UTC),
        )
        session.add(row)
        await session.flush()
        return token.raw, row.family_id


async def _refresh(
    database: async_sessionmaker[AsyncSession],
    raw: str,
    started: asyncio.Event,
    go: asyncio.Event,
) -> RefreshResult | BrowserAuthError:
    """One request on its own connection, released together with its peers."""
    async with database() as session:
        started.set()
        await go.wait()
        try:
            result = await BrowserAuthService().refresh(session, refresh_token=raw)
            await session.commit()
            return result
        except BrowserAuthError as exc:
            await session.commit()  # the API persists a reuse revocation
            return exc


async def _race(
    database: async_sessionmaker[AsyncSession], raw: str, requests: int
) -> list[RefreshResult | BrowserAuthError]:
    go = asyncio.Event()
    started = [asyncio.Event() for _ in range(requests)]
    tasks = [
        asyncio.create_task(_refresh(database, raw, started[i], go))
        for i in range(requests)
    ]
    for event in started:
        await event.wait()
    go.set()
    return list(await asyncio.gather(*tasks))


async def _family_rows(
    database: async_sessionmaker[AsyncSession], family_id: str
) -> list[BrowserRefreshSession]:
    async with database() as session:
        return list(
            await session.scalars(
                select(BrowserRefreshSession).where(
                    BrowserRefreshSession.family_id == family_id
                )
            )
        )


@pytest.mark.asyncio
async def test_concurrent_refresh_with_one_token_rotates_it_exactly_once(
    database: async_sessionmaker[AsyncSession],
) -> None:
    raw, family_id = await _signed_in_family(database)
    outcomes = await _race(database, raw, requests=6)

    winners = [o for o in outcomes if isinstance(o, RefreshResult)]
    losers = [o for o in outcomes if isinstance(o, BrowserAuthError)]
    assert len(winners) == 1
    assert len(losers) == 5
    rows = await _family_rows(database, family_id)
    # One child was minted, never two, and strict reuse detection then burned the
    # family: no token from this race is still valid.
    assert len(rows) == 2
    assert all(row.revoked_at is not None for row in rows)


@pytest.mark.asyncio
async def test_concurrent_refresh_inside_the_grace_window_leaves_one_live_successor(
    database: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "auth_browser_refresh_reuse_grace_seconds", 30)
    raw, family_id = await _signed_in_family(database)
    outcomes = await _race(database, raw, requests=6)

    assert all(isinstance(o, RefreshResult) for o in outcomes)
    results = [o for o in outcomes if isinstance(o, RefreshResult)]
    rotated = [o for o in results if o.refresh_token is not None]
    graced = [o for o in results if o.refresh_token is None]
    assert len(rotated) == 1  # exactly one request owns the new refresh token
    assert len(graced) == 5  # the others get access tokens only
    rows = await _family_rows(database, family_id)
    assert len(rows) == 2
    live = [row for row in rows if row.revoked_at is None]
    assert len(live) == 1
    assert live[0].token_hash == digest_opaque_token(rotated[0].refresh_token or "")
    # The absolute expiry was inherited, not renewed.
    assert rows[0].expires_at == rows[1].expires_at


@pytest.mark.asyncio
async def test_reuse_after_the_grace_window_burns_the_family_under_concurrency(
    database: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "auth_browser_refresh_reuse_grace_seconds", 1)
    raw, family_id = await _signed_in_family(database)
    first = await _race(database, raw, requests=1)
    assert isinstance(first[0], RefreshResult)

    await asyncio.sleep(1.2)  # the window has closed: this is reuse, not a race
    late = await _race(database, raw, requests=3)

    assert all(isinstance(o, BrowserAuthError) for o in late)
    rows = await _family_rows(database, family_id)
    assert all(row.revoked_at is not None for row in rows)


@pytest.mark.asyncio
async def test_rotation_leaves_no_duplicate_children_across_many_families(
    database: async_sessionmaker[AsyncSession],
) -> None:
    families = [await _signed_in_family(database) for _ in range(4)]
    results = await asyncio.gather(
        *(_race(database, raw, requests=3) for raw, _ in families)
    )
    for (_, family_id), outcomes in zip(families, results, strict=True):
        assert sum(isinstance(o, RefreshResult) for o in outcomes) == 1
        async with database() as session:
            total = await session.scalar(
                select(func.count())
                .select_from(BrowserRefreshSession)
                .where(BrowserRefreshSession.family_id == family_id)
            )
        assert total == 2
