from __future__ import annotations

import re
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.rbac import Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.modules.identity.models import User
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
    PhoneVerification,
)


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, expire_on_commit=False)
    yield factory
    await engine.dispose()


@asynccontextmanager
async def notifications_client(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_id: str = "staff-oidc",
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
        headers={"X-HMS-User-Id": user_id},
    ) as client:
        yield client


async def seed_user(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    oidc_subject: str = "staff-oidc",
) -> User:
    async with session_factory() as session:
        user = User(
            oidc_subject=oidc_subject,
            email=f"{oidc_subject}@example.com",
            role=Role.HMS_ADMIN.value,
            email_verified=True,
        )
        session.add(user)
        await session.commit()
        return user


@pytest.mark.asyncio
async def test_preferences_use_persisted_user_id_not_oidc_subject(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user = await seed_user(session_factory)

    async with notifications_client(session_factory) as client:
        response = await client.put(
            "/api/v1/notifications/preferences",
            json={
                "category": NotificationCategory.CERTIFICATE_ISSUED.value,
                "channel": NotificationChannel.EMAIL.value,
                "opted_in": False,
            },
        )

    assert response.status_code == 200
    async with session_factory() as session:
        pref = (
            await session.scalars(select(NotificationPreference))
        ).one()
    assert pref.party_type == RecipientType.USER.value
    assert pref.party_id == user.id
    assert pref.party_id != user.oidc_subject


@pytest.mark.asyncio
async def test_phone_verification_updates_user_resolved_from_oidc_subject(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user = await seed_user(session_factory)

    async with notifications_client(session_factory) as client:
        request_response = await client.post(
            "/api/v1/notifications/phone/verify/request",
            json={"phone_e164": "+61400000000"},
        )
        code_match = re.search(r"dev code: (\d{6})", request_response.json()["message"])
        assert code_match is not None
        confirm_response = await client.post(
            "/api/v1/notifications/phone/verify/confirm",
            json={"code": code_match.group(1)},
        )

    assert request_response.status_code == 200
    assert confirm_response.status_code == 200
    async with session_factory() as session:
        refreshed = await session.get(User, user.id)
        verification = (await session.scalars(select(PhoneVerification))).one()
    assert refreshed is not None
    assert refreshed.phone_e164 == "+61400000000"
    assert refreshed.phone_verified is True
    assert verification.party_id == user.id


@pytest.mark.asyncio
async def test_my_notifications_reads_rows_for_persisted_user_id(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user = await seed_user(session_factory)
    async with session_factory() as session:
        session.add(
            Notification(
                event_ref="event-1",
                category=NotificationCategory.CERTIFICATE_ISSUED.value,
                tier=NotificationTier.IMPORTANT.value,
                recipient_type=RecipientType.USER.value,
                recipient_id=user.id,
                recipient_address=user.email,
                channel=NotificationChannel.EMAIL.value,
                template_key="certificate_issued.email",
                subject="Certificate issued",
                body="Certificate CERT-1 is ready.",
                status=NotificationStatus.SENT.value,
                idempotency_key="a" * 64,
            )
        )
        await session.commit()

    async with notifications_client(session_factory) as client:
        response = await client.get("/api/v1/notifications/me")

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert body["items"][0]["recipient_id"] == user.id
