"""The legacy password-only ``POST /auth/login`` is gone, and nothing leans on it."""

from __future__ import annotations

import re
from collections.abc import AsyncGenerator, Generator
from pathlib import Path

import fakeredis.aioredis
import httpx
import pytest
import pytest_asyncio
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.config import Settings, settings
from hms_backend.app.core.passwords import hash_password
from hms_backend.app.core.redis import set_redis_client
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.modules.identity.models import User

COOKIE = "hms_staff_refresh"
PASSWORD = "Sup3r-Secret-Passphrase!"
EMAIL = "inspector@example.com"
REPO = Path(__file__).resolve().parents[2]

SessionFactory = async_sessionmaker[AsyncSession]


@pytest.fixture(autouse=True)
def _config(monkeypatch: pytest.MonkeyPatch) -> Generator[None, None, None]:
    monkeypatch.setattr(settings, "environment", "test")
    monkeypatch.setattr(settings, "auth_mode", "bearer")
    monkeypatch.setattr(settings, "auth_bearer_hmac_secret", "unit-test-secret")
    monkeypatch.setattr(settings, "auth_browser_login_enabled", True)
    monkeypatch.setattr(settings, "auth_mfa_required", False, raising=False)
    monkeypatch.setattr(settings, "auth_browser_cookie_secure", False)
    monkeypatch.setattr(settings, "security_api_rate_limit_max_requests", 10**9)
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
async def client(session_factory: SessionFactory) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def _override() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = _override
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://t"
    ) as c:
        yield c


async def seed_inspector(session_factory: SessionFactory) -> None:
    async with session_factory() as session:
        session.add(
            User(
                oidc_subject="inspector-sub",
                email=EMAIL,
                role="INSPECTOR",
                password_hash=hash_password(PASSWORD),
                must_change_password=False,
            )
        )
        await session.commit()


LOGIN_BODY = {"email": EMAIL, "password": PASSWORD}


@pytest.mark.asyncio
async def test_the_route_is_gone_and_not_documented(
    client: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    await seed_inspector(session_factory)
    response = await client.post("/api/v1/auth/login", json=LOGIN_BODY)
    schema = (await client.get("/api/v1/openapi.json")).json()
    assert response.status_code in {404, 405}
    assert "access_token" not in response.text
    assert "/api/v1/auth/login" not in schema["paths"]
    assert not any(path.rstrip("/").endswith("/auth/login") for path in schema["paths"])
    assert "LoginRequest" not in schema.get("components", {}).get("schemas", {})
    assert "TokenResponse" not in schema.get("components", {}).get("schemas", {})


@pytest.mark.asyncio
async def test_an_old_enable_flag_cannot_bring_it_back(
    monkeypatch: pytest.MonkeyPatch, session_factory: SessionFactory
) -> None:
    monkeypatch.setenv("AUTH_PASSWORD_LOGIN_ENABLED", "true")
    monkeypatch.setenv("AUTH_ACCESS_TOKEN_TTL_SECONDS", "3600")
    rebuilt = Settings()
    assert not hasattr(rebuilt, "auth_password_login_enabled")
    assert "auth_password_login_enabled" not in Settings.model_fields
    assert rebuilt.auth_config_errors() == rebuilt.auth_config_errors()

    app = create_app()
    await seed_inspector(session_factory)

    async def _override() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = _override
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://t"
    ) as c:
        response = await c.post("/api/v1/auth/login", json=LOGIN_BODY)
    assert response.status_code in {404, 405}


def test_a_stale_dotenv_flag_fails_loudly_instead_of_enabling_anything(
    tmp_path: Path,
) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("AUTH_PASSWORD_LOGIN_ENABLED=true\n")
    with pytest.raises(Exception, match="auth_password_login_enabled"):
        Settings(_env_file=env_file)  # type: ignore[call-arg]


def test_no_client_or_config_still_refers_to_the_legacy_endpoint() -> None:
    """No web client (staff, portal, inspector) or config falls back to it."""
    pattern = re.compile(r"auth/login\b|AUTH_PASSWORD_LOGIN_ENABLED|passwordLogin")
    roots = [
        REPO / "web" / "apps",
        REPO / "web" / "libs",
        REPO / "infra",
        REPO / ".github",
        REPO / "backend" / "src",
        REPO / "backend" / ".env.example",
        REPO / "docker-compose.yml",
    ]
    suffixes = {
        ".ts",
        ".tsx",
        ".js",
        ".py",
        ".tf",
        ".yml",
        ".yaml",
        ".json",
        ".example",
    }
    offenders: list[str] = []
    for root in roots:
        if not root.exists():
            continue
        files = [root] if root.is_file() else root.rglob("*")
        for path in files:
            if (
                not path.is_file()
                or "node_modules" in path.parts
                or "dist" in path.parts
                or (path.suffix not in suffixes and path.name != ".env.example")
            ):
                continue
            for number, line in enumerate(
                path.read_text(encoding="utf-8", errors="ignore").splitlines(), 1
            ):
                if pattern.search(line) and "browser/login" not in line:
                    offenders.append(
                        f"{path.relative_to(REPO)}:{number}: {line.strip()}"
                    )
    assert offenders == []


@pytest.mark.asyncio
async def test_the_inspector_signs_in_syncs_refreshes_and_signs_out(
    client: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    """The supported path end to end: browser sign-in, paged sync, refresh, logout."""
    await seed_inspector(session_factory)
    login = await client.post("/api/v1/auth/browser/login", json=LOGIN_BODY)
    assert login.status_code == 200, login.text
    assert login.json()["next_step"] == "AUTHENTICATED"
    bearer = {"Authorization": f"Bearer {login.json()['access_token']}"}
    device = {
        "X-HMS-Device-Id": "inspector-browser-proof",
        "X-HMS-Device-Platform": "web",
        "X-HMS-App-Version": "0.2.0",
        "X-HMS-Sync-Protocol": "2",
    }

    me = await client.get("/api/v1/auth/me", headers=bearer)
    assert me.status_code == 200 and "INSPECTOR" in me.json()["roles"]
    first = await client.get("/api/v1/sync/bootstrap", headers={**bearer, **device})
    assert first.status_code == 200, first.text
    assert first.json()["protocol_version"] == 2
    assert first.json()["has_more"] is False

    refreshed = await client.post(
        "/api/v1/auth/browser/refresh", headers={"Origin": "http://t"}
    )
    assert refreshed.status_code == 200, refreshed.text
    renewed = {"Authorization": f"Bearer {refreshed.json()['access_token']}"}
    again = await client.get(
        "/api/v1/sync/changes",
        params={"since": first.json()["cursor"]},
        headers={**renewed, **device},
    )
    assert again.status_code == 200, again.text

    cookie = client.cookies.get(COOKIE)
    assert cookie is not None
    out = await client.post(
        "/api/v1/auth/browser/logout", headers={"Origin": "http://t"}
    )
    assert out.status_code == 204
    revoked = await client.post(
        "/api/v1/auth/browser/refresh",
        headers={"Origin": "http://t"},
        cookies={COOKIE: cookie},
    )
    assert revoked.status_code == 401
