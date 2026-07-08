"""Argon2 password login + set-password integration tests."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.auth import decode_hs256_bearer_token
from hms_backend.app.core.config import settings
from hms_backend.app.core.passwords import hash_password, verify_password
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.modules.identity.models import User

_SECRET = "test-hmac-secret"
_PASSWORD = "correct horse battery"
SessionFactory = async_sessionmaker[AsyncSession]


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    yield factory
    await engine.dispose()


@pytest.fixture(autouse=True)
def _configure_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "auth_bearer_hmac_secret", _SECRET)


@pytest_asyncio.fixture
async def users(session_factory: SessionFactory) -> dict[str, str]:
    async with session_factory() as session:
        member = User(
            oidc_subject="member-sub",
            email="member@example.com",
            role="INSPECTOR",
            password_hash=hash_password(_PASSWORD),
        )
        admin = User(
            oidc_subject="admin-sub",
            email="admin@example.com",
            role="HMS_ADMIN",
        )
        session.add_all([member, admin])
        await session.commit()
        return {"member": member.id, "admin": admin.id}


@asynccontextmanager
async def _client(
    session_factory: SessionFactory,
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        yield c


@pytest.mark.asyncio
async def test_login_success_issues_token(
    session_factory: SessionFactory,
    users: dict[str, str],
) -> None:
    async with _client(session_factory) as client:
        r = await client.post(
            "/api/v1/auth/login",
            json={"email": "MEMBER@example.com", "password": _PASSWORD},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["token_type"] == "bearer"
    claims = decode_hs256_bearer_token(body["access_token"], secret=_SECRET)
    assert claims.subject == "member-sub"


@pytest.mark.asyncio
async def test_login_wrong_password_is_401(
    session_factory: SessionFactory,
    users: dict[str, str],
) -> None:
    async with _client(session_factory) as client:
        r = await client.post(
            "/api/v1/auth/login",
            json={"email": "member@example.com", "password": "nope"},
        )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_login_unknown_email_is_401(
    session_factory: SessionFactory,
    users: dict[str, str],
) -> None:
    async with _client(session_factory) as client:
        r = await client.post(
            "/api/v1/auth/login",
            json={"email": "ghost@example.com", "password": _PASSWORD},
        )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_change_own_password(
    session_factory: SessionFactory,
    users: dict[str, str],
) -> None:
    headers = {"X-HMS-User-Id": "member-sub"}  # dev-mode identity
    async with _client(session_factory) as client:
        changed = await client.post(
            "/api/v1/auth/password",
            headers=headers,
            json={"current_password": _PASSWORD, "new_password": "brand-new-secret-9"},
        )
        assert changed.status_code == 200, changed.text
        old = await client.post(
            "/api/v1/auth/login",
            json={"email": "member@example.com", "password": _PASSWORD},
        )
        new = await client.post(
            "/api/v1/auth/login",
            json={"email": "member@example.com", "password": "brand-new-secret-9"},
        )
    assert old.status_code == 401
    assert new.status_code == 200


@pytest.mark.asyncio
async def test_admin_set_password(session_factory: SessionFactory) -> None:
    async with session_factory() as session:
        member = User(
            oidc_subject="m2", email="m2@example.com", role="INSPECTOR"
        )
        admin = User(oidc_subject="a2", email="a2@example.com", role="HMS_ADMIN")
        session.add_all([member, admin])
        await session.commit()
        member_id = member.id

    async with _client(session_factory) as client:
        r = await client.post(
            f"/api/v1/auth/users/{member_id}/password",
            headers={"X-HMS-User-Id": "a2"},
            json={"new_password": "admin-set-secret-1"},
        )
        assert r.status_code == 200, r.text
        login = await client.post(
            "/api/v1/auth/login",
            json={"email": "m2@example.com", "password": "admin-set-secret-1"},
        )
    assert login.status_code == 200

    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.id == member_id))
        assert user is not None
        assert user.password_hash is not None
        assert verify_password(user.password_hash, "admin-set-secret-1")


@pytest.mark.asyncio
async def test_admin_set_password_requires_permission(
    session_factory: SessionFactory,
    users: dict[str, str],
) -> None:
    async with _client(session_factory) as client:
        r = await client.post(
            f"/api/v1/auth/users/{users['member']}/password",
            headers={"X-HMS-User-Id": "member-sub"},  # INSPECTOR, not admin
            json={"new_password": "should-be-forbidden"},
        )
    assert r.status_code == 403
