"""Sync device registration: ownership and revocation (SQLite, sequential)."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.models.foundation import Device
from hms_backend.app.modules.identity import models as _identity_models  # noqa: F401
from hms_backend.app.modules.notifications.models import OutboxEvent
from hms_backend.app.modules.notifications.outbox import bounded_aggregate_id

DEVICE = "inspector-browser-2f1c5a9e-6b1d-4c1e-9a5e-0d5c3b7e8f10"  # 54 characters


@pytest_asyncio.fixture
async def factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@asynccontextmanager
async def _client(
    factory: async_sessionmaker[AsyncSession], user_id: str
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with factory() as session:
            yield session

    principal = Principal(
        user_id=user_id, roles=frozenset({Role.HMS_ADMIN}), customer_ids=frozenset()
    )
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_principal] = lambda: principal
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        yield client


def _headers(
    device_id: str = DEVICE, platform: str = "web", app_version: str = "1.0.0"
) -> dict[str, str]:
    return {
        "X-HMS-Device-Id": device_id,
        "X-HMS-Device-Platform": platform,
        "X-HMS-App-Version": app_version,
    }


async def _device(factory: async_sessionmaker[AsyncSession]) -> Device:
    async with factory() as session:
        device = await session.get(Device, DEVICE)
        assert device is not None
        return device


async def _registered_events(factory: async_sessionmaker[AsyncSession]) -> int:
    async with factory() as session:
        return int(
            await session.scalar(
                select(func.count())
                .select_from(OutboxEvent)
                .where(
                    OutboxEvent.event_type == "DEVICE_REGISTERED",
                    OutboxEvent.aggregate_id == bounded_aggregate_id(DEVICE),
                )
            )
            or 0
        )


@pytest.mark.asyncio
async def test_a_device_cannot_be_taken_over_by_another_user(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    async with _client(factory, "user-a") as a:
        first = await a.get("/api/v1/sync/changes", headers=_headers())
    assert first.status_code == 200
    registered = await _device(factory)

    async with _client(factory, "user-b") as b:
        stolen = await b.get(
            "/api/v1/sync/changes",
            headers=_headers(platform="android", app_version="9.9.9"),
        )

    assert stolen.status_code == 403
    assert stolen.json()["detail"] == "Sync device is registered to another user"
    after = await _device(factory)
    # Ownership and every other field are exactly as the owner left them.
    assert (after.user_id, after.platform, after.app_version, after.last_sync_at) == (
        registered.user_id,
        registered.platform,
        registered.app_version,
        registered.last_sync_at,
    )
    assert await _registered_events(factory) == 1


@pytest.mark.asyncio
async def test_the_owner_can_keep_syncing_and_updating_metadata(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    async with _client(factory, "user-a") as a:
        first = await a.get("/api/v1/sync/changes", headers=_headers())
        second = await a.get(
            "/api/v1/sync/changes",
            headers=_headers(platform="android", app_version="2.0.0"),
        )

    assert first.status_code == second.status_code == 200
    device = await _device(factory)
    assert (device.user_id, device.platform, device.app_version) == (
        "user-a",
        "android",
        "2.0.0",
    )
    assert await _registered_events(factory) == 1  # only the first request registers


@pytest.mark.asyncio
async def test_a_revoked_device_is_refused_and_not_updated(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    async with _client(factory, "user-a") as a:
        assert (
            await a.get("/api/v1/sync/changes", headers=_headers())
        ).status_code == 200
        async with factory() as session:
            device = await session.get(Device, DEVICE)
            assert device is not None
            device.revoked = True
            await session.commit()
        before = await _device(factory)

        refused = await a.get(
            "/api/v1/sync/changes", headers=_headers(app_version="3.0.0")
        )

    assert refused.status_code == 403
    assert refused.json()["detail"] == "Sync device has been revoked"
    after = await _device(factory)
    assert after.app_version == before.app_version == "1.0.0"
    assert after.last_sync_at == before.last_sync_at


@pytest.mark.asyncio
async def test_a_non_owner_gets_the_ownership_error_not_the_revocation_state(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    async with _client(factory, "user-a") as a:
        await a.get("/api/v1/sync/changes", headers=_headers())
    async with factory() as session:
        device = await session.get(Device, DEVICE)
        assert device is not None
        device.revoked = True
        await session.commit()

    async with _client(factory, "user-b") as b:
        response = await b.get("/api/v1/sync/changes", headers=_headers())

    assert response.status_code == 403
    assert response.json()["detail"] == "Sync device is registered to another user"
