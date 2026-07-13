from __future__ import annotations

import base64
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from hms_backend.app.core.config import settings
from hms_backend.app.core.passwords import hash_password
from hms_backend.app.core.redis import set_redis_client
from hms_backend.app.models import foundation  # noqa: F401, E402
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets import models as _assets  # noqa: F401, E402
from hms_backend.app.modules.certificates import models as _certs  # noqa: F401, E402
from hms_backend.app.modules.customers import models as _customers  # noqa: F401, E402
from hms_backend.app.modules.identity.models import (
    PasswordResetDelivery,
    PasswordResetToken,
    User,
)
from hms_backend.app.modules.identity.password_reset import PasswordResetService
from hms_backend.app.modules.inspections import (
    models as _inspections,  # noqa: F401, E402
)
from hms_backend.app.modules.notifications import (
    models as _notifications,  # noqa: F401, E402
)
from hms_backend.app.modules.notifications.channels.base import (
    DeliveryResult,
    OutgoingMessage,
)
from hms_backend.app.modules.notifications.password_reset_delivery import (
    dispatch_password_reset_deliveries,
)
from hms_backend.app.modules.products import models as _products  # noqa: F401, E402
from hms_backend.app.modules.reference import models as _reference  # noqa: F401, E402
from hms_backend.app.modules.scheduling import models as _scheduling  # noqa: F401, E402

SessionFactory = async_sessionmaker[AsyncSession]
NOW = datetime(2026, 7, 13, 12, 0, tzinfo=UTC)


class FakeEmailAdapter:
    def __init__(self, result: DeliveryResult | None = None) -> None:
        self.messages: list[OutgoingMessage] = []
        self.result = result or DeliveryResult(
            success=True, provider_message_id="ses-1"
        )

    async def send(self, message: OutgoingMessage) -> DeliveryResult:
        self.messages.append(message)
        return self.result


@pytest.fixture(autouse=True)
def config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "environment", "test")
    monkeypatch.setattr(
        settings,
        "auth_password_reset_encryption_key",
        base64.urlsafe_b64encode(b"d" * 32).decode(),
    )
    monkeypatch.setattr(settings, "auth_browser_staff_public_url", "https://staff.test")
    monkeypatch.setattr(settings, "notification_sender_name", "BAT Engineering")
    monkeypatch.setattr(settings, "issuer_identifier", "ABN TEST")
    monkeypatch.setattr(settings, "notification_max_attempts", 1)
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


async def queue_reset(session_factory: SessionFactory) -> None:
    async with session_factory() as session:
        user = User(
            oidc_subject="delivery-subject",
            email="delivery@example.com",
            role="HMS_ADMIN",
            password_hash=hash_password("Old-Password-Passphrase!"),
        )
        session.add(user)
        await session.flush()
        await PasswordResetService(now=lambda: NOW).request(
            session, email=user.email, ip="127.0.0.1", user_agent="pytest"
        )
        await session.commit()


@pytest.mark.asyncio
async def test_delivery_sends_link_and_scrubs_ciphertext(
    session_factory: SessionFactory,
) -> None:
    await queue_reset(session_factory)
    adapter = FakeEmailAdapter()

    result = await dispatch_password_reset_deliveries(
        session_factory, adapter=adapter, now=NOW
    )

    assert result == {"sent": 1, "failed": 0}
    assert len(adapter.messages) == 1
    assert adapter.messages[0].to_address == "delivery@example.com"
    assert "/reset-password?token=" in adapter.messages[0].body_text
    async with session_factory() as session:
        delivery = await session.scalar(select(PasswordResetDelivery))
        assert delivery is not None
        assert delivery.ciphertext is None
        assert delivery.provider_message_id == "ses-1"


@pytest.mark.asyncio
async def test_expired_delivery_is_scrubbed_without_sending(
    session_factory: SessionFactory,
) -> None:
    await queue_reset(session_factory)
    async with session_factory() as session:
        delivery = await session.scalar(select(PasswordResetDelivery))
        assert delivery is not None
        delivery.scheduled_for = NOW - timedelta(seconds=1)
        token = await session.get(PasswordResetToken, delivery.reset_id)
        assert token is not None
        token.expires_at = NOW - timedelta(seconds=1)
        await session.commit()
    adapter = FakeEmailAdapter()

    result = await dispatch_password_reset_deliveries(
        session_factory, adapter=adapter, now=NOW
    )

    assert result == {"sent": 0, "failed": 1}
    assert adapter.messages == []
    async with session_factory() as session:
        delivery = await session.scalar(select(PasswordResetDelivery))
        assert delivery is not None and delivery.ciphertext is None


@pytest.mark.asyncio
async def test_final_delivery_failure_scrubs_secret_and_redacts_error(
    session_factory: SessionFactory,
) -> None:
    await queue_reset(session_factory)
    adapter = FakeEmailAdapter(
        DeliveryResult(success=False, error="secret-provider-detail")
    )

    result = await dispatch_password_reset_deliveries(
        session_factory, adapter=adapter, now=NOW
    )

    assert result == {"sent": 0, "failed": 1}
    async with session_factory() as session:
        delivery = await session.scalar(select(PasswordResetDelivery))
        assert delivery is not None
        assert delivery.ciphertext is None
        assert delivery.error == "email delivery failed"
        assert "secret-provider-detail" not in (delivery.error or "")
