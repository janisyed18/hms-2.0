"""Customer, location, contact, user and catalog lifecycle rules.

Destructive Delete is Super Admin only; a customer always keeps one location; a
customer is archived (reversible) before it can be deleted.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.audit import verify_audit_chain
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base, utc_now
from hms_backend.app.models.foundation import AuditEvent, SyncChange
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.customers.models import (
    Customer,
    CustomerContact,
    CustomerLocation,
    CustomerLocationContact,
)
from hms_backend.app.modules.identity.models import (
    BrowserRefreshSession,
    User,
)
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionAppointment,
    InspectionAppointmentRevision,
    InspectionBooking,
    InspectionBookingAsset,
    InspectionResourceAllocation,
)
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.reference.models import Material, Standard
from hms_backend.app.modules.scheduling.models import RetestSchedule

ADMIN = Principal(
    user_id="admin-1", roles=frozenset({Role.HMS_ADMIN}), customer_ids=frozenset()
)
SUPER = Principal(
    user_id="super-1", roles=frozenset({Role.SUPER_ADMIN}), customer_ids=frozenset()
)
LOCATION = {"name": "Head office"}


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@asynccontextmanager
async def client_for(
    session_factory: async_sessionmaker[AsyncSession], principal: Principal
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    async def override_principal() -> Principal:
        return principal

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_principal] = override_principal
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        yield client


async def _customer_with_locations(
    session_factory: async_sessionmaker[AsyncSession], *names: str
) -> tuple[str, list[str]]:
    async with session_factory() as session:
        customer = Customer(code="ACME", name="Acme")
        locations = [CustomerLocation(customer=customer, name=n) for n in names]
        session.add_all([customer, *locations])
        await session.commit()
        return customer.id, [location.id for location in locations]


# --- customer creation needs a location --------------------------------------


@pytest.mark.asyncio
async def test_customer_create_rejects_zero_locations(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with client_for(session_factory, ADMIN) as client:
        missing = await client.post("/api/v1/customers", json={"name": "No Site"})
        empty = await client.post(
            "/api/v1/customers", json={"name": "No Site", "locations": []}
        )
        created = await client.post(
            "/api/v1/customers", json={"name": "One Site", "locations": [LOCATION]}
        )

    assert missing.status_code == 422
    assert empty.status_code == 422
    assert created.status_code == 201
    assert [item["name"] for item in created.json()["locations"]] == ["Head office"]
    async with session_factory() as session:
        names = (await session.scalars(select(Customer.name))).all()
    assert list(names) == ["One Site"]


@pytest.mark.asyncio
async def test_first_location_keeps_its_address(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Add customer sends the first location's address; it is stored, not refused."""
    location = {
        **LOCATION,
        "address_1": "1 Innovation Drive",
        "address_2": "Level 2",
        "city": "Bella Vista",
        "state": "NSW",
        "country": "Australia",
    }
    async with client_for(session_factory, ADMIN) as client:
        created = await client.post(
            "/api/v1/customers", json={"name": "Addressed", "locations": [location]}
        )

    assert created.status_code == 201
    stored = created.json()["locations"][0]
    assert stored["address_1"] == "1 Innovation Drive"
    assert stored["city"] == "Bella Vista"
    assert stored["country"] == "Australia"


# --- locations ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_final_location_cannot_be_deleted_even_by_super_admin(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    customer_id, (only,) = await _customer_with_locations(session_factory, "Only")
    async with client_for(session_factory, SUPER) as client:
        response = await client.delete(
            f"/api/v1/customers/{customer_id}/locations/{only}"
        )

    assert response.status_code == 409
    assert response.json()["detail"] == (
        "A customer must have at least one location. "
        "Add another location before deleting this one."
    )


@pytest.mark.asyncio
async def test_only_super_admin_deletes_an_eligible_location(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    customer_id, (first, second) = await _customer_with_locations(
        session_factory, "Alpha", "Beta"
    )
    url = f"/api/v1/customers/{customer_id}/locations/{second}"
    async with client_for(session_factory, ADMIN) as client:
        forbidden = await client.delete(url)
    async with client_for(session_factory, SUPER) as client:
        deleted = await client.delete(url)
        customer = await client.get(f"/api/v1/customers/{customer_id}")

    assert forbidden.status_code == 403
    assert deleted.status_code == 204
    assert [item["id"] for item in customer.json()["locations"]] == [first]


@pytest.mark.asyncio
async def test_deleting_a_location_takes_its_own_contacts_with_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A site contact belongs to its location, so it is not work that blocks the delete.

    It is tombstoned alongside, and both tombstones are auditable and syncable.
    """
    customer_id, (first, second) = await _customer_with_locations(
        session_factory, "Alpha", "Beta"
    )
    async with session_factory() as session:
        session.add_all(
            [
                CustomerLocationContact(
                    location_id=second, name="Site Person", phone="+61 400 000 000"
                ),
                CustomerLocationContact(
                    location_id=second, name="Night Shift", phone="+61 400 000 001"
                ),
            ]
        )
        await session.commit()

    async with client_for(session_factory, SUPER) as client:
        deleted = await client.delete(
            f"/api/v1/customers/{customer_id}/locations/{second}"
        )
        customer = await client.get(f"/api/v1/customers/{customer_id}")

    assert deleted.status_code == 204
    assert [item["id"] for item in customer.json()["locations"]] == [first]

    async with session_factory() as session:
        location = await session.get(CustomerLocation, second)
        assert location is not None
        assert location.deleted_at is not None
        contacts = (
            await session.scalars(
                select(CustomerLocationContact).where(
                    CustomerLocationContact.location_id == second
                )
            )
        ).all()
        # Nothing is hard-deleted: both contacts stay as tombstones.
        assert len(contacts) == 2
        assert all(contact.deleted_at is not None for contact in contacts)
        assert all(contact.version == 2 for contact in contacts)

        audited = {
            (event.entity, event.entity_id)
            for event in (await session.scalars(select(AuditEvent))).all()
            if event.action
            in {"customer_location.deleted", "customer_location_contact.deleted"}
        }
        synced = {
            (change.entity, change.entity_id)
            for change in (await session.scalars(select(SyncChange))).all()
            if change.op == "delete"
        }
        expected = {("CustomerLocation", second)} | {
            ("CustomerLocationContact", contact.id) for contact in contacts
        }
        assert expected <= audited
        assert expected <= synced
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_location_in_use_is_not_deleted_and_history_survives(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    customer_id, (used, spare) = await _customer_with_locations(
        session_factory, "Used", "Spare"
    )
    async with session_factory() as session:
        product = Product(category="Hose", code="P1", name="P1")
        session.add(product)
        session.add(
            Asset(
                customer_id=customer_id,
                location_id=used,
                product=product,
                asset_number="A-1",
                customer_serial_no="SN-1",
                tag="HMS-A-1",
                lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
            )
        )
        await session.commit()

    async with client_for(session_factory, SUPER) as client:
        blocked = await client.delete(
            f"/api/v1/customers/{customer_id}/locations/{used}"
        )

    assert blocked.status_code == 409
    assert "1 assets" in blocked.json()["detail"]
    async with session_factory() as session:
        location = await session.get(CustomerLocation, used)
        assert location is not None
        assert location.deleted_at is None
        assert spare


@pytest.mark.asyncio
async def test_location_add_edit_and_scheduling_round_trip(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    customer_id, _ = await _customer_with_locations(session_factory, "Alpha")
    async with client_for(session_factory, ADMIN) as client:
        created = await client.post(
            f"/api/v1/customers/{customer_id}/locations",
            json={
                "name": "Port",
                "address_1": "1 Quay St",
                "city": "Sydney",
                "state": "NSW",
                "country": "AU",
                "scheduling_timezone": "Australia/Sydney",
                "scheduling_open_time": "07:00",
                "scheduling_close_time": "15:30",
                "scheduling_weekdays": [0, 1, 2],
                "scheduling_blackout_dates": ["2027-01-26"],
            },
        )
        bad_zone = await client.post(
            f"/api/v1/customers/{customer_id}/locations",
            json={"name": "Bad", "scheduling_timezone": "Mars/Phobos"},
        )
        edited = await client.patch(
            f"/api/v1/customers/{customer_id}/locations/{created.json()['id']}",
            json={"city": "Newcastle"},
        )

    assert created.status_code == 201
    assert bad_zone.status_code == 422
    assert edited.json()["city"] == "Newcastle"
    assert edited.json()["scheduling_timezone"] == "Australia/Sydney"
    assert edited.json()["scheduling_close_time"] == "15:30"


# --- contacts ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_contact_crud_with_super_admin_only_delete(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    customer_id, _ = await _customer_with_locations(session_factory, "Alpha")
    async with client_for(session_factory, ADMIN) as client:
        created = await client.post(
            f"/api/v1/customers/{customer_id}/contacts",
            json={
                "name": "Pat",
                "email": "pat@example.com",
                "receives_retest_reminders": False,
            },
        )
        contact_id = created.json()["id"]
        edited = await client.patch(
            f"/api/v1/customers/{customer_id}/contacts/{contact_id}",
            json={"receives_retest_reminders": True},
        )
        forbidden = await client.delete(
            f"/api/v1/customers/{customer_id}/contacts/{contact_id}"
        )
    async with client_for(session_factory, SUPER) as client:
        deleted = await client.delete(
            f"/api/v1/customers/{customer_id}/contacts/{contact_id}"
        )

    assert created.status_code == 201
    assert created.json()["receives_retest_reminders"] is False
    assert edited.json()["receives_retest_reminders"] is True
    assert forbidden.status_code == 403
    assert deleted.status_code == 204
    async with session_factory() as session:
        contact = await session.get(CustomerContact, contact_id)
    assert contact is not None
    assert contact.deleted_at is not None


# --- customer archive / restore / delete -------------------------------------


async def _delete_customer(
    client: httpx.AsyncClient,
    customer_id: str,
    *,
    name: str = "Acme",
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    """Delete with history the way the UI does: preview first, then confirm."""
    check = await client.get(f"/api/v1/customers/{customer_id}/deletion-check")
    fingerprint = check.json()["fingerprint"] if check.status_code == 200 else "0" * 64
    return await client.post(
        f"/api/v1/customers/{customer_id}/delete-with-history",
        json={"confirm_name": name, "impact_fingerprint": fingerprint},
        headers=headers,
    )


@pytest.mark.asyncio
async def test_customer_archive_restore_delete_lifecycle(
    customer_deletion_enabled: None,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    customer_id, (location_id,) = await _customer_with_locations(
        session_factory, "Alpha"
    )
    async with client_for(session_factory, ADMIN) as client:
        admin_archive = await client.post(f"/api/v1/customers/{customer_id}/archive")
        admin_delete = await _delete_customer(client, customer_id)
    async with client_for(session_factory, SUPER) as client:
        archived = await client.post(f"/api/v1/customers/{customer_id}/archive")
        archived_twice = await client.post(f"/api/v1/customers/{customer_id}/archive")
        active_list = await client.get("/api/v1/customers")
        archived_list = await client.get(
            "/api/v1/customers", params={"lifecycle": "archived"}
        )
        new_location = await client.post(
            f"/api/v1/customers/{customer_id}/locations", json={"name": "Extra"}
        )
        restored = await client.post(f"/api/v1/customers/{customer_id}/restore")
        restored_twice = await client.post(f"/api/v1/customers/{customer_id}/restore")
        back_in_list = await client.get("/api/v1/customers")
        archived_again = await client.post(f"/api/v1/customers/{customer_id}/archive")
        deleted = await _delete_customer(client, customer_id)

    assert admin_archive.status_code == 403
    assert admin_delete.status_code == 403
    assert archived.status_code == 200
    assert archived.json()["status"] == "ARCHIVED"
    assert archived_twice.status_code == 409
    assert active_list.json()["total"] == 0
    assert [item["id"] for item in archived_list.json()["items"]] == [customer_id]
    assert new_location.status_code == 409
    assert restored.json()["status"] == "ACTIVE"
    assert restored.json()["archived_at"] is None
    assert restored_twice.status_code == 409
    assert back_in_list.json()["total"] == 1
    assert archived_again.status_code == 200
    assert deleted.status_code == 200
    async with session_factory() as session:
        customer = await session.get(Customer, customer_id)
        location = await session.get(CustomerLocation, location_id)
    assert customer is not None and customer.deleted_at is not None
    # Owned records leave active HMS, but only after the archive was written; rows
    # are never physically removed.
    assert location is not None and location.deleted_at is not None


async def _audit_actions(
    session_factory: async_sessionmaker[AsyncSession], action: str
) -> int:
    async with session_factory() as session:
        return (
            await session.scalar(
                select(func.count())
                .select_from(AuditEvent)
                .where(AuditEvent.action == action)
            )
            or 0
        )


@pytest.mark.asyncio
async def test_unused_active_customer_is_deleted_in_one_step_without_archiving(
    customer_deletion_enabled: None,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    customer_id, _ = await _customer_with_locations(session_factory, "Alpha")
    async with client_for(session_factory, SUPER) as client:
        check = await client.get(f"/api/v1/customers/{customer_id}/deletion-check")
        deleted = await _delete_customer(client, customer_id)
        again = await client.get(f"/api/v1/customers/{customer_id}/deletion-check")

    assert check.status_code == 200
    body = check.json()
    assert body["can_delete"] is True and body["archived"] is False
    assert body["blockers"] == []
    assert body["impact"]["total_records"] == 1  # the one location
    assert deleted.status_code == 200
    assert deleted.json()["status"] == "COMPLETED"
    assert again.status_code == 404
    async with session_factory() as session:
        customer = await session.get(Customer, customer_id)
    assert customer is not None and customer.deleted_at is not None
    assert customer.archived_at is None
    assert await _audit_actions(session_factory, "customer.deleted") == 1
    assert await _audit_actions(session_factory, "customer.deleted_with_history") == 1


@pytest.mark.asyncio
async def test_deletion_check_counts_linked_records_and_delete_cascades(
    customer_deletion_enabled: None,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    customer_id, (location_id,) = await _customer_with_locations(
        session_factory, "Alpha"
    )
    product = await _product(session_factory, "P1", enabled=True)
    for number in ("A-2", "A-1"):
        await _asset_for(session_factory, customer_id, location_id, product, number)
    async with client_for(session_factory, SUPER) as client:
        check = await client.get(f"/api/v1/customers/{customer_id}/deletion-check")
        deleted = await _delete_customer(client, customer_id)
    body = check.json()

    assert check.status_code == 200
    assert body["can_delete"] is True
    counts = {item["kind"]: item["count"] for item in body["impact"]["items"]}
    assert counts["assets"] == 2 and counts["customer_locations"] == 1
    assert deleted.status_code == 200
    assert deleted.json()["total_records"] == 3  # location + 2 assets
    async with session_factory() as session:
        live_assets = await session.scalar(
            select(func.count()).select_from(Asset).where(Asset.deleted_at.is_(None))
        )
        shared_product = await session.get(Product, product.id)
    assert live_assets == 0
    assert shared_product is not None and shared_product.deleted_at is None


@pytest.mark.asyncio
async def test_deletion_check_and_delete_are_super_admin_only(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    customer_id, _ = await _customer_with_locations(session_factory, "Alpha")
    async with client_for(session_factory, ADMIN) as client:
        check = await client.get(f"/api/v1/customers/{customer_id}/deletion-check")
        deleted = await _delete_customer(client, customer_id)

    assert check.status_code == 403
    assert deleted.status_code == 403
    async with session_factory() as session:
        customer = await session.get(Customer, customer_id)
    assert customer is not None and customer.deleted_at is None


@pytest.mark.asyncio
async def test_customer_delete_keeps_the_stale_version_guard(
    customer_deletion_enabled: None,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    customer_id, _ = await _customer_with_locations(session_factory, "Alpha")
    async with client_for(session_factory, SUPER) as client:
        stale = await _delete_customer(
            client, customer_id, headers={"If-Match": '"999"'}
        )

    assert stale.status_code == 412
    async with session_factory() as session:
        customer = await session.get(Customer, customer_id)
    assert customer is not None and customer.deleted_at is None


@pytest.mark.asyncio
async def test_archived_customer_with_assets_can_be_deleted_with_history(
    customer_deletion_enabled: None,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    customer_id, (location_id,) = await _customer_with_locations(
        session_factory, "Alpha"
    )
    product = await _product(session_factory, "P1", enabled=True)
    await _asset_for(session_factory, customer_id, location_id, product, "A-1")
    async with client_for(session_factory, SUPER) as client:
        await client.post(f"/api/v1/customers/{customer_id}/archive")
        new_asset = await client.post(
            "/api/v1/assets",
            json={
                "customer_id": customer_id,
                "location_id": location_id,
                "product_id": product.id,
                "asset_name": "Hose",
                "customer_serial_no": "SN-2",
            },
        )
        deleted = await _delete_customer(client, customer_id)

    assert new_asset.status_code == 409
    assert "archived" in new_asset.json()["detail"]
    assert deleted.status_code == 200


# --- users -------------------------------------------------------------------


async def _user(
    session_factory: async_sessionmaker[AsyncSession], subject: str, role: Role
) -> User:
    async with session_factory() as session:
        user = User(
            oidc_subject=subject, email=f"{subject}@example.com", role=role.value
        )
        session.add(user)
        await session.commit()
        return user


@pytest.mark.asyncio
async def test_user_delete_is_super_admin_only_and_ends_sessions(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    actor = await _user(session_factory, "super-1", Role.SUPER_ADMIN)
    target = await _user(session_factory, "inspector-1", Role.INSPECTOR)
    async with session_factory() as session:
        session.add(
            BrowserRefreshSession(
                user_id=target.id,
                family_id="family-1",
                token_hash="0" * 64,
                expires_at=utc_now() + timedelta(days=1),
                idle_expires_at=utc_now() + timedelta(hours=1),
            )
        )
        await session.commit()
    as_admin = Principal(
        user_id="staff-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )
    as_super = Principal(
        user_id="super-1",
        roles=frozenset({Role.SUPER_ADMIN}),
        customer_ids=frozenset(),
        record_user_id=actor.id,
    )
    async with client_for(session_factory, as_admin) as client:
        forbidden = await client.delete(f"/api/v1/admin/users/{target.id}")
    async with client_for(session_factory, as_super) as client:
        deleted = await client.delete(f"/api/v1/admin/users/{target.id}")

    assert forbidden.status_code == 403
    assert deleted.status_code == 204
    async with session_factory() as session:
        user = await session.get(User, target.id)
        sessions = (await session.scalars(select(BrowserRefreshSession))).all()
    assert user is not None
    assert user.deleted_at is not None
    assert user.account_status == "DISABLED"
    assert all(item.revoked_at is not None for item in sessions)


@pytest.mark.asyncio
async def test_super_admin_cannot_delete_self_or_the_last_super_admin(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    me = await _user(session_factory, "super-1", Role.SUPER_ADMIN)
    other = await _user(session_factory, "super-2", Role.SUPER_ADMIN)
    as_me = Principal(
        user_id="super-1",
        roles=frozenset({Role.SUPER_ADMIN}),
        customer_ids=frozenset(),
        record_user_id=me.id,
    )
    async with client_for(session_factory, as_me) as client:
        self_delete = await client.delete(f"/api/v1/admin/users/{me.id}")
        delete_other = await client.delete(f"/api/v1/admin/users/{other.id}")
    # Only one active Super Admin is left, and it is somebody else's session.
    as_other = Principal(
        user_id="someone-else",
        roles=frozenset({Role.SUPER_ADMIN}),
        customer_ids=frozenset(),
        record_user_id="unrelated-id",
    )
    async with client_for(session_factory, as_other) as client:
        last = await client.delete(f"/api/v1/admin/users/{me.id}")

    assert self_delete.status_code == 409
    assert "own account" in self_delete.json()["detail"]
    assert delete_other.status_code == 204
    assert last.status_code == 409
    assert "last active Super Admin" in last.json()["detail"]


# --- products and reference data ---------------------------------------------


@pytest.mark.asyncio
async def test_product_read_exposes_standard_and_survives_other_edits(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        standard = Standard(code="AS2683", name="AS2683")
        product = Product(category="Hose", code="P1", name="P1", standard=standard)
        session.add_all([standard, product])
        await session.commit()
        standard_id, product_id = standard.id, product.id
    async with client_for(session_factory, ADMIN) as client:
        before = await client.get("/api/v1/products")
        edited = await client.patch(
            f"/api/v1/products/{product_id}", json={"name": "Renamed"}
        )
        after = await client.get("/api/v1/products")

    assert before.json()["items"][0]["standard_id"] == standard_id
    assert edited.json()["standard_id"] == standard_id
    assert after.json()["items"][0]["standard_code"] == "AS2683"
    assert after.json()["items"][0]["enabled"] is True


@pytest.mark.asyncio
async def test_catalog_and_product_deletes_are_super_admin_only_and_guard_use(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        standard = Standard(code="AS2683", name="AS2683")
        product = Product(category="Hose", code="P1", name="P1", standard=standard)
        material = Material(code="STEEL", name="Steel")
        session.add_all([standard, product, material])
        await session.commit()
        ids = (standard.id, product.id, material.id)
    standard_id, product_id, material_id = ids
    async with client_for(session_factory, ADMIN) as client:
        forbidden = [
            await client.delete(f"/api/v1/reference/standards/{standard_id}"),
            await client.delete(f"/api/v1/products/{product_id}"),
            await client.delete(f"/api/v1/reference/catalog/materials/{material_id}"),
        ]
    async with client_for(session_factory, SUPER) as client:
        in_use = await client.delete(f"/api/v1/reference/standards/{standard_id}")
        product_deleted = await client.delete(f"/api/v1/products/{product_id}")
        standard_deleted = await client.delete(
            f"/api/v1/reference/standards/{standard_id}"
        )
        material_deleted = await client.delete(
            f"/api/v1/reference/catalog/materials/{material_id}"
        )

    assert [item.status_code for item in forbidden] == [403, 403, 403]
    assert in_use.status_code == 409
    assert "1 products" in in_use.json()["detail"]
    assert product_deleted.status_code == 204
    assert standard_deleted.status_code == 204
    assert material_deleted.status_code == 204


@pytest.mark.asyncio
async def test_customer_summary_counts_the_whole_system_not_a_page(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        for index in range(7):
            customer = Customer(code=f"C{index}", name=f"Customer {index}")
            session.add(customer)
            session.add(CustomerLocation(customer=customer, name="Site A"))
            session.add(CustomerLocation(customer=customer, name="Site B"))
        session.add(Customer(code="OLD", name="Old", archived_at=utc_now()))
        await session.commit()
    async with client_for(session_factory, ADMIN) as client:
        summary = await client.get("/api/v1/customers/summary")
        page = await client.get("/api/v1/customers", params={"limit": 2})

    assert page.json()["total"] == 7
    assert len(page.json()["items"]) == 2
    assert summary.json() == {
        "active_customers": 7,
        "archived_customers": 1,
        "locations": 14,
        "assets": 0,
    }


# --- archived customers get no new work, disabled products no new assets -----


async def _asset_for(
    session_factory: async_sessionmaker[AsyncSession],
    customer_id: str,
    location_id: str,
    product: Product,
    number: str,
) -> str:
    async with session_factory() as session:
        asset = Asset(
            customer_id=customer_id,
            location_id=location_id,
            product_id=product.id,
            asset_number=number,
            customer_serial_no=f"SN-{number}",
            tag=f"HMS-{number}",
            lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
        )
        session.add(asset)
        await session.commit()
        return asset.id


async def _product(
    session_factory: async_sessionmaker[AsyncSession], code: str, *, enabled: bool
) -> Product:
    async with session_factory() as session:
        product = Product(category="Hose", code=code, name=code, enabled=enabled)
        session.add(product)
        await session.commit()
        return product


@pytest.mark.asyncio
async def test_archived_customer_keeps_history_but_gets_no_new_inspection(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    customer_id, (location_id,) = await _customer_with_locations(
        session_factory, "Alpha"
    )
    product = await _product(session_factory, "P1", enabled=True)
    asset_id = await _asset_for(
        session_factory, customer_id, location_id, product, "A-1"
    )
    body = {"inspection_type": "SERVICE"}
    async with client_for(session_factory, SUPER) as client:
        first = await client.post(f"/api/v1/assets/{asset_id}/inspections", json=body)
        await client.post(f"/api/v1/customers/{customer_id}/archive")
        blocked = await client.post(f"/api/v1/assets/{asset_id}/inspections", json=body)
        everything = await client.get("/api/v1/assets")
        for_new_work = await client.get("/api/v1/assets?new_work_only=true")
        detail = await client.get(f"/api/v1/assets/{asset_id}")
        history = await client.get("/api/v1/inspections")
        certificates = await client.get("/api/v1/certificates")
        await client.post(f"/api/v1/customers/{customer_id}/restore")
        restored = await client.get("/api/v1/assets?new_work_only=true")
        again = await client.post(f"/api/v1/assets/{asset_id}/inspections", json=body)

    assert first.status_code == 201
    assert blocked.status_code == 409
    assert blocked.json()["detail"] == (
        "This customer is archived. Restore it before adding new work."
    )
    # The register, detail, inspections and certificates keep showing history.
    assert [item["id"] for item in everything.json()["items"]] == [asset_id]
    assert for_new_work.json()["items"] == []
    assert for_new_work.json()["total"] == 0
    assert detail.status_code == 200
    assert history.status_code == 200 and history.json()["total"] == 1
    assert certificates.status_code == 200
    assert [item["id"] for item in restored.json()["items"]] == [asset_id]
    assert again.status_code == 201


@pytest.mark.asyncio
async def test_archived_customer_cannot_receive_a_location_by_any_route(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    customer_id, (location_id,) = await _customer_with_locations(
        session_factory, "Alpha"
    )
    async with client_for(session_factory, SUPER) as client:
        await client.post(f"/api/v1/customers/{customer_id}/archive")
        dedicated = await client.post(
            f"/api/v1/customers/{customer_id}/locations", json={"name": "Second"}
        )
        nested = await client.patch(
            f"/api/v1/customers/{customer_id}",
            json={"locations": [{"name": "Second"}]},
        )

    assert dedicated.status_code == 409
    # The old nested path is gone, so it cannot carry different rules.
    assert nested.status_code == 422
    async with session_factory() as session:
        names = (
            await session.scalars(
                select(CustomerLocation.name).where(
                    CustomerLocation.customer_id == customer_id
                )
            )
        ).all()
    assert list(names) == ["Alpha"]
    assert location_id


@pytest.mark.asyncio
async def test_disabled_product_cannot_be_assigned_but_existing_assets_still_work(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    customer_id, (location_id,) = await _customer_with_locations(
        session_factory, "Alpha"
    )
    old = await _product(session_factory, "OLD", enabled=True)
    other = await _product(session_factory, "OTHER", enabled=True)
    on_old = await _asset_for(session_factory, customer_id, location_id, old, "A-1")
    on_other = await _asset_for(session_factory, customer_id, location_id, other, "A-2")
    new_asset = {
        "customer_id": customer_id,
        "location_id": location_id,
        "product_id": old.id,
        "asset_name": "Hose",
        "customer_serial_no": "SN-NEW",
    }
    async with client_for(session_factory, ADMIN) as client:
        disable = await client.patch(
            f"/api/v1/products/{old.id}", json={"enabled": False}
        )
        create = await client.post("/api/v1/assets", json=new_asset)
        reassign = await client.patch(
            f"/api/v1/assets/{on_other}", json={"product_id": old.id}
        )
        unrelated = await client.patch(
            f"/api/v1/assets/{on_old}", json={"notes": "Checked on site"}
        )
        still_there = await client.get(f"/api/v1/assets/{on_old}")
        enable = await client.patch(
            f"/api/v1/products/{old.id}", json={"enabled": True}
        )
        create_again = await client.post("/api/v1/assets", json=new_asset)
        reassign_again = await client.patch(
            f"/api/v1/assets/{on_other}", json={"product_id": old.id}
        )

    assert disable.status_code == 200
    assert create.status_code == 409
    assert "disabled" in create.json()["detail"]
    assert reassign.status_code == 409
    assert unrelated.status_code == 200
    assert still_there.status_code == 200
    assert still_there.json()["product"]["id"] == old.id
    assert enable.status_code == 200
    assert create_again.status_code == 201
    assert reassign_again.status_code == 200


# --- deleting an asset is a Super Admin action and never erases history ------


@pytest.mark.asyncio
async def test_only_super_admin_deletes_an_unreferenced_asset(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    customer_id, (location_id,) = await _customer_with_locations(session_factory, "A")
    product = await _product(session_factory, "P1", enabled=True)
    asset_id = await _asset_for(
        session_factory, customer_id, location_id, product, "A-1"
    )
    roles = {
        "hms_admin": Role.HMS_ADMIN,
        "assembly": Role.ASSEMBLY,
        "inspector": Role.INSPECTOR,
        "customer_user": Role.CUSTOMER_USER,
    }
    refused = {}
    for name, role in roles.items():
        principal = Principal(
            user_id=name,
            roles=frozenset({role}),
            customer_ids=frozenset({customer_id}),
        )
        async with client_for(session_factory, principal) as client:
            refused[name] = (
                await client.delete(f"/api/v1/assets/{asset_id}")
            ).status_code
    async with client_for(session_factory, SUPER) as client:
        deleted = await client.delete(f"/api/v1/assets/{asset_id}")
        gone = await client.get(f"/api/v1/assets/{asset_id}")

    assert refused == {name: 403 for name in roles}
    assert deleted.status_code == 204
    assert gone.status_code == 404


@pytest.mark.asyncio
async def test_asset_with_history_cannot_be_deleted_and_stays_whole(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    customer_id, (location_id,) = await _customer_with_locations(session_factory, "A")
    product = await _product(session_factory, "P1", enabled=True)
    with_inspection = await _asset_for(
        session_factory, customer_id, location_id, product, "A-1"
    )
    with_schedule = await _asset_for(
        session_factory, customer_id, location_id, product, "A-2"
    )
    async with session_factory() as session:
        session.add(
            Inspection(
                asset_id=with_inspection,
                inspection_type="SERVICE",
                status="SUBMITTED",
                result="PASS",
                inspector_user_id="inspector-1",
            )
        )
        session.add(
            RetestSchedule(
                customer_id=customer_id, asset_id=with_schedule, due_at=utc_now().date()
            )
        )
        await session.commit()
    async with client_for(session_factory, SUPER) as client:
        by_inspection = await client.delete(f"/api/v1/assets/{with_inspection}")
        by_schedule = await client.delete(f"/api/v1/assets/{with_schedule}")
        kept = await client.get(f"/api/v1/assets/{with_inspection}")
        inspections = await client.get("/api/v1/inspections")
        # Ordinary lifecycle editing is the sanctioned alternative, and still works.
        retired = await client.patch(
            f"/api/v1/assets/{with_inspection}", json={"lifecycle_status": "RETIRED"}
        )

    assert by_inspection.status_code == 409
    assert "inspections" in by_inspection.json()["detail"]
    assert "Retired or Condemned" in by_inspection.json()["detail"]
    assert by_schedule.status_code == 409
    assert "retest schedules" in by_schedule.json()["detail"]
    assert kept.status_code == 200
    assert inspections.json()["total"] == 1
    assert retired.status_code == 200
    assert retired.json()["lifecycle_status"] == "RETIRED"
    async with session_factory() as session:
        live = await session.scalars(select(Asset.id).where(Asset.deleted_at.is_(None)))
        assert {with_inspection, with_schedule} <= set(live.all())


@pytest.mark.asyncio
async def test_archived_customer_cannot_gain_a_retest_schedule_but_keeps_history(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    customer_id, (location_id,) = await _customer_with_locations(session_factory, "A")
    product = await _product(session_factory, "P1", enabled=True)
    asset_id = await _asset_for(
        session_factory, customer_id, location_id, product, "A-1"
    )
    schedule = {
        "retest_schedule": {"due_at": "2030-01-01", "status": "UPCOMING"},
    }

    async def schedules() -> int:
        async with session_factory() as session:
            return (
                await session.scalar(select(func.count()).select_from(RetestSchedule))
                or 0
            )

    async with client_for(session_factory, SUPER) as client:
        await client.post(f"/api/v1/customers/{customer_id}/archive")
        unrelated = await client.patch(
            f"/api/v1/assets/{asset_id}", json={"notes": "Corrected note"}
        )
        blocked = await client.patch(f"/api/v1/assets/{asset_id}", json=schedule)
        created_while_archived = await schedules()
        await client.post(f"/api/v1/customers/{customer_id}/restore")
        created = await client.patch(f"/api/v1/assets/{asset_id}", json=schedule)
        await client.post(f"/api/v1/customers/{customer_id}/archive")
        # A schedule that already exists may still be corrected while archived.
        corrected = await client.patch(
            f"/api/v1/assets/{asset_id}",
            json={"retest_schedule": {"due_at": "2031-01-01", "status": "UPCOMING"}},
        )

    assert unrelated.status_code == 200
    assert blocked.status_code == 409
    assert blocked.json()["detail"] == (
        "This customer is archived. Restore it before adding new work."
    )
    assert created_while_archived == 0
    assert created.status_code == 200
    assert await schedules() == 1
    assert corrected.status_code == 200
    assert corrected.json()["retest_schedule"]["due_at"] == "2031-01-01"


# --- changing the inspector of a confirmed booking: availability preview ------

SLOT_START = datetime(2027, 3, 1, 1, tzinfo=UTC)
SLOT_END = datetime(2027, 3, 1, 2, tzinfo=UTC)


async def _confirmed_booking(
    session_factory: async_sessionmaker[AsyncSession],
    customer_id: str,
    location_id: str,
    asset_id: str,
    inspector_id: str,
    start: datetime = SLOT_START,
    end: datetime = SLOT_END,
) -> str:
    """A confirmed booking whose inspector and asset hold the slot."""
    async with session_factory() as session:
        booking = InspectionBooking(
            customer_id=customer_id,
            location_id=location_id,
            scheduled_at=start,
            scheduled_end_at=end,
            status="APPROVED",
            requested_by_user_id="customer",
            inspector_user_id=inspector_id,
        )
        session.add(booking)
        await session.flush()
        appointment = InspectionAppointment(
            booking_id=booking.id,
            customer_id=customer_id,
            location_id=location_id,
            status="CONFIRMED",
            current_revision_number=1,
        )
        session.add_all(
            [
                InspectionBookingAsset(booking_id=booking.id, asset_id=asset_id),
                appointment,
            ]
        )
        await session.flush()
        revision = InspectionAppointmentRevision(
            appointment_id=appointment.id,
            revision_number=1,
            starts_at=start,
            ends_at=end,
            timezone_id="UTC",
            local_start_snapshot=start.strftime("%Y-%m-%dT%H:%M:%S"),
            local_end_snapshot=end.strftime("%Y-%m-%dT%H:%M:%S"),
            utc_offset_start="+00:00",
            utc_offset_end="+00:00",
            tzdata_version="test",
            inspector_user_id=inspector_id,
            created_by_user_id="admin",
        )
        session.add(revision)
        await session.flush()
        for kind, resource in (("INSPECTOR", inspector_id), ("ASSET", asset_id)):
            session.add(
                InspectionResourceAllocation(
                    revision_id=revision.id,
                    resource_type=kind,
                    resource_id=resource,
                    starts_at=start,
                    ends_at=end,
                )
            )
        await session.commit()
        return booking.id


async def _booking_scene(
    session_factory: async_sessionmaker[AsyncSession], inspectors: int = 1
) -> tuple[str, str, str, str, list[str]]:
    """A confirmed booking held by 'ins-current', plus spare inspectors."""
    customer_id, (location_id,) = await _customer_with_locations(
        session_factory, "Alpha"
    )
    product = await _product(session_factory, "P1", enabled=True)
    asset_id = await _asset_for(
        session_factory, customer_id, location_id, product, "A-1"
    )
    current = await _user(session_factory, "ins-current", Role.INSPECTOR)
    spare = [
        (await _user(session_factory, f"ins-{index}", Role.INSPECTOR)).id
        for index in range(inspectors)
    ]
    booking_id = await _confirmed_booking(
        session_factory, customer_id, location_id, asset_id, current.id
    )
    return booking_id, customer_id, location_id, asset_id, spare


@pytest.mark.asyncio
async def test_availability_preview_says_free_busy_and_suggests_up_to_three(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    booking_id, customer_id, location_id, _, spare = await _booking_scene(
        session_factory, inspectors=6
    )
    busy_id = spare[0]
    other_product = await _product(session_factory, "P2", enabled=True)
    other_asset = await _asset_for(
        session_factory, customer_id, location_id, other_product, "A-2"
    )
    await _confirmed_booking(
        session_factory, customer_id, location_id, other_asset, busy_id,
        start=datetime(2027, 3, 1, 1, 30, tzinfo=UTC),
        end=datetime(2027, 3, 1, 2, 30, tzinfo=UTC),
    )
    async with session_factory() as session:
        locked = await session.get(User, spare[5])
        assert locked is not None
        locked.account_status = "LOCKED"
        await session.commit()
    url = f"/api/v1/inspection-bookings/{booking_id}/inspector-availability"
    async with client_for(session_factory, ADMIN) as client:
        free = await client.get(url, params={"inspector_user_id": spare[1]})
        busy = await client.get(url, params={"inspector_user_id": busy_id})
        none_chosen = await client.get(url)

    assert free.status_code == 200
    assert free.json()["available"] is True and free.json()["reason"] is None
    assert busy.json()["available"] is False
    assert busy.json()["reason"] == "inspector_busy"
    suggested = busy.json()["suggested_inspector_ids"]
    # Up to three; never the busy, locked, current or asked-about inspector.
    assert len(suggested) == 3
    assert busy_id not in suggested and spare[5] not in suggested
    assert set(suggested) <= set(spare[1:5])
    assert none_chosen.json()["available"] is None
    assert busy.json()["eligible"] is True


@pytest.mark.asyncio
async def test_availability_preview_flags_an_asset_clash_and_history(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    booking_id, customer_id, location_id, asset_id, spare = await _booking_scene(
        session_factory, inspectors=2
    )
    # Another confirmed visit already holds the same asset in the same hour.
    await _confirmed_booking(
        session_factory, customer_id, location_id, asset_id, spare[1]
    )
    url = f"/api/v1/inspection-bookings/{booking_id}/inspector-availability"
    async with client_for(session_factory, ADMIN) as client:
        clash = await client.get(url, params={"inspector_user_id": spare[0]})
    assert clash.json()["available"] is False
    assert clash.json()["reason"] == "asset_unavailable"
    assert clash.json()["suggested_inspector_ids"] == []

    async with session_factory() as session:
        session.add(
            Inspection(
                asset_id=asset_id,
                booking_id=booking_id,
                inspector_user_id="ins-current",
                inspection_type="SERVICE",
                status="SUBMITTED",
            )
        )
        await session.commit()
    async with client_for(session_factory, ADMIN) as client:
        history = await client.get(url, params={"inspector_user_id": spare[0]})
    assert history.json()["eligible"] is False
    assert history.json()["available"] is False
    assert "inspection history" in history.json()["blocked_reason"]


@pytest.mark.asyncio
async def test_availability_preview_refuses_what_reassigning_would_refuse(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    booking_id, customer_id, _, _, spare = await _booking_scene(session_factory)
    customer_user = Principal(
        user_id="cust-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({customer_id}),
    )
    url = f"/api/v1/inspection-bookings/{booking_id}/inspector-availability"
    async with session_factory() as session:
        held = await session.get(InspectionBooking, booking_id)
    assert held is not None and held.inspector_user_id is not None
    async with client_for(session_factory, customer_user) as client:
        as_customer = await client.get(url, params={"inspector_user_id": spare[0]})
    async with client_for(session_factory, ADMIN) as client:
        same = await client.get(
            url, params={"inspector_user_id": held.inspector_user_id}
        )
        unknown = await client.get(url, params={"inspector_user_id": "nobody"})
        missing = await client.get(
            "/api/v1/inspection-bookings/none/inspector-availability"
        )

    assert as_customer.status_code == 403
    assert same.status_code == 409  # already the assigned inspector
    assert unknown.status_code == 422
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_a_stale_availability_answer_cannot_cause_a_double_booking(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    booking_id, customer_id, location_id, _, spare = await _booking_scene(
        session_factory
    )
    url = f"/api/v1/inspection-bookings/{booking_id}/inspector-availability"
    async with client_for(session_factory, ADMIN) as client:
        before = await client.get(url, params={"inspector_user_id": spare[0]})
    assert before.json()["available"] is True

    # After the preview, someone else books that inspector for the same hour.
    product = await _product(session_factory, "P3", enabled=True)
    asset = await _asset_for(session_factory, customer_id, location_id, product, "A-3")
    await _confirmed_booking(session_factory, customer_id, location_id, asset, spare[0])
    async with client_for(session_factory, ADMIN) as client:
        saved = await client.post(
            f"/api/v1/inspection-bookings/{booking_id}/reassign-inspector",
            json={"inspector_user_id": spare[0]},
        )
    assert saved.status_code == 409
    async with session_factory() as session:
        booking = await session.get(InspectionBooking, booking_id)
    assert booking is not None and booking.inspector_user_id != spare[0]
