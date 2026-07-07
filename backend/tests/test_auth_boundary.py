from __future__ import annotations

import base64
import hashlib
import hmac
import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.config import settings
from hms_backend.app.core.rbac import Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.modules.identity.models import User


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, expire_on_commit=False)
    yield factory
    await engine.dispose()


@asynccontextmanager
async def auth_client(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    headers: dict[str, str] | None = None,
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers=headers,
    ) as client:
        yield client


async def seed_user(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    oidc_subject: str,
    role: Role,
    customer_id: str | None = None,
) -> None:
    async with session_factory() as session:
        session.add(
            User(
                oidc_subject=oidc_subject,
                email=f"{oidc_subject}@example.com",
                first_name="Test",
                last_name="User",
                role=role.value,
                customer_id=customer_id,
            )
        )
        await session.commit()


def sign_token(payload: dict[str, Any], secret: str) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    encoded_header = _b64url_json(header)
    encoded_payload = _b64url_json(payload)
    signing_input = f"{encoded_header}.{encoded_payload}".encode()
    signature = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
    return f"{encoded_header}.{encoded_payload}.{encoded_signature}"


def _b64url_json(value: dict[str, Any]) -> str:
    encoded = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
    return base64.urlsafe_b64encode(encoded).rstrip(b"=").decode()


@pytest.mark.asyncio
async def test_bearer_mode_rejects_dev_identity_headers(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    monkeypatch.setattr(settings, "auth_mode", "bearer", raising=False)
    monkeypatch.setattr(
        settings, "auth_bearer_hmac_secret", "test-secret", raising=False
    )
    await seed_user(session_factory, oidc_subject="staff-ui-dev", role=Role.HMS_ADMIN)

    async with auth_client(
        session_factory,
        headers={"X-HMS-User-Id": "staff-ui-dev", "X-HMS-Roles": "HMS_ADMIN"},
    ) as client:
        response = await client.get("/api/v1/auth/me")

    assert response.status_code == 401
    assert response.json()["error"] == {
        "code": "unauthorized",
        "message": "Missing bearer token",
        "details": None,
    }


@pytest.mark.asyncio
async def test_bearer_mode_resolves_persisted_user_and_permissions(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    monkeypatch.setattr(settings, "auth_mode", "bearer", raising=False)
    monkeypatch.setattr(
        settings, "auth_bearer_hmac_secret", "test-secret", raising=False
    )
    monkeypatch.setattr(settings, "auth_bearer_issuer", "bat-hms-tests", raising=False)
    monkeypatch.setattr(settings, "auth_bearer_audience", "staff-web", raising=False)
    await seed_user(session_factory, oidc_subject="reviewer-1", role=Role.REVIEWER)
    token = sign_token(
        {
            "sub": "reviewer-1",
            "iss": "bat-hms-tests",
            "aud": "staff-web",
            "roles": ["HMS_ADMIN"],
            "exp": int((datetime.now(UTC) + timedelta(minutes=5)).timestamp()),
        },
        "test-secret",
    )

    async with auth_client(
        session_factory,
        headers={"Authorization": f"Bearer {token}"},
    ) as client:
        response = await client.get("/api/v1/auth/me")

    assert response.status_code == 200
    body = response.json()
    assert body["user_id"] == "reviewer-1"
    assert body["roles"] == ["REVIEWER"]
    assert "certificate:approve" in body["permissions"]
    assert "user:admin" not in body["permissions"]
    assert body["auth_mode"] == "bearer"


@pytest.mark.asyncio
async def test_bearer_mode_rejects_invalid_signature(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    monkeypatch.setattr(settings, "auth_mode", "bearer", raising=False)
    monkeypatch.setattr(
        settings, "auth_bearer_hmac_secret", "test-secret", raising=False
    )
    await seed_user(session_factory, oidc_subject="reviewer-1", role=Role.REVIEWER)
    token = sign_token(
        {
            "sub": "reviewer-1",
            "exp": int((datetime.now(UTC) + timedelta(minutes=5)).timestamp()),
        },
        "wrong-secret",
    )

    async with auth_client(
        session_factory,
        headers={"Authorization": f"Bearer {token}"},
    ) as client:
        response = await client.get("/api/v1/auth/me")

    assert response.status_code == 401
    assert response.json()["error"]["message"] == "Invalid bearer token"


@pytest.mark.asyncio
async def test_dev_mode_can_disable_unseeded_role_header_fallback(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    monkeypatch.setattr(settings, "auth_mode", "dev", raising=False)
    monkeypatch.setattr(settings, "auth_dev_headers_enabled", True, raising=False)
    monkeypatch.setattr(settings, "auth_dev_allow_role_fallback", False, raising=False)

    async with auth_client(
        session_factory,
        headers={"X-HMS-User-Id": "unseeded-dev", "X-HMS-Roles": "SUPER_ADMIN"},
    ) as client:
        response = await client.get("/api/v1/auth/me")

    assert response.status_code == 401
    assert response.json()["error"]["message"] == "Unknown HMS user identity"
