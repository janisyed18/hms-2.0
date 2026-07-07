from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.audit import verify_audit_chain
from hms_backend.app.core.rbac import Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.models.foundation import AuditEvent, Device
from hms_backend.app.modules.customers.models import Customer
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
async def admin_client(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_id: str | None = "staff-ui-dev",
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session

    headers = {"X-HMS-User-Id": user_id} if user_id is not None else {}
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
    oidc_subject: str = "staff-ui-dev",
    email: str = "staff@example.com",
    role: Role = Role.HMS_ADMIN,
    customer_id: str | None = None,
    deleted: bool = False,
) -> User:
    async with session_factory() as session:
        user = User(
            oidc_subject=oidc_subject,
            email=email,
            first_name="Staff",
            last_name="User",
            role=role.value,
            customer_id=customer_id,
            deleted_at=datetime.now(UTC) if deleted else None,
        )
        session.add(user)
        await session.commit()
        return user


@pytest.mark.asyncio
async def test_principal_uses_persisted_user_role_without_role_header(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await seed_user(session_factory)

    async with admin_client(session_factory) as client:
        response = await client.get("/api/v1/admin/users")

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert body["items"][0]["oidc_subject"] == "staff-ui-dev"
    assert body["items"][0]["role"] == "HMS_ADMIN"


@pytest.mark.asyncio
async def test_principal_rejects_deleted_user_and_forbids_customer_user(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await seed_user(
        session_factory,
        oidc_subject="deleted-user",
        email="deleted@example.com",
        deleted=True,
    )
    await seed_user(
        session_factory,
        oidc_subject="customer-user",
        email="customer@example.com",
        role=Role.CUSTOMER_USER,
    )

    async with admin_client(session_factory, user_id="deleted-user") as client:
        deleted_response = await client.get("/api/v1/admin/users")
    async with admin_client(session_factory, user_id="customer-user") as client:
        forbidden_response = await client.get("/api/v1/admin/users")

    assert deleted_response.status_code == 401
    assert deleted_response.json()["error"]["code"] == "unauthorized"
    assert forbidden_response.status_code == 403
    assert forbidden_response.json()["error"]["code"] == "forbidden"


@pytest.mark.asyncio
async def test_admin_user_crud_writes_audit_events(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await seed_user(session_factory)
    async with session_factory() as session:
        customer = Customer(code="VOPA", name="Vopak")
        session.add(customer)
        await session.commit()
        customer_id = customer.id

    async with admin_client(session_factory) as client:
        create_response = await client.post(
            "/api/v1/admin/users",
            json={
                "oidc_subject": "inspector-1",
                "email": "inspector@example.com",
                "first_name": "Ivy",
                "last_name": "Inspector",
                "role": "INSPECTOR",
                "customer_id": None,
            },
        )
        user_id = create_response.json()["id"]
        list_response = await client.get(
            "/api/v1/admin/users",
            params={"search": "inspector", "sort": "-email"},
        )
        update_response = await client.patch(
            f"/api/v1/admin/users/{user_id}",
            json={"role": "CUSTOMER_USER", "customer_id": customer_id},
        )
        delete_response = await client.delete(f"/api/v1/admin/users/{user_id}")

    assert create_response.status_code == 201
    assert list_response.status_code == 200
    assert [item["email"] for item in list_response.json()["items"]] == [
        "inspector@example.com"
    ]
    assert update_response.status_code == 200
    assert update_response.json()["role"] == "CUSTOMER_USER"
    assert update_response.json()["customer_id"] == customer_id
    assert delete_response.status_code == 204

    async with session_factory() as session:
        events = (
            await session.scalars(select(AuditEvent).order_by(AuditEvent.sequence))
        ).all()
        assert [event.action for event in events] == [
            "user.created",
            "user.updated",
            "user.deleted",
        ]
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_admin_devices_and_audit_filters(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await seed_user(session_factory)
    async with session_factory() as session:
        session.add_all(
            [
                Device(
                    device_id="field-tablet-01",
                    user_id="inspector-1",
                    platform="ios",
                    app_version="26.4.1",
                    offline_window_days=7,
                    revoked=False,
                ),
                Device(
                    device_id="field-tablet-02",
                    user_id="inspector-2",
                    platform="android",
                    app_version="26.4.0",
                    offline_window_days=5,
                    revoked=False,
                ),
            ]
        )
        await session.commit()

    async with admin_client(session_factory) as client:
        list_response = await client.get(
            "/api/v1/admin/devices",
            params={"search": "tablet", "sort": "device_id"},
        )
        update_response = await client.patch(
            "/api/v1/admin/devices/field-tablet-01",
            json={"revoked": True, "offline_window_days": 3},
        )
        audit_response = await client.get(
            "/api/v1/admin/audit-events",
            params={"entity": "Device", "search": "field-tablet-01"},
        )

    assert list_response.status_code == 200
    assert [item["device_id"] for item in list_response.json()["items"]] == [
        "field-tablet-01",
        "field-tablet-02",
    ]
    assert update_response.status_code == 200
    assert update_response.json()["revoked"] is True
    assert update_response.json()["offline_window_days"] == 3
    assert audit_response.status_code == 200
    assert audit_response.json()["items"][0]["action"] == "device.updated"
    assert audit_response.json()["items"][0]["entity_id"] == "field-tablet-01"


@pytest.mark.asyncio
async def test_admin_error_envelope_for_missing_identity(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with admin_client(session_factory, user_id=None) as client:
        response = await client.get("/api/v1/admin/users")

    assert response.status_code == 401
    payload = response.json()
    assert payload["detail"] == "Missing HMS user identity"
    assert payload["error"] == {
        "code": "unauthorized",
        "message": "Missing HMS user identity",
        "details": None,
    }
