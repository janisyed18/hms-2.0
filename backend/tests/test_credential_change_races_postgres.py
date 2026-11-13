"""A credential change racing a sign-in or a refresh, on real PostgreSQL row locks.

The service reads the user's credential version (or the refresh session) and then
inserts a new refresh session. A reset that committed in between would have missed it,
leaving a session that survives the reset and refreshes into a token carrying the new
version. Sign-in and refresh therefore row-lock the user, as a credential change does:
whichever goes first, no usable refresh session outlives the change.
"""

from __future__ import annotations

import asyncio
import base64
import os
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from uuid import uuid4

import pyotp
import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.core import mfa
from hms_backend.app.core.config import settings
from hms_backend.app.core.passwords import hash_password
from hms_backend.app.models import foundation  # noqa: F401
from hms_backend.app.modules.assets import models as _assets  # noqa: F401
from hms_backend.app.modules.certificates import models as _certs  # noqa: F401
from hms_backend.app.modules.customers import models as _customers  # noqa: F401
from hms_backend.app.modules.identity.browser_auth import (
    AuthenticatedSession,
    BrowserAuthError,
    BrowserAuthService,
    IssuedChallenge,
)
from hms_backend.app.modules.identity.credentials import rotate_credentials
from hms_backend.app.modules.identity.models import BrowserRefreshSession, User
from hms_backend.app.modules.inspections import models as _inspections  # noqa: F401
from hms_backend.app.modules.notifications import models as _notifications  # noqa: F401
from hms_backend.app.modules.products import models as _products  # noqa: F401
from hms_backend.app.modules.reference import models as _reference  # noqa: F401
from hms_backend.app.modules.scheduling import models as _scheduling  # noqa: F401

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)

Factory = async_sessionmaker[AsyncSession]
PASSWORD = "Sup3r-Secret-Passphrase!"
TOTP_SECRET = pyotp.random_base32()
SERVICE = BrowserAuthService()


@pytest.fixture(autouse=True)
def _config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "auth_mfa_required", True, raising=False)
    monkeypatch.setattr(
        settings,
        "auth_mfa_encryption_key",
        base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii"),
    )
    monkeypatch.setattr(settings, "auth_recovery_code_pepper", "unit-test-pepper")
    monkeypatch.setattr(settings, "auth_bearer_hmac_secret", "unit-test-secret")


@pytest_asyncio.fixture
async def factory() -> AsyncIterator[Factory]:
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
async def account(factory: Factory) -> AsyncIterator[tuple[str, str]]:
    """(user id, email) of a user with MFA enrolled."""
    tag = uuid4().hex[:12]
    async with factory() as session:
        user = User(
            oidc_subject=f"race-{tag}",
            email=f"race-{tag}@example.com",
            role="INSPECTOR",
            password_hash=hash_password(PASSWORD),
            mfa_enabled=True,
        )
        session.add(user)
        await session.flush()
        encrypted = mfa.encrypt_totp_secret(TOTP_SECRET, user_id=user.id)
        user.mfa_secret_ciphertext = encrypted.ciphertext
        user.mfa_secret_key_version = encrypted.key_version
        await session.commit()
        ids = (user.id, user.email)
    yield ids
    async with factory() as session:
        row = await session.get(User, ids[0])
        if row is not None:
            await session.delete(row)
            await session.commit()


async def _challenge(factory: Factory, email: str) -> str:
    async with factory() as session:
        issued = await SERVICE.login(session, email=email, password=PASSWORD)
        assert isinstance(issued, IssuedChallenge)
        await session.commit()
        return issued.raw


async def _fresh_code(factory: Factory, user_id: str) -> str:
    async with factory() as session:
        row = await session.get(User, user_id)
        assert row is not None
        row.mfa_last_accepted_step = None
        await session.commit()
    return pyotp.TOTP(TOTP_SECRET).now()


async def _sign_in(factory: Factory, user_id: str, email: str) -> AuthenticatedSession:
    challenge = await _challenge(factory, email)
    code = await _fresh_code(factory, user_id)
    async with factory() as session:
        authed = await SERVICE.verify_mfa(session, challenge=challenge, code=code)
        await session.commit()
        return authed


async def _live_sessions(factory: Factory, user_id: str) -> int:
    async with factory() as session:
        rows = (
            await session.scalars(
                select(BrowserRefreshSession).where(
                    BrowserRefreshSession.user_id == user_id,
                    BrowserRefreshSession.revoked_at.is_(None),
                )
            )
        ).all()
        return len(rows)


async def _reset(factory: Factory, user_id: str, *, hold: float = 0.0) -> None:
    async with factory() as session:
        user = await session.get(User, user_id)
        assert user is not None
        await rotate_credentials(session, user)
        if hold:
            await asyncio.sleep(hold)  # keep the lock while the other side arrives
        await session.commit()


async def _hold_then_commit(
    factory: Factory,
    work: Callable[[AsyncSession], Awaitable[object]],
    done_work: asyncio.Event,
    release: asyncio.Event,
) -> None:
    async with factory() as session:
        try:
            await work(session)
        finally:
            done_work.set()  # never leave the test waiting if the work failed
        await release.wait()
        await session.commit()


@pytest.mark.asyncio
async def test_a_reset_that_arrives_mid_sign_in_waits_and_then_ends_the_new_session(
    factory: Factory, account: tuple[str, str]
) -> None:
    user_id, email = account
    challenge = await _challenge(factory, email)
    code = await _fresh_code(factory, user_id)
    signed_in, release = asyncio.Event(), asyncio.Event()
    sign_in = asyncio.create_task(
        _hold_then_commit(
            factory,
            lambda s: SERVICE.verify_mfa(s, challenge=challenge, code=code),
            signed_in,
            release,
        )
    )
    await signed_in.wait()
    reset = asyncio.create_task(_reset(factory, user_id))
    await asyncio.sleep(0.5)
    assert not reset.done(), "the reset must wait for the sign-in's row lock"
    release.set()
    await asyncio.gather(sign_in, reset)

    assert await _live_sessions(factory, user_id) == 0


@pytest.mark.asyncio
async def test_a_sign_in_that_arrives_mid_reset_is_refused(
    factory: Factory, account: tuple[str, str]
) -> None:
    user_id, email = account
    challenge = await _challenge(factory, email)
    code = await _fresh_code(factory, user_id)
    reset = asyncio.create_task(_reset(factory, user_id, hold=0.8))
    await asyncio.sleep(0.3)

    async def attempt() -> None:
        async with factory() as session:
            await SERVICE.verify_mfa(session, challenge=challenge, code=code)
            await session.commit()

    with pytest.raises(BrowserAuthError):
        await attempt()
    await reset
    assert await _live_sessions(factory, user_id) == 0


@pytest.mark.asyncio
async def test_a_reset_that_arrives_mid_refresh_waits_and_ends_the_rotated_session(
    factory: Factory, account: tuple[str, str]
) -> None:
    user_id, email = account
    token = (await _sign_in(factory, user_id, email)).refresh_token
    rotated, release = asyncio.Event(), asyncio.Event()
    refresh = asyncio.create_task(
        _hold_then_commit(
            factory,
            lambda s: SERVICE.refresh(s, refresh_token=token),
            rotated,
            release,
        )
    )
    await rotated.wait()
    reset = asyncio.create_task(_reset(factory, user_id))
    await asyncio.sleep(0.5)
    assert not reset.done(), "the reset must wait for the refresh's row lock"
    release.set()
    await asyncio.gather(refresh, reset)

    assert await _live_sessions(factory, user_id) == 0


@pytest.mark.asyncio
async def test_a_refresh_that_arrives_mid_reset_is_refused_and_creates_nothing(
    factory: Factory, account: tuple[str, str]
) -> None:
    user_id, email = account
    token = (await _sign_in(factory, user_id, email)).refresh_token
    reset = asyncio.create_task(_reset(factory, user_id, hold=0.8))
    await asyncio.sleep(0.3)

    async with factory() as session:
        with pytest.raises(BrowserAuthError):
            await SERVICE.refresh(session, refresh_token=token)
        await session.commit()
    await reset
    assert await _live_sessions(factory, user_id) == 0
