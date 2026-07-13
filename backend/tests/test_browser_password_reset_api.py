from __future__ import annotations

import base64
from collections.abc import AsyncGenerator, Generator

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.config import settings
from hms_backend.app.core.password_reset_tokens import (
    EncryptedPasswordResetDelivery,
    decrypt_password_reset_delivery,
)
from hms_backend.app.core.passwords import hash_password
from hms_backend.app.core.redis import set_redis_client
from hms_backend.app.main import create_app
from hms_backend.app.models import foundation  # noqa: F401, E402
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets import models as _assets  # noqa: F401, E402
from hms_backend.app.modules.certificates import models as _certs  # noqa: F401, E402
from hms_backend.app.modules.customers import models as _customers  # noqa: F401, E402
from hms_backend.app.modules.identity.models import (
    PasswordResetDelivery,
    User,
)
from hms_backend.app.modules.inspections import (
    models as _inspections,  # noqa: F401, E402
)
from hms_backend.app.modules.notifications import (
    models as _notifications,  # noqa: F401, E402
)
from hms_backend.app.modules.products import models as _products  # noqa: F401, E402
from hms_backend.app.modules.reference import models as _reference  # noqa: F401, E402
from hms_backend.app.modules.scheduling import models as _scheduling  # noqa: F401, E402

SessionFactory = async_sessionmaker[AsyncSession]
EMAIL = "api-reset@example.com"
PASSWORD = "Sup3r-Secret-Passphrase!"


@pytest.fixture(autouse=True)
def config(monkeypatch: pytest.MonkeyPatch) -> Generator[None, None, None]:
    monkeypatch.setattr(settings, "environment", "test")
    monkeypatch.setattr(settings, "auth_mode", "bearer")
    monkeypatch.setattr(settings, "auth_browser_login_enabled", True)
    monkeypatch.setattr(settings, "auth_browser_cookie_secure", False)
    monkeypatch.setattr(
        settings,
        "auth_password_reset_encryption_key",
        base64.urlsafe_b64encode(b"a" * 32).decode(),
    )
    set_redis_client(None)
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

    async def override() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://staff") as c:
        yield c


async def seed(session_factory: SessionFactory, *, status: str = "ACTIVE") -> None:
    async with session_factory() as session:
        session.add(
            User(
                oidc_subject="api-reset-subject",
                email=EMAIL,
                role="HMS_ADMIN",
                password_hash=hash_password(PASSWORD),
                account_status=status,
            )
        )
        await session.commit()


@pytest.mark.asyncio
async def test_reset_request_is_generic_for_known_and_unknown_email(
    client: httpx.AsyncClient,
    session_factory: SessionFactory,
) -> None:
    await seed(session_factory)
    known = await client.post(
        "/api/v1/auth/browser/password/reset-request", json={"email": EMAIL}
    )
    unknown = await client.post(
        "/api/v1/auth/browser/password/reset-request",
        json={"email": "unknown@example.com"},
    )

    assert known.status_code == unknown.status_code == 202
    assert known.json() == unknown.json()
    assert "reset" in known.json()["message"].lower()


@pytest.mark.asyncio
async def test_reset_confirm_changes_password_and_returns_safe_message(
    client: httpx.AsyncClient,
    session_factory: SessionFactory,
) -> None:
    await seed(session_factory)
    response = await client.post(
        "/api/v1/auth/browser/password/reset-request", json={"email": EMAIL}
    )
    assert response.status_code == 202

    async with session_factory() as session:
        delivery = await session.scalar(select(PasswordResetDelivery))
        assert delivery is not None and delivery.ciphertext is not None
        user = await session.scalar(select(User).where(User.email == EMAIL))
        assert user is not None
        token = decrypt_password_reset_delivery(
            EncryptedPasswordResetDelivery(delivery.ciphertext, delivery.key_version),
            reset_id=delivery.reset_id,
            user_id=user.id,
        )

    confirmed = await client.post(
        "/api/v1/auth/browser/password/reset-confirm",
        json={"token": token, "new_password": "N3w-Reset-Passphrase!"},
    )
    assert confirmed.status_code == 200
    assert confirmed.json() == {"message": "Password reset. You can now sign in."}

    reused = await client.post(
        "/api/v1/auth/browser/password/reset-confirm",
        json={"token": token, "new_password": "N3w-Reset-Passphrase!"},
    )
    assert reused.status_code == 400
    assert reused.json()["detail"] == "Invalid or expired reset link."
