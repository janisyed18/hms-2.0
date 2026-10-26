from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

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
        user_id = create_response.json()["user"]["id"]
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
            "user.customer_access_granted",
            "user.deleted",
        ]
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_user_responses_carry_account_security_state(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The Staff UI renders these fields, so a disable must read back as DISABLED."""
    await seed_user(session_factory)
    async with session_factory() as session:
        session.add(
            User(
                oidc_subject="enrolled-1",
                email="enrolled@example.com",
                role=Role.INSPECTOR.value,
                mfa_enabled=True,
                last_login_at=datetime(2026, 1, 2, 3, 4, tzinfo=UTC),
            )
        )
        await session.commit()

    async with admin_client(session_factory) as client:
        listed = (
            await client.get("/api/v1/admin/users", params={"search": "enrolled"})
        ).json()["items"][0]
        disabled = await client.post(f"/api/v1/admin/users/{listed['id']}/disable")
        relisted = (
            await client.get("/api/v1/admin/users", params={"search": "enrolled"})
        ).json()["items"][0]

    assert listed["mfa_enabled"] is True
    assert listed["last_login_at"] is not None
    assert listed["account_status"] == "ACTIVE"
    assert disabled.status_code == 200
    assert disabled.json()["account_status"] == "DISABLED"
    assert relisted["account_status"] == "DISABLED"


@pytest.mark.asyncio
async def test_customer_user_can_hold_multiple_persisted_customer_scopes(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await seed_user(session_factory)
    async with session_factory() as session:
        customer_a = Customer(code="CUSA", name="Customer A")
        customer_b = Customer(code="CUSB", name="Customer B")
        session.add_all([customer_a, customer_b])
        await session.commit()

    async with admin_client(session_factory) as client:
        response = await client.post(
            "/api/v1/admin/users",
            json={
                "oidc_subject": "customer-multi",
                "email": "customer-multi@example.com",
                "role": "CUSTOMER_USER",
                "customer_ids": [customer_a.id, customer_b.id],
            },
        )

    assert response.status_code == 201
    assert response.json()["user"]["customer_id"] == customer_a.id
    assert response.json()["user"]["customer_ids"] == [customer_a.id, customer_b.id]

    async with admin_client(session_factory, user_id="customer-multi") as client:
        me_response = await client.get("/api/v1/auth/me")

    assert me_response.status_code == 200
    assert me_response.json()["customer_ids"] == [customer_a.id, customer_b.id]


@pytest.mark.asyncio
async def test_customer_scope_can_be_revoked_and_granted_again(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await seed_user(session_factory)
    async with session_factory() as session:
        customer_a = Customer(code="REG-A", name="Regrant Customer A")
        customer_b = Customer(code="REG-B", name="Regrant Customer B")
        session.add_all([customer_a, customer_b])
        await session.commit()

    async with admin_client(session_factory) as client:
        created = await client.post(
            "/api/v1/admin/users",
            json={
                "oidc_subject": "customer-regrant",
                "email": "customer-regrant@example.com",
                "role": "CUSTOMER_USER",
                "customer_ids": [customer_a.id, customer_b.id],
            },
        )
        user_id = created.json()["user"]["id"]
        revoked = await client.patch(
            f"/api/v1/admin/users/{user_id}",
            json={"customer_ids": [customer_a.id]},
        )
        regranted = await client.patch(
            f"/api/v1/admin/users/{user_id}",
            json={"customer_ids": [customer_a.id, customer_b.id]},
        )

    assert created.status_code == 201
    assert revoked.status_code == 200
    assert regranted.status_code == 200
    assert regranted.json()["customer_ids"] == [customer_a.id, customer_b.id]

    async with admin_client(session_factory, user_id="customer-regrant") as client:
        me_response = await client.get("/api/v1/auth/me")

    assert me_response.status_code == 200
    assert me_response.json()["customer_ids"] == [customer_a.id, customer_b.id]


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


async def seed_inspectors(
    session_factory: async_sessionmaker[AsyncSession], count: int
) -> list[User]:
    return [
        await seed_user(
            session_factory,
            oidc_subject=f"keyset-{index:03d}",
            email=f"user-{index:03d}@example.com",
            role=Role.INSPECTOR,
        )
        for index in range(count)
    ]


async def page(
    client: httpx.AsyncClient, **params: str | int
) -> dict[str, Any]:
    response = await client.get(
        "/api/v1/admin/users", params={"sort": "id", "limit": 4, **params}
    )
    assert response.status_code == 200
    body: dict[str, Any] = response.json()
    return body


async def walk(client: httpx.AsyncClient, **params: str | int) -> list[str]:
    seen: list[str] = []
    cursor: str | None = None
    for _ in range(20):
        body = await page(
            client, **params, **({"after": cursor} if cursor is not None else {})
        )
        seen += [item["id"] for item in body["items"]]
        cursor = body["next_after"]
        if cursor is None:
            return seen
    raise AssertionError("walk did not end")


async def update_user(
    session_factory: async_sessionmaker[AsyncSession], user_id: str, **values: Any
) -> None:
    async with session_factory() as session:
        user = await session.get(User, user_id)
        assert user is not None
        for key, value in values.items():
            setattr(user, key, value)
        await session.commit()


@pytest.mark.asyncio
async def test_user_list_keyset_cursor_walks_every_user_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = await seed_user(session_factory, email="aaa-admin@example.com")
    users = [admin, *await seed_inspectors(session_factory, 7)]

    async with admin_client(session_factory) as client:
        seen = await walk(client, limit=3)

    assert seen == sorted(user.id for user in users)


@pytest.mark.asyncio
async def test_user_list_keyset_last_full_page_ends_the_walk(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await seed_user(session_factory, email="aaa-admin@example.com")
    await seed_inspectors(session_factory, 5)  # 6 users: two full pages of 3

    async with admin_client(session_factory) as client:
        first = await page(client, limit=3)
        second = await page(client, limit=3, after=first["next_after"])

    assert first["next_after"] is not None
    assert len(second["items"]) == 3
    assert second["next_after"] is None


@pytest.mark.asyncio
async def test_user_list_keyset_survives_removal_of_read_and_cursor_users(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = await seed_user(session_factory, email="aaa-admin@example.com")
    users = [admin, *await seed_inspectors(session_factory, 5)]
    ids = sorted(user.id for user in users)

    async with admin_client(session_factory) as client:
        first = await page(client)
        assert [item["id"] for item in first["items"]] == ids[:4]
        # Soft-delete an already-read user and the cursor user between pages.
        for user_id in (ids[1], ids[3]):
            await update_user(session_factory, user_id, deleted_at=datetime.now(UTC))
        rest = await page(client, after=first["next_after"])

    assert [item["id"] for item in rest["items"]] == ids[4:]


@pytest.mark.asyncio
async def test_user_list_keyset_ignores_email_edits_between_pages(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = await seed_user(session_factory, email="aaa-admin@example.com")
    users = [admin, *await seed_inspectors(session_factory, 7)]
    ids = sorted(user.id for user in users)
    by_id = {user.id: user for user in users}

    async with admin_client(session_factory) as client:
        first = await page(client)
        read, unread = ids[0], ids[6]
        cursor_email = by_id[ids[3]].email
        # An unread user's email moves from after the cursor's to before it, and an
        # already-read user's moves past it; neither may change what is returned.
        await update_user(session_factory, unread, email="0-first@example.com")
        await update_user(session_factory, read, email="zzz-last@example.com")
        assert cursor_email > "0-first@example.com"
        rest = await page(client, after=first["next_after"], limit=10)

    returned = [item["id"] for item in first["items"]] + [
        item["id"] for item in rest["items"]
    ]
    assert returned == ids


@pytest.mark.asyncio
async def test_user_list_keyset_includes_users_created_mid_walk_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = await seed_user(session_factory, email="aaa-admin@example.com")
    users = [admin, *await seed_inspectors(session_factory, 5)]

    async with admin_client(session_factory) as client:
        first = await page(client)
        await asyncio.sleep(0.01)  # UUIDv7 ids are time-ordered
        late = await seed_user(
            session_factory, oidc_subject="late", email="0-late@example.com"
        )
        rest = await walk_after(client, first["next_after"])

    returned = [item["id"] for item in first["items"]] + rest
    assert sorted(returned) == sorted([*(u.id for u in users), late.id])
    assert len(set(returned)) == len(returned)


async def walk_after(client: httpx.AsyncClient, cursor: str | None) -> list[str]:
    seen: list[str] = []
    for _ in range(20):
        if cursor is None:
            return seen
        body = await page(client, after=cursor)
        seen += [item["id"] for item in body["items"]]
        cursor = body["next_after"]
    raise AssertionError("walk did not end")


@pytest.mark.asyncio
async def test_user_list_offset_paging_is_unchanged_without_a_cursor(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await seed_user(session_factory, email="aaa-admin@example.com")
    await seed_inspectors(session_factory, 4)

    async with admin_client(session_factory) as client:
        body = (
            await client.get("/api/v1/admin/users", params={"limit": 2, "offset": 2})
        ).json()
        by_email = (
            await client.get(
                "/api/v1/admin/users", params={"sort": "email", "limit": 2}
            )
        ).json()

    assert [item["email"] for item in body["items"]] == [
        "user-001@example.com",
        "user-002@example.com",
    ]
    assert body["offset"] == 2
    assert by_email["next_after"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "params",
    [
        {"after": "x", "sort": "id", "offset": 1},
        {"after": "x", "sort": "-id"},
        {"after": "x", "sort": "email"},
        {"after": "x"},
    ],
)
async def test_user_list_cursor_rejects_unresumable_orderings(
    session_factory: async_sessionmaker[AsyncSession], params: dict[str, str | int]
) -> None:
    await seed_user(session_factory)

    async with admin_client(session_factory) as client:
        response = await client.get("/api/v1/admin/users", params=params)

    assert response.status_code == 400
