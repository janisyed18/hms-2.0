"""RFC 8058 one-click unsubscribe, end to end: headers built, sent and honoured."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import hms_backend.app.api.notifications as notifications_api
from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.config import Settings
from hms_backend.app.core.unsubscribe_tokens import read_unsubscribe_token
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.models.foundation import AuditEvent
from hms_backend.app.modules.notifications.channels.base import (
    DeliveryResult,
    OutgoingMessage,
)
from hms_backend.app.modules.notifications.channels.email_ses import AwsSesEmailAdapter
from hms_backend.app.modules.notifications.channels.email_smtp import (
    build_email_message,
)
from hms_backend.app.modules.notifications.enums import (
    NotificationCategory,
    NotificationChannel,
    NotificationStatus,
    NotificationTier,
    RecipientType,
)
from hms_backend.app.modules.notifications.models import (
    Notification,
    NotificationPreference,
)
from hms_backend.app.modules.notifications.service import dispatch_pending

URL = "https://hms.example.com/api/v1/notifications/unsubscribe?token=abc.def"
HTTPS_SETTINGS = Settings(
    environment="production",
    public_base_url="https://hms.example.com",
    auth_bearer_hmac_secret="k" * 40,
    email_from_address="hms@example.com",
)


def message(url: str | None = URL) -> OutgoingMessage:
    return OutgoingMessage(
        channel=NotificationChannel.EMAIL,
        to_address="recipient@example.com",
        subject="Retest due",
        body_text="Body",
        unsubscribe_url=url,
    )


def test_smtp_message_carries_both_rfc_8058_headers() -> None:
    built = build_email_message(HTTPS_SETTINGS, message())
    assert built["List-Unsubscribe"] == f"<{URL}>"
    assert built["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"


@pytest.mark.parametrize("url", [None, "", "http://hms.local/unsubscribe?token=x"])
def test_smtp_message_has_no_headers_without_an_https_url(url: str | None) -> None:
    built = build_email_message(HTTPS_SETTINGS, message(url))
    assert built["List-Unsubscribe"] is None
    assert built["List-Unsubscribe-Post"] is None


class _Ses:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def send_email(self, **params: Any) -> dict[str, str]:
        self.calls.append(params)
        return {"MessageId": "m-1"}


@pytest.mark.asyncio
async def test_ses_payload_carries_both_rfc_8058_headers() -> None:
    client = _Ses()
    await AwsSesEmailAdapter(HTTPS_SETTINGS, client=client).send(message())
    assert client.calls[0]["Content"]["Simple"]["Headers"] == [
        {"Name": "List-Unsubscribe", "Value": f"<{URL}>"},
        {"Name": "List-Unsubscribe-Post", "Value": "List-Unsubscribe=One-Click"},
    ]


@pytest.mark.asyncio
async def test_ses_payload_has_no_headers_without_an_https_url() -> None:
    client = _Ses()
    await AwsSesEmailAdapter(HTTPS_SETTINGS, client=client).send(message(None))
    assert "Headers" not in client.calls[0]["Content"]["Simple"]


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


class _Recorder:
    channel = NotificationChannel.EMAIL

    def __init__(self) -> None:
        self.sent: list[OutgoingMessage] = []

    async def send(self, outgoing: OutgoingMessage) -> DeliveryResult:
        self.sent.append(outgoing)
        return DeliveryResult(success=True, provider_message_id="r-1")


async def _queue(
    factory: async_sessionmaker[AsyncSession], tier: NotificationTier, key: str
) -> None:
    async with factory() as session:
        session.add(
            Notification(
                event_ref=f"evt-{key}",
                category=NotificationCategory.RETEST_ADVANCE.value,
                tier=tier.value,
                recipient_type=RecipientType.CUSTOMER_CONTACT.value,
                recipient_id="contact-9",
                recipient_address="c@example.com",
                channel=NotificationChannel.EMAIL.value,
                template_key="t",
                template_version=1,
                subject="Retest due",
                body="Body",
                status=NotificationStatus.PENDING.value,
                idempotency_key=key,
            )
        )
        await session.commit()


@pytest.mark.asyncio
async def test_dispatch_mints_a_signed_link_for_informational_email_only(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _queue(session_factory, NotificationTier.INFORMATIONAL, "info")
    await _queue(session_factory, NotificationTier.CRITICAL, "critical")
    adapter = _Recorder()
    await dispatch_pending(
        session_factory, adapters={NotificationChannel.EMAIL: adapter},
        settings=HTTPS_SETTINGS,
    )
    urls = sorted(str(m.unsubscribe_url) for m in adapter.sent)
    assert len(adapter.sent) == 2
    assert urls[0] == "None"  # the essential message has no unsubscribe link
    token = parse_qs(urlparse(urls[1]).query)["token"][0]
    claim = read_unsubscribe_token(token, HTTPS_SETTINGS)
    assert claim is not None
    assert (claim.party_type, claim.party_id) == ("CUSTOMER_CONTACT", "contact-9")
    assert claim.category == NotificationCategory.RETEST_ADVANCE.value


@pytest.mark.asyncio
async def test_rfc_8058_post_unsubscribes_using_only_the_token_in_the_url(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _queue(session_factory, NotificationTier.INFORMATIONAL, "info")
    adapter = _Recorder()
    await dispatch_pending(
        session_factory, adapters={NotificationChannel.EMAIL: adapter},
        settings=HTTPS_SETTINGS,
    )
    token = parse_qs(urlparse(str(adapter.sent[0].unsubscribe_url)).query)["token"][0]

    # The mail client posts the RFC 8058 body; a forged identity in it is ignored.
    app = create_app()

    async def override() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override
    monkeypatch.setattr(notifications_api, "settings", HTTPS_SETTINGS)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post(
            "/api/v1/notifications/unsubscribe",
            params={"token": token},
            content=b"List-Unsubscribe=One-Click&party_id=someone-else",
            headers={"content-type": "application/x-www-form-urlencoded"},
        )
    assert response.status_code == 200, response.text
    async with session_factory() as session:
        (pref,) = list(await session.scalars(select(NotificationPreference)))
        (event,) = list(await session.scalars(select(AuditEvent)))
    assert pref.party_id == "contact-9" and pref.opted_in is False
    assert event.action == "notification.unsubscribed"
