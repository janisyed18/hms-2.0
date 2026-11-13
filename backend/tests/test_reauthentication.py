"""Session-bound step-up reauthentication.

``auth_time`` lives on the browser refresh session: set at sign-in, carried
unchanged through refresh, and moved only by a successful password + TOTP step-up
of that one session. A stale or missing value gives a distinct 403 REAUTH_REQUIRED.
"""

from __future__ import annotations

import base64
import json
import secrets
from collections.abc import AsyncGenerator, Generator
from datetime import UTC, datetime, timedelta

import fakeredis.aioredis
import httpx
import pyotp
import pytest
import pytest_asyncio
from sqlalchemy import event, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.auth import encode_hs256_bearer_token
from hms_backend.app.core.config import settings
from hms_backend.app.core.passwords import hash_password
from hms_backend.app.core.redis import set_redis_client
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.modules.identity.models import BrowserRefreshSession, User

PW = "Sup3r-Secret-Passphrase!"
BASE = "/api/v1/auth/browser"
SessionFactory = async_sessionmaker[AsyncSession]
TOTP_SECRET = pyotp.random_base32()


@pytest.fixture(autouse=True)
def _config(monkeypatch: pytest.MonkeyPatch) -> Generator[None, None, None]:
    monkeypatch.setattr(settings, "environment", "test")
    monkeypatch.setattr(settings, "auth_mode", "bearer")
    monkeypatch.setattr(settings, "auth_bearer_hmac_secret", "unit-test-secret")
    monkeypatch.setattr(settings, "auth_browser_login_enabled", True)
    monkeypatch.setattr(settings, "auth_mfa_required", True, raising=False)
    monkeypatch.setattr(settings, "auth_browser_cookie_secure", False)
    monkeypatch.setattr(
        settings,
        "auth_mfa_encryption_key",
        base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii"),
    )
    monkeypatch.setattr(settings, "auth_recovery_code_pepper", "unit-test-pepper")
    set_redis_client(fakeredis.aioredis.FakeRedis(decode_responses=True))
    yield
    set_redis_client(None)


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[SessionFactory]:
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine.sync_engine, "connect")
    def _fk(dbapi_connection, _record) -> None:  # type: ignore[no-untyped-def]
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


def _client(factory: SessionFactory) -> httpx.AsyncClient:
    app = create_app()

    async def _override() -> AsyncGenerator[AsyncSession]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = _override
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://t"
    )


@pytest_asyncio.fixture
async def seeded(session_factory: SessionFactory) -> dict[str, str]:
    from hms_backend.app.core import mfa

    encrypted = None
    async with session_factory() as session:
        admin = User(
            oidc_subject="admin-sub",
            email="admin@example.com",
            role="HMS_ADMIN",
            password_hash=hash_password(PW),
            mfa_enabled=True,
        )
        target = User(
            oidc_subject="target-sub",
            email="target@example.com",
            role="INSPECTOR",
            password_hash=hash_password(PW),
            account_status="LOCKED",
        )
        session.add_all([admin, target])
        await session.flush()
        encrypted = mfa.encrypt_totp_secret(TOTP_SECRET, user_id=admin.id)
        admin.mfa_secret_ciphertext = encrypted.ciphertext
        admin.mfa_secret_key_version = encrypted.key_version
        await session.commit()
        return {"admin": admin.id, "target": target.id}


async def _next_code(factory: SessionFactory) -> str:
    """A valid TOTP code; clears the replay guard so tests can reuse a window."""
    async with factory() as session:
        await session.execute(update(User).values(mfa_last_accepted_step=None))
        await session.commit()
    return pyotp.TOTP(TOTP_SECRET).now()


async def _sign_in(client: httpx.AsyncClient, factory: SessionFactory) -> str:
    login = await client.post(
        f"{BASE}/login", json={"email": "admin@example.com", "password": PW}
    )
    assert login.status_code == 200, login.text
    verified = await client.post(
        f"{BASE}/mfa/verify",
        json={
            "challenge": login.json()["challenge"],
            "code": await _next_code(factory),
        },
    )
    assert verified.status_code == 200, verified.text
    return str(verified.json()["access_token"])


def _claims(token: str) -> dict[str, object]:
    payload = token.split(".")[1]
    padded = payload + "=" * (-len(payload) % 4)
    return dict(json.loads(base64.urlsafe_b64decode(padded)))


async def _backdate(factory: SessionFactory, *, minutes: int, row: int = 0) -> int:
    """Move a live browser session's auth_time into the past; returns the unix time."""
    async with factory() as session:
        rows = (
            await session.scalars(
                select(BrowserRefreshSession)
                .where(BrowserRefreshSession.revoked_at.is_(None))
                .order_by(BrowserRefreshSession.id)
            )
        ).all()
        old = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=minutes)
        rows[row].auth_time = old
        await session.commit()
        return int(old.timestamp())


def _unix(value: datetime) -> int:
    """SQLite returns naive datetimes; they are UTC."""
    return int((value if value.tzinfo else value.replace(tzinfo=UTC)).timestamp())


async def _auth_times(factory: SessionFactory) -> list[datetime | None]:
    async with factory() as session:
        rows = (
            await session.scalars(
                select(BrowserRefreshSession)
                .where(BrowserRefreshSession.revoked_at.is_(None))
                .order_by(BrowserRefreshSession.id)
            )
        ).all()
        return [r.auth_time for r in rows]


async def _all_auth_times(factory: SessionFactory) -> list[datetime | None]:
    async with factory() as session:
        return list(
            (
                await session.scalars(
                    select(BrowserRefreshSession.auth_time).order_by(
                        BrowserRefreshSession.id
                    )
                )
            ).all()
        )


async def _unlock(
    client: httpx.AsyncClient, token: str, target: str
) -> httpx.Response:
    return await client.post(
        f"/api/v1/admin/users/{target}/disable",
        headers={"Authorization": f"Bearer {token}"},
    )


async def _reauth(
    client: httpx.AsyncClient,
    token: str,
    *,
    password: str = PW,
    code: str | None = None,
) -> httpx.Response:
    return await client.post(
        f"{BASE}/reauth",
        json={"password": password, "code": code},
        headers={"Authorization": f"Bearer {token}"},
    )


@pytest.mark.asyncio
async def test_refresh_keeps_the_original_auth_time(
    session_factory: SessionFactory, seeded: dict[str, str]
) -> None:
    async with _client(session_factory) as client:
        await _sign_in(client, session_factory)
        original = await _backdate(session_factory, minutes=10)
        refreshed = await client.post(f"{BASE}/refresh")
        again = await client.post(f"{BASE}/refresh")
    assert refreshed.status_code == again.status_code == 200
    assert _claims(refreshed.json()["access_token"])["auth_time"] == original
    assert _claims(again.json()["access_token"])["auth_time"] == original
    stored = await _auth_times(session_factory)
    assert [_unix(t) for t in stored if t] == [original]


@pytest.mark.asyncio
async def test_a_sensitive_action_after_five_minutes_asks_for_reauthentication(
    session_factory: SessionFactory, seeded: dict[str, str]
) -> None:
    async with _client(session_factory) as client:
        fresh = await _sign_in(client, session_factory)
        assert (await _unlock(client, fresh, seeded["target"])).status_code == 200
        await _backdate(session_factory, minutes=6)
        stale = (await client.post(f"{BASE}/refresh")).json()["access_token"]
        denied = await _unlock(client, stale, seeded["target"])
    assert denied.status_code == 403
    assert denied.json()["detail"]["code"] == "REAUTH_REQUIRED"
    assert denied.json()["detail"]["method"] == "password"


@pytest.mark.asyncio
async def test_password_and_code_update_only_this_sessions_time_and_the_retry_works(
    session_factory: SessionFactory, seeded: dict[str, str]
) -> None:
    async with _client(session_factory) as a, _client(session_factory) as b:
        await _sign_in(a, session_factory)
        await _sign_in(b, session_factory)
        old_a = await _backdate(session_factory, minutes=10, row=0)
        old_b = await _backdate(session_factory, minutes=10, row=1)
        stale_a = (await a.post(f"{BASE}/refresh")).json()["access_token"]
        stale_b = (await b.post(f"{BASE}/refresh")).json()["access_token"]
        assert (await _unlock(a, stale_a, seeded["target"])).status_code == 403

        done = await _reauth(a, stale_a, code=await _next_code(session_factory))
        assert done.status_code == 200, done.text
        new_a = done.json()["access_token"]
        assert _claims(new_a)["auth_time"] > old_a  # type: ignore[operator]

        # The same request, retried with the fresh token, now goes through.
        assert (await _unlock(a, new_a, seeded["target"])).status_code == 200
        # A refresh afterwards keeps the new time rather than reverting it.
        later = (await a.post(f"{BASE}/refresh")).json()["access_token"]
        assert _claims(later)["auth_time"] == _claims(new_a)["auth_time"]

        # Browser B is not made recent by A's step-up.
        assert (await _unlock(b, stale_b, seeded["target"])).status_code == 403
        b_after = (await b.post(f"{BASE}/refresh")).json()["access_token"]
        assert _claims(b_after)["auth_time"] == old_b


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["password", "code", "missing_code"])
async def test_a_wrong_password_or_code_does_not_update_the_time(
    session_factory: SessionFactory, seeded: dict[str, str], fault: str
) -> None:
    async with _client(session_factory) as client:
        await _sign_in(client, session_factory)
        old = await _backdate(session_factory, minutes=10)
        stale = (await client.post(f"{BASE}/refresh")).json()["access_token"]
        good_code = await _next_code(session_factory)
        wrong_code = "000000" if good_code != "000000" else "111111"
        response = await _reauth(
            client,
            stale,
            password="wrong-password" if fault == "password" else PW,
            code={"password": good_code, "code": wrong_code, "missing_code": None}[
                fault
            ],
        )
        retry = await _unlock(client, stale, seeded["target"])
    assert response.status_code == 400
    assert retry.status_code == 403
    assert [_unix(t) for t in await _auth_times(session_factory) if t] == [
        old
    ]


@pytest.mark.asyncio
async def test_a_token_without_auth_time_is_denied(
    session_factory: SessionFactory, seeded: dict[str, str]
) -> None:
    token = encode_hs256_bearer_token(
        subject="admin-sub", secret="unit-test-secret", extra_claims={"cv": 0}
    )
    async with _client(session_factory) as client:
        denied = await _unlock(client, token, seeded["target"])
    assert denied.status_code == 403
    assert denied.json()["detail"]["code"] == "REAUTH_REQUIRED"


@pytest.mark.asyncio
@pytest.mark.parametrize("ended", ["revoked", "expired"])
async def test_an_ended_session_cannot_be_revived_by_reauthentication(
    session_factory: SessionFactory, seeded: dict[str, str], ended: str
) -> None:
    async with _client(session_factory) as client:
        token = await _sign_in(client, session_factory)
        async with session_factory() as session:
            values = (
                {"revoked_at": datetime.now(UTC)}
                if ended == "revoked"
                else {"expires_at": datetime.now(UTC) - timedelta(seconds=1)}
            )
            await session.execute(update(BrowserRefreshSession).values(**values))
            await session.commit()
        before = await _all_auth_times(session_factory)
        response = await _reauth(
            client, token, code=await _next_code(session_factory)
        )
    assert response.status_code == 401
    assert await _all_auth_times(session_factory) == before


@pytest.mark.asyncio
async def test_the_cookie_and_the_bearer_token_must_belong_to_the_same_user(
    session_factory: SessionFactory, seeded: dict[str, str]
) -> None:
    other = encode_hs256_bearer_token(
        subject="target-sub",
        secret="unit-test-secret",
        extra_claims={"cv": 0, "auth_time": int(datetime.now(UTC).timestamp())},
    )
    async with _client(session_factory) as client:
        await _sign_in(client, session_factory)
        response = await _reauth(
            client, other, code=await _next_code(session_factory)
        )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_reauthentication_needs_a_session_cookie(
    session_factory: SessionFactory, seeded: dict[str, str]
) -> None:
    async with _client(session_factory) as signed_in:
        token = await _sign_in(signed_in, session_factory)
    async with _client(session_factory) as no_cookie:
        response = await _reauth(
            no_cookie, token, code=await _next_code(session_factory)
        )
    assert response.status_code == 401


def test_oidc_sessions_without_a_provider_auth_time_are_refused_and_pointed_at_the_idp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from fastapi import HTTPException

    from hms_backend.app.api.admin import _require_recent_auth
    from hms_backend.app.core.rbac import Principal, Role

    monkeypatch.setattr(settings, "auth_mode", "oidc")
    unknown = Principal(
        user_id="u", roles=frozenset({Role.HMS_ADMIN}), customer_ids=frozenset()
    )
    with pytest.raises(HTTPException) as refused:
        _require_recent_auth(unknown)
    assert refused.value.status_code == 403
    assert refused.value.detail["code"] == "REAUTH_REQUIRED"  # type: ignore[index]
    assert refused.value.detail["method"] == "oidc"  # type: ignore[index]

    recent = Principal(
        user_id="u",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
        auth_time=int(datetime.now(UTC).timestamp()),
    )
    _require_recent_auth(recent)


def test_dev_header_mode_alone_is_exempt(monkeypatch: pytest.MonkeyPatch) -> None:
    from hms_backend.app.api.admin import _require_recent_auth
    from hms_backend.app.core.rbac import Principal, Role

    monkeypatch.setattr(settings, "auth_mode", "dev")
    _require_recent_auth(
        Principal(
            user_id="u", roles=frozenset({Role.HMS_ADMIN}), customer_ids=frozenset()
        )
    )
