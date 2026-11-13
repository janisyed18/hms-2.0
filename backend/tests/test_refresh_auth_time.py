"""A refresh is not a sign-in: it must never move the session's ``auth_time``.

Covers the ordinary rotation and the rotation-grace response, which both mint an access
token and so could otherwise reintroduce a recent-sign-in bypass for step-up actions.
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import event, select, update
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from hms_backend.app.core.config import settings
from hms_backend.app.core.session_tokens import generate_opaque_token
from hms_backend.app.models import foundation  # noqa: F401 - register AuditEvent
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets import models as _assets  # noqa: F401
from hms_backend.app.modules.certificates import models as _certs  # noqa: F401
from hms_backend.app.modules.customers import models as _customers  # noqa: F401
from hms_backend.app.modules.identity.browser_auth import BrowserAuthService
from hms_backend.app.modules.identity.models import BrowserRefreshSession, User
from hms_backend.app.modules.inspections import models as _insp  # noqa: F401
from hms_backend.app.modules.notifications import models as _notif  # noqa: F401
from hms_backend.app.modules.products import models as _products  # noqa: F401
from hms_backend.app.modules.reference import models as _reference  # noqa: F401
from hms_backend.app.modules.scheduling import models as _sched  # noqa: F401

SIGNED_IN = datetime(2026, 7, 12, 8, 0, 0, tzinfo=UTC)
LATER = SIGNED_IN + timedelta(hours=3)


@pytest.fixture(autouse=True)
def _config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "auth_bearer_hmac_secret", "unit-test-secret")


@pytest_asyncio.fixture
async def session() -> AsyncGenerator[AsyncSession]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")

    @event.listens_for(engine.sync_engine, "connect")
    def _fk(dbapi_connection, _record) -> None:  # type: ignore[no-untyped-def]
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with AsyncSession(engine, expire_on_commit=False) as test_session:
        yield test_session
    await engine.dispose()


async def _sign_in(session: AsyncSession) -> str:
    """A user with one live refresh session whose credentials were shown."""
    user = User(oidc_subject="u", email="u@example.com", role="HMS_ADMIN")
    session.add(user)
    await session.flush()
    token = generate_opaque_token()
    session.add(
        BrowserRefreshSession(
            user_id=user.id,
            family_id="family-1",
            token_hash=token.digest,
            expires_at=SIGNED_IN + timedelta(days=30),
            idle_expires_at=SIGNED_IN + timedelta(hours=8),
            auth_time=SIGNED_IN,
        )
    )
    await session.flush()
    return token.raw


def _auth_time(access_token: str) -> int:
    payload = access_token.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    return int(claims["auth_time"])


def _service(now: datetime) -> BrowserAuthService:
    return BrowserAuthService(now=lambda: now)


@pytest.mark.asyncio
async def test_refresh_keeps_the_original_auth_time(session: AsyncSession) -> None:
    raw = await _sign_in(session)
    result = await _service(LATER).refresh(session, refresh_token=raw)
    assert _auth_time(result.access_token) == int(SIGNED_IN.timestamp())
    successor = await session.scalar(
        select(BrowserRefreshSession).where(
            BrowserRefreshSession.revoked_at.is_(None)
        )
    )
    assert successor is not None
    assert successor.auth_time is not None
    assert successor.auth_time.replace(tzinfo=UTC) == SIGNED_IN


@pytest.mark.asyncio
async def test_a_grace_response_keeps_the_session_auth_time(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "auth_browser_refresh_reuse_grace_seconds", 30)
    raw = await _sign_in(session)
    await _service(LATER).refresh(session, refresh_token=raw)
    raced = await _service(LATER + timedelta(seconds=2)).refresh(
        session, refresh_token=raw
    )
    assert raced.refresh_token is None
    assert _auth_time(raced.access_token) == int(SIGNED_IN.timestamp())


@pytest.mark.asyncio
async def test_a_grace_response_carries_a_step_up_made_after_the_rotation(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "auth_browser_refresh_reuse_grace_seconds", 30)
    raw = await _sign_in(session)
    await _service(LATER).refresh(session, refresh_token=raw)
    stepped_up = LATER + timedelta(seconds=1)
    # A step-up stamps the live token of the family, which is the successor.
    await session.execute(
        update(BrowserRefreshSession)
        .where(BrowserRefreshSession.revoked_at.is_(None))
        .values(auth_time=stepped_up)
    )
    raced = await _service(LATER + timedelta(seconds=2)).refresh(
        session, refresh_token=raw
    )
    # The session's current authentication time, not the older value on the rotated row.
    assert _auth_time(raced.access_token) == int(stepped_up.timestamp())


@pytest.mark.asyncio
async def test_a_session_without_auth_time_stays_without_it(
    session: AsyncSession,
) -> None:
    raw = await _sign_in(session)
    await session.execute(update(BrowserRefreshSession).values(auth_time=None))
    result = await _service(LATER).refresh(session, refresh_token=raw)
    payload = result.access_token.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    assert "auth_time" not in claims  # a refresh never invents one
