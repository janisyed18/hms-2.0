"""Browser auth endpoint tests (Task 4)."""

from __future__ import annotations

import base64
import secrets
from collections.abc import AsyncGenerator, Generator
from typing import cast

import fakeredis.aioredis
import httpx
import pyotp
import pytest
import pytest_asyncio
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.config import settings
from hms_backend.app.core.passwords import hash_password
from hms_backend.app.core.redis import set_redis_client
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.modules.identity.models import User

COOKIE = "hms_staff_refresh"
PW = "Sup3r-Secret-Passphrase!"
EMAIL = "user@example.com"

SessionFactory = async_sessionmaker[AsyncSession]


@pytest.fixture(autouse=True)
def _config(monkeypatch: pytest.MonkeyPatch) -> Generator[None, None, None]:
    monkeypatch.setattr(settings, "environment", "test")
    monkeypatch.setattr(settings, "auth_mode", "bearer")
    monkeypatch.setattr(settings, "auth_bearer_hmac_secret", "unit-test-secret")
    monkeypatch.setattr(settings, "auth_browser_login_enabled", True)
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


@pytest_asyncio.fixture
async def client(
    session_factory: SessionFactory,
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def _override() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = _override
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        yield c


async def _seed_user(
    session_factory: SessionFactory, *, must_change: bool = True
) -> None:
    async with session_factory() as session:
        session.add(
            User(
                oidc_subject="user-sub",
                email=EMAIL,
                role="HMS_ADMIN",
                password_hash=hash_password(PW),
                must_change_password=must_change,
            )
        )
        await session.commit()


async def _authenticate(client: httpx.AsyncClient) -> dict[str, object]:
    """Drive the full first-login flow and return the final authenticated body."""
    login = await client.post(
        "/api/v1/auth/browser/login", json={"email": EMAIL, "password": PW}
    )
    assert login.status_code == 200, login.text
    challenge = login.json()["challenge"]

    changed = await client.post(
        "/api/v1/auth/browser/password",
        json={"challenge": challenge, "new_password": "A-New-Str0ng-Passphrase"},
    )
    challenge = changed.json()["challenge"]

    enroll = await client.post(
        "/api/v1/auth/browser/mfa/enrollment", json={"challenge": challenge}
    )
    manual_key = enroll.json()["manual_key"]
    code = pyotp.TOTP(manual_key).now()

    confirm = await client.post(
        "/api/v1/auth/browser/mfa/confirm",
        json={"challenge": challenge, "code": code},
    )
    assert confirm.status_code == 200, confirm.text
    return cast(dict[str, object], confirm.json())


@pytest.mark.asyncio
async def test_intermediate_steps_never_leak_tokens(
    client: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    await _seed_user(session_factory)
    login = await client.post(
        "/api/v1/auth/browser/login", json={"email": EMAIL, "password": PW}
    )
    body = login.json()
    assert body["next_step"] == "PASSWORD_CHANGE_REQUIRED"
    assert "access_token" not in body
    assert "set-cookie" not in {k.lower() for k in login.headers}


@pytest.mark.asyncio
async def test_full_first_login_sets_httponly_cookie_and_recovery_codes(
    client: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    await _seed_user(session_factory)
    body = await _authenticate(client)
    assert body["next_step"] == "RECOVERY_CODES"
    assert body["access_token"]
    assert len(cast(list[str], body["recovery_codes"])) == 10


@pytest.mark.asyncio
async def test_confirm_sets_strict_httponly_cookie(
    client: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    await _seed_user(session_factory)
    login = await client.post(
        "/api/v1/auth/browser/login", json={"email": EMAIL, "password": PW}
    )
    challenge = login.json()["challenge"]
    changed = await client.post(
        "/api/v1/auth/browser/password",
        json={"challenge": challenge, "new_password": "A-New-Str0ng-Passphrase"},
    )
    challenge = changed.json()["challenge"]
    enroll = await client.post(
        "/api/v1/auth/browser/mfa/enrollment", json={"challenge": challenge}
    )
    code = pyotp.TOTP(enroll.json()["manual_key"]).now()
    confirm = await client.post(
        "/api/v1/auth/browser/mfa/confirm",
        json={"challenge": challenge, "code": code},
    )
    set_cookie = confirm.headers.get("set-cookie", "")
    assert COOKIE in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=Strict".lower() in set_cookie.lower()
    assert "/api/v1/auth/browser" in set_cookie


@pytest.mark.asyncio
async def test_refresh_rotates_and_reuse_is_rejected(
    client: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    await _seed_user(session_factory)
    await _authenticate(client)
    old_cookie = client.cookies.get(COOKIE)
    assert old_cookie is not None

    rotated = await client.post(
        "/api/v1/auth/browser/refresh", headers={"Origin": "http://t"}
    )
    assert rotated.status_code == 200, rotated.text
    assert rotated.json()["access_token"]

    # Replaying the old cookie value must fail (and burns the family).
    reuse = await client.post(
        "/api/v1/auth/browser/refresh",
        headers={"Origin": "http://t"},
        cookies={COOKIE: old_cookie},
    )
    assert reuse.status_code == 401


@pytest.mark.asyncio
async def test_me_returns_identity_with_bearer_token(
    client: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    await _seed_user(session_factory)
    body = await _authenticate(client)
    me = await client.get(
        "/api/v1/auth/browser/me",
        headers={"Authorization": f"Bearer {body['access_token']}"},
    )
    assert me.status_code == 200, me.text
    payload = me.json()
    assert payload["email"] == EMAIL
    assert "HMS_ADMIN" in payload["roles"]
    assert payload["permissions"]  # non-empty


@pytest.mark.asyncio
async def test_refresh_rejects_disallowed_origin_when_configured(
    client: httpx.AsyncClient,
    session_factory: SessionFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _seed_user(session_factory)
    monkeypatch.setattr(settings, "environment", "staging")
    monkeypatch.setattr(
        settings, "auth_browser_allowed_origins", ["https://staff.example"]
    )
    blocked = await client.post(
        "/api/v1/auth/browser/refresh", headers={"Origin": "https://evil.example"}
    )
    assert blocked.status_code == 403
