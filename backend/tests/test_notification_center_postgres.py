"""Marking notifications read under real PostgreSQL: scope, idempotence and overlap."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.rbac import Role
from hms_backend.app.main import create_app
from hms_backend.app.modules.identity.models import User
from hms_backend.app.modules.notifications.enums import (
    NotificationCategory,
    NotificationChannel,
    NotificationStatus,
    NotificationTier,
    RecipientType,
)
from hms_backend.app.modules.notifications.models import Notification

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)


@pytest_asyncio.fixture
async def database() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert POSTGRES_URL is not None
    if not POSTGRES_URL.startswith("postgresql+asyncpg://"):
        raise ValueError("These tests require a dedicated async PostgreSQL database")
    name = make_url(POSTGRES_URL).database
    if name is None or not name.endswith("_test"):
        raise ValueError("These tests require a database name ending in _test")
    engine = create_async_engine(POSTGRES_URL, pool_size=8)
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


@asynccontextmanager
async def client_for(
    database: async_sessionmaker[AsyncSession], subject: str
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with database() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"X-HMS-User-Id": subject},
    ) as client:
        yield client


async def make_user(
    database: async_sessionmaker[AsyncSession], unread: int
) -> tuple[str, str]:
    subject = f"center-{uuid4().hex[:10]}"
    async with database() as session:
        user = User(
            oidc_subject=subject,
            email=f"{subject}@example.com",
            role=Role.HMS_ADMIN.value,
            email_verified=True,
        )
        session.add(user)
        await session.flush()
        for _ in range(unread):
            session.add(
                Notification(
                    event_ref=uuid4().hex,
                    category=NotificationCategory.INSPECTION_SUBMITTED.value,
                    tier=NotificationTier.IMPORTANT.value,
                    recipient_type=RecipientType.USER.value,
                    recipient_id=user.id,
                    channel=NotificationChannel.IN_APP.value,
                    template_key="t",
                    subject="s",
                    body="b",
                    status=NotificationStatus.SENT.value,
                    idempotency_key=uuid4().hex + uuid4().hex,
                    created_at=datetime.now(UTC),
                )
            )
        await session.commit()
        return subject, user.id


async def unread_count(database: async_sessionmaker[AsyncSession], user_id: str) -> int:
    async with database() as session:
        return int(
            await session.scalar(
                select(func.count())
                .select_from(Notification)
                .where(
                    Notification.recipient_id == user_id,
                    Notification.read_at.is_(None),
                )
            )
            or 0
        )


@pytest.mark.asyncio
async def test_two_overlapping_read_alls_change_each_notification_once(
    database: async_sessionmaker[AsyncSession],
) -> None:
    subject, user_id = await make_user(database, unread=25)

    async def read_all() -> int:
        async with client_for(database, subject) as client:
            response = await client.post("/api/v1/notifications/me/read-all")
            assert response.status_code == 200, response.text
            return int(response.json()["updated"])

    async with asyncio.TaskGroup() as group:
        first = group.create_task(read_all())
        second = group.create_task(read_all())
    assert sorted([first.result(), second.result()]) == [0, 25]
    assert await unread_count(database, user_id) == 0


@pytest.mark.asyncio
async def test_read_all_never_touches_another_users_notifications(
    database: async_sessionmaker[AsyncSession],
) -> None:
    mine, my_id = await make_user(database, unread=3)
    _, theirs_id = await make_user(database, unread=4)
    async with client_for(database, mine) as client:
        done = await client.post("/api/v1/notifications/me/read-all")
        again = await client.post("/api/v1/notifications/me/read-all")
    assert done.json() == {"updated": 3, "unread_total": 0}
    assert again.json() == {"updated": 0, "unread_total": 0}
    assert await unread_count(database, my_id) == 0
    assert await unread_count(database, theirs_id) == 4


@pytest.mark.asyncio
async def test_read_all_takes_every_notification_in_one_request_beyond_one_batch(
    database: async_sessionmaker[AsyncSession],
) -> None:
    subject, user_id = await make_user(database, unread=1203)
    async with client_for(database, subject) as client:
        done = await client.post("/api/v1/notifications/me/read-all")
        again = await client.post("/api/v1/notifications/me/read-all")
    assert done.status_code == 200, done.text
    assert done.json() == {"updated": 1203, "unread_total": 0}
    assert again.json() == {"updated": 0, "unread_total": 0}
    assert await unread_count(database, user_id) == 0
