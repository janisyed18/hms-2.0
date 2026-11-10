"""Customer deletion with historical data preservation.

A Super Admin deletes a customer and everything it exclusively owns from active HMS,
but only after a complete, hashed, verified archive exists. These tests cover who may
do it, what is archived, what is left alone, and what happens when archiving fails.
"""

from __future__ import annotations

import hashlib
from collections.abc import AsyncGenerator, Iterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import hms_backend.app.modules.history.service as history_service
from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.audit import verify_audit_chain
from hms_backend.app.core.object_storage import LocalObjectStorage, set_object_storage
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.models.foundation import AuditEvent, SyncChange
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.certificates.models import Certificate
from hms_backend.app.modules.customers.models import (
    Customer,
    CustomerContact,
    CustomerLocation,
    CustomerLocationContact,
)
from hms_backend.app.modules.history.models import (
    CustomerDeletionBatch,
    HistoryEvidenceObject,
    HistoryRecord,
    HistoryRelationship,
)
from hms_backend.app.modules.identity.models import User, UserCustomerAccess
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionAppointment,
    InspectionAppointmentRevision,
    InspectionBooking,
    InspectionBookingAsset,
    InspectionPhoto,
    InspectionResourceAllocation,
    PressureTestResult,
)
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.scheduling.models import RetestSchedule

SUPER = Principal(
    user_id="super-1",
    roles=frozenset({Role.SUPER_ADMIN}),
    customer_ids=frozenset(),
    record_user_id="super-user-id",
)
ADMIN = Principal(
    user_id="admin-1", roles=frozenset({Role.HMS_ADMIN}), customer_ids=frozenset()
)
PDF_BYTES = b"%PDF-1.7 certificate evidence"
PHOTO_BYTES = b"\xff\xd8\xff photo"
SLOT = (datetime(2027, 3, 1, 1, tzinfo=UTC), datetime(2027, 3, 1, 2, tzinfo=UTC))
OPERATIONAL = (
    CustomerLocation,
    CustomerContact,
    Asset,
    RetestSchedule,
    InspectionBooking,
    InspectionAppointment,
)

# These tests exercise the deletion itself, so they opt in to the flag that is
# off by default. The gate is covered in test_customer_deletion_gate.py.
pytestmark = pytest.mark.usefixtures("customer_deletion_enabled")


@pytest.fixture
def storage(tmp_path: Path) -> Iterator[LocalObjectStorage]:
    store = LocalObjectStorage(tmp_path / "objects")
    set_object_storage(store)
    yield store
    set_object_storage(None)


@pytest_asyncio.fixture
async def factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@asynccontextmanager
async def client_for(
    factory: async_sessionmaker[AsyncSession], principal: Principal = SUPER
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with factory() as session:
            yield session

    async def override_principal() -> Principal:
        return principal

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_principal] = override_principal
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        yield client


@dataclass
class Scene:
    customer_id: str
    other_customer_id: str
    product_id: str
    user_id: str
    ids: dict[str, str]


def _asset(owner: Customer, place: CustomerLocation, product: Product, n: str) -> Asset:
    return Asset(
        customer_id=owner.id,
        location_id=place.id,
        product_id=product.id,
        asset_number=n,
        customer_serial_no=f"SN-{n}",
        tag=f"HMS-{n}",
        lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
    )


async def build_scene(
    factory: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> Scene:
    """A customer with a full operational graph, and a second customer next to it."""
    storage.put("certificates/acme.pdf", PDF_BYTES)
    storage.put("photos/acme-1.jpg", PHOTO_BYTES, content_type="image/jpeg")
    storage.put("certificates/other.pdf", b"other customer certificate")
    async with factory() as session:
        actor = User(
            oidc_subject="super-1", email="jani@example.com", role="SUPER_ADMIN"
        )
        actor.id = "super-user-id"
        actor.first_name, actor.last_name = "Jani", "Syed"
        portal = User(
            oidc_subject="portal-1", email="portal@example.com", role="CUSTOMER_USER"
        )
        product = Product(category="Hose", code="P1", name="P1")
        customer = Customer(code="ACME", name="Port Botany")
        other = Customer(code="OTHR", name="Other Co")
        session.add_all([actor, portal, product, customer, other])
        await session.flush()
        portal.customer_id = customer.id
        site = CustomerLocation(customer=customer, name="Main yard")
        spare = CustomerLocation(customer=customer, name="Depot")
        other_site = CustomerLocation(customer=other, name="Other site")
        session.add_all([site, spare, other_site])
        await session.flush()
        gone = CustomerLocation(customer=customer, name="Closed yard")
        gone.deleted_at = datetime.now(UTC)
        session.add_all(
            [
                gone,
                CustomerLocationContact(location_id=site.id, name="Yard boss"),
                CustomerContact(customer=customer, name="Pat", email="pat@example.com"),
                UserCustomerAccess(user_id=portal.id, customer_id=customer.id),
            ]
        )
        a1 = _asset(customer, site, product, "A-1")
        a2 = _asset(customer, site, product, "A-2")
        other_asset = _asset(other, other_site, product, "O-1")
        session.add_all([a1, a2, other_asset])
        await session.flush()
        booking = InspectionBooking(
            customer_id=customer.id,
            location_id=site.id,
            scheduled_at=SLOT[0],
            scheduled_end_at=SLOT[1],
            status="APPROVED",
            requested_by_user_id="portal",
            inspector_user_id=actor.id,
        )
        session.add(booking)
        await session.flush()
        appointment = InspectionAppointment(
            booking_id=booking.id,
            customer_id=customer.id,
            location_id=site.id,
            status="CONFIRMED",
            current_revision_number=1,
        )
        session.add_all(
            [InspectionBookingAsset(booking_id=booking.id, asset_id=a1.id), appointment]
        )
        await session.flush()
        revision = InspectionAppointmentRevision(
            appointment_id=appointment.id,
            revision_number=1,
            starts_at=SLOT[0],
            ends_at=SLOT[1],
            timezone_id="UTC",
            local_start_snapshot="2027-03-01T01:00:00",
            local_end_snapshot="2027-03-01T02:00:00",
            utc_offset_start="+00:00",
            utc_offset_end="+00:00",
            tzdata_version="test",
            inspector_user_id=actor.id,
            created_by_user_id="admin",
        )
        session.add(revision)
        await session.flush()
        inspection = Inspection(
            asset_id=a1.id,
            booking_id=booking.id,
            inspection_type="SERVICE",
            status="APPROVED",
            result="PASS",
            inspector_user_id=actor.id,
        )
        other_inspection = Inspection(
            asset_id=other_asset.id,
            inspection_type="SERVICE",
            status="APPROVED",
            result="PASS",
        )
        session.add_all(
            [
                InspectionResourceAllocation(
                    revision_id=revision.id,
                    resource_type="ASSET",
                    resource_id=a1.id,
                    starts_at=SLOT[0],
                    ends_at=SLOT[1],
                ),
                RetestSchedule(
                    customer_id=customer.id, asset_id=a2.id, due_at=date(2028, 1, 1)
                ),
                inspection,
                other_inspection,
            ]
        )
        await session.flush()
        session.add_all(
            [
                InspectionPhoto(
                    inspection_id=inspection.id,
                    object_key="photos/acme-1.jpg",
                    caption="Hose end",
                ),
                PressureTestResult(
                    inspection_id=inspection.id,
                    applied_pressure_kpa=1000,
                    hold_time_seconds=60,
                    passed=True,
                ),
                Certificate(
                    inspection_id=inspection.id,
                    asset_id=a1.id,
                    number="CERT-ACME-1",
                    pdf_object_key="certificates/acme.pdf",
                    pdf_sha256=hashlib.sha256(PDF_BYTES).hexdigest(),
                    verification_hash="v-acme",
                    public_token="t-acme",
                    issued_by_user_id="admin",
                    status="ISSUED",
                ),
                Certificate(
                    inspection_id=other_inspection.id,
                    asset_id=other_asset.id,
                    number="CERT-OTHER-1",
                    pdf_object_key="certificates/other.pdf",
                    verification_hash="v-other",
                    public_token="t-other",
                    issued_by_user_id="admin",
                    status="ISSUED",
                ),
            ]
        )
        await session.commit()
        return Scene(
            customer_id=customer.id,
            other_customer_id=other.id,
            product_id=product.id,
            user_id=portal.id,
            ids={
                "booking": booking.id,
                "inspection": inspection.id,
                "asset": a1.id,
                "asset2": a2.id,
                "other_asset": other_asset.id,
                "gone": gone.id,
            },
        )


async def preview(client: httpx.AsyncClient, customer_id: str) -> dict[str, Any]:
    response = await client.get(f"/api/v1/customers/{customer_id}/deletion-check")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def delete(
    client: httpx.AsyncClient,
    customer_id: str,
    *,
    name: str = "Port Botany",
    headers: dict[str, str] | None = None,
    fingerprint: str | None = None,
    reason: str | None = None,
) -> httpx.Response:
    if fingerprint is None:
        fingerprint = (await preview(client, customer_id))["fingerprint"]
    payload: dict[str, Any] = {"confirm_name": name, "impact_fingerprint": fingerprint}
    if reason:
        payload["reason"] = reason
    return await client.post(
        f"/api/v1/customers/{customer_id}/delete-with-history",
        json=payload,
        headers=headers,
    )


async def count(
    factory: async_sessionmaker[AsyncSession], model: Any, *where: Any
) -> int:
    async with factory() as session:
        return int(
            await session.scalar(select(func.count()).select_from(model).where(*where))
            or 0
        )


async def live(
    factory: async_sessionmaker[AsyncSession], model: Any, customer_id: str
) -> int:
    column = model.id if model is Customer else model.customer_id
    return await count(
        factory, model, column == customer_id, model.deleted_at.is_(None)
    )


# --- authorization -----------------------------------------------------------


@pytest.mark.asyncio
async def test_only_super_admin_can_preview_delete_or_read_history(
    factory: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    scene = await build_scene(factory, storage)
    customer_user = Principal(
        user_id="portal-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({scene.customer_id}),
    )
    for principal in (ADMIN, customer_user):
        async with client_for(factory, principal) as client:
            responses = [
                await client.get(
                    f"/api/v1/customers/{scene.customer_id}/deletion-check"
                ),
                await delete(client, scene.customer_id, fingerprint="0" * 64),
                await client.get("/api/v1/customer-deletions"),
                await client.get("/api/v1/customer-deletions/anything"),
                await client.get("/api/v1/customer-deletions/anything/records"),
                await client.get("/api/v1/customer-deletions/anything/integrity"),
                await client.get(
                    "/api/v1/customer-deletions/anything/evidence/x/download"
                ),
            ]
        assert [r.status_code for r in responses] == [403] * 7
    assert await count(factory, CustomerDeletionBatch) == 0
    assert await live(factory, Customer, scene.customer_id) == 1


# --- preview, confirmation, concurrency --------------------------------------


@pytest.mark.asyncio
async def test_preview_counts_every_owned_record_and_nothing_shared(
    factory: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    scene = await build_scene(factory, storage)
    async with client_for(factory) as client:
        body = await preview(client, scene.customer_id)
    counts = {item["kind"]: item["count"] for item in body["impact"]["items"]}
    assert counts == {
        "customer_locations": 3,  # includes the location deleted earlier
        "customer_contacts": 1,
        "customer_location_contacts": 1,
        "assets": 2,
        "retest_schedules": 1,
        "inspection_bookings": 1,
        "inspection_booking_assets": 1,
        "inspection_appointments": 1,
        "inspection_appointment_revisions": 1,
        "inspection_resource_allocations": 1,
        "inspections": 1,
        "inspection_photos": 1,
        "pressure_test_results": 1,
        "certificates": 1,
        "user_customer_accesses": 1,
    }
    assert body["impact"]["total_records"] == sum(counts.values())
    assert body["impact"]["evidence_files"] == 2
    assert body["can_delete"] is True and len(body["fingerprint"]) == 64


@pytest.mark.asyncio
async def test_wrong_name_or_stale_preview_or_stale_version_changes_nothing(
    factory: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    scene = await build_scene(factory, storage)
    async with client_for(factory) as client:
        fingerprint = (await preview(client, scene.customer_id))["fingerprint"]
        wrong_name = await delete(
            client, scene.customer_id, name="Port", fingerprint=fingerprint
        )
        stale_version = await delete(
            client,
            scene.customer_id,
            fingerprint=fingerprint,
            headers={"If-Match": '"99"'},
        )
        bad_fingerprint = await delete(client, scene.customer_id, fingerprint="a" * 64)
        # A record arrives after the person reviewed the impact.
        async with factory() as session:
            session.add(CustomerContact(customer_id=scene.customer_id, name="Late"))
            await session.commit()
        changed = await delete(client, scene.customer_id, fingerprint=fingerprint)

    assert wrong_name.status_code == 422
    assert stale_version.status_code == 412
    assert bad_fingerprint.status_code == 409
    assert changed.status_code == 409
    assert "changed" in changed.json()["detail"]
    assert await count(factory, CustomerDeletionBatch) == 0
    assert await live(factory, Customer, scene.customer_id) == 1
    assert await live(factory, CustomerContact, scene.customer_id) == 2


@pytest.mark.asyncio
async def test_records_outside_the_customer_that_still_reference_it_block_delete(
    factory: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    scene = await build_scene(factory, storage)
    async with factory() as session:
        location = (
            await session.scalars(
                select(CustomerLocation).where(
                    CustomerLocation.customer_id == scene.customer_id,
                    CustomerLocation.name == "Depot",
                )
            )
        ).one()
        other_customer = await session.get(Customer, scene.other_customer_id)
        product = await session.get(Product, scene.product_id)
        assert other_customer is not None and product is not None
        session.add(_asset(other_customer, location, product, "X-1"))
        await session.commit()
    async with client_for(factory) as client:
        body = await preview(client, scene.customer_id)
        refused = await delete(client, scene.customer_id)
    assert body["can_delete"] is False
    assert body["blockers"][0]["kind"] == "assets"
    assert refused.status_code == 409
    assert await live(factory, Customer, scene.customer_id) == 1


# --- a successful deletion ---------------------------------------------------


@pytest.mark.asyncio
async def test_delete_archives_every_record_then_removes_it_from_active_hms(
    factory: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    scene = await build_scene(factory, storage)
    async with client_for(factory) as client:
        expected = (await preview(client, scene.customer_id))["impact"]["total_records"]
        response = await delete(client, scene.customer_id, reason="Contract ended")
        again = await client.get(f"/api/v1/customers/{scene.customer_id}")
    body = response.json()

    assert response.status_code == 200, response.text
    assert again.status_code == 404
    assert body["status"] == "COMPLETED" and body["replayed"] is False
    assert body["total_records"] == expected
    assert body["deletion_number"].startswith(f"DEL-{datetime.now(UTC).year}-")
    assert body["actor_name"] == "Jani Syed"
    assert body["reason"] == "Contract ended"
    assert body["evidence_files"] == 2
    assert body["retention_until"] is not None

    async with factory() as session:
        batch = await session.get(CustomerDeletionBatch, body["id"])
        records = (await session.scalars(select(HistoryRecord))).all()
        assert batch is not None and batch.manifest_sha256
        # Every archived snapshot is complete and hashes to what is stored.
        assert len(records) == expected + 1
        for record in records:
            assert record.payload["id"] == record.original_id
            assert record.schema_version == 1
            assert record.payload_sha256 == history_service._record_hash(
                record.record_type, record.payload
            )
        customer_snapshot = next(r for r in records if r.record_type == "customers")
        assert customer_snapshot.payload["name"] == "Port Botany"
        not_in_scene = {
            "inspection_appointment_change_requests",
            "inspection_answers",
            "asset_end_configurations",
        }
        assert {r.record_type for r in records} == (
            set(history_service.OWNED_TABLES) - not_in_scene
        )
        # The location deleted earlier is archived too, with its original deleted_at.
        earlier = next(r for r in records if r.original_id == scene.ids["gone"])
        assert earlier.payload["deleted_at"] is not None
        assert batch.previously_deleted_counts == {"customer_locations": 1}
        edges = (await session.scalars(select(HistoryRelationship))).all()
        retained = [e for e in edges if e.parent_retained]
        # Shared parents (products, accounts) are referenced, never copied or removed.
        assert {e.parent_type for e in retained} == {"products", "users"}
        assert any(
            e.child_type == "certificates" and e.parent_type == "inspections"
            for e in edges
        )

    # Everything owned is logically removed; nothing is physically deleted.
    assert await live(factory, Customer, scene.customer_id) == 0
    for model in OPERATIONAL:
        assert await live(factory, model, scene.customer_id) == 0
        assert await count(factory, model, model.customer_id == scene.customer_id) > 0
    async with factory() as session:
        inspection = await session.get(Inspection, scene.ids["inspection"])
        certificate = (
            await session.scalars(
                select(Certificate).where(Certificate.number == "CERT-ACME-1")
            )
        ).one()
    assert inspection is not None and inspection.deleted_at is not None
    assert certificate.deleted_at is not None


@pytest.mark.asyncio
async def test_shared_and_other_customers_records_are_untouched(
    factory: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    scene = await build_scene(factory, storage)
    async with client_for(factory) as client:
        assert (await delete(client, scene.customer_id)).status_code == 200
    async with factory() as session:
        product = await session.get(Product, scene.product_id)
        portal = await session.get(User, scene.user_id)
        actor = await session.get(User, "super-user-id")
        other = await session.get(Customer, scene.other_customer_id)
        other_asset = await session.get(Asset, scene.ids["other_asset"])
        other_cert = (
            await session.scalars(
                select(Certificate).where(Certificate.number == "CERT-OTHER-1")
            )
        ).one()
        access = (await session.scalars(select(UserCustomerAccess))).one()
    assert product is not None and product.deleted_at is None and product.version == 1
    # Accounts are shared and kept; only this customer's access association goes.
    assert portal is not None and portal.deleted_at is None and portal.version == 1
    assert actor is not None and actor.deleted_at is None
    assert access.deleted_at is not None
    assert other is not None and other.deleted_at is None and other.version == 1
    assert other_asset is not None and other_asset.deleted_at is None
    assert other_cert.deleted_at is None
    assert storage.exists("certificates/other.pdf")
    assert await live(factory, CustomerLocation, scene.other_customer_id) == 1


@pytest.mark.asyncio
async def test_certificate_evidence_is_retained_with_integrity_hashes(
    factory: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    scene = await build_scene(factory, storage)
    async with client_for(factory) as client:
        body = (await delete(client, scene.customer_id)).json()
        detail = (await client.get(f"/api/v1/customer-deletions/{body['id']}")).json()
        by_kind = {item["kind"]: item for item in detail["evidence"]}
        pdf = by_kind["CERTIFICATE_PDF"]
        download = await client.get(
            f"/api/v1/customer-deletions/{body['id']}/evidence/{pdf['id']}/download"
        )
        integrity = await client.get(
            f"/api/v1/customer-deletions/{body['id']}/integrity"
        )

    assert set(by_kind) == {"CERTIFICATE_PDF", "INSPECTION_PHOTO"}
    assert pdf["sha256"] == hashlib.sha256(PDF_BYTES).hexdigest()
    assert download.status_code == 200 and download.content == PDF_BYTES
    assert download.headers["x-content-sha256"] == pdf["sha256"]
    assert integrity.json()["verified"] is True
    assert integrity.json()["evidence_checked"] == 2
    async with factory() as session:
        rows = (await session.scalars(select(HistoryEvidenceObject))).all()
    for row in rows:
        assert row.history_key.startswith(f"history/customer-deletions/{body['id']}/")
        assert hashlib.sha256(storage.get(row.history_key)).hexdigest() == row.sha256
        # The source object stays where the certificate record points.
        assert storage.exists(row.source_key)


@pytest.mark.asyncio
async def test_integrity_check_reports_a_tampered_archive_file(
    factory: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    scene = await build_scene(factory, storage)
    async with client_for(factory) as client:
        body = (await delete(client, scene.customer_id)).json()
        async with factory() as session:
            row = (
                await session.scalars(
                    select(HistoryEvidenceObject).where(
                        HistoryEvidenceObject.kind == "CERTIFICATE_PDF"
                    )
                )
            ).one()
        storage.put(row.history_key, b"altered")
        integrity = await client.get(
            f"/api/v1/customer-deletions/{body['id']}/integrity"
        )
        download = await client.get(
            f"/api/v1/customer-deletions/{body['id']}/evidence/{row.id}/download"
        )
    assert integrity.json()["verified"] is False
    assert "differs" in integrity.json()["problems"][0]
    assert download.status_code == 502  # a failed file is never served


# --- audit and sync ----------------------------------------------------------


@pytest.mark.asyncio
async def test_deletion_writes_linked_audit_events_and_sync_tombstones(
    factory: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    scene = await build_scene(factory, storage)
    async with client_for(factory) as client:
        body = (await delete(client, scene.customer_id)).json()
    async with factory() as session:
        events = (
            await session.scalars(select(AuditEvent).order_by(AuditEvent.sequence))
        ).all()
        batch_event = next(
            e for e in events if e.action == "customer.deleted_with_history"
        )
        customer_event = next(e for e in events if e.action == "customer.deleted")
        batch = await session.get(CustomerDeletionBatch, body["id"])
        changes = (await session.scalars(select(SyncChange))).all()
        assert await verify_audit_chain(session)
    assert batch is not None and batch.audit_event_sequence == batch_event.sequence
    assert batch_event.entity_id == body["id"]
    assert batch_event.after is not None
    assert batch_event.after["manifest_sha256"] == batch.manifest_sha256
    assert batch_event.after["customer_id"] == scene.customer_id
    assert customer_event.after is not None
    assert customer_event.after["deletion_batch_id"] == body["id"]
    entities = {c.entity for c in changes if c.op == "delete"}
    # Devices receive tombstones for the offline catalogue; server-only data gets none.
    assert {
        "Customer",
        "CustomerLocation",
        "Asset",
        "Inspection",
        "Certificate",
        "RetestSchedule",
        "PressureTestResult",
    } <= entities
    assert "UserCustomerAccess" not in entities
    assert "InspectionBooking" not in entities
    assert {c.entity_id for c in changes if c.entity == "Asset"} == {
        scene.ids["asset"],
        scene.ids["asset2"],
    }


# --- failure and recovery ----------------------------------------------------


async def assert_nothing_changed(
    factory: async_sessionmaker[AsyncSession], scene: Scene, *, before_audit: int
) -> None:
    assert await live(factory, Customer, scene.customer_id) == 1
    for model in OPERATIONAL:
        assert await live(factory, model, scene.customer_id) > 0
    assert await count(factory, HistoryRecord) == 0
    assert await count(factory, HistoryEvidenceObject) == 0
    assert await count(factory, HistoryRelationship) == 0
    assert await count(factory, SyncChange) == 0
    async with factory() as session:
        assert await verify_audit_chain(session)
        completed = await session.scalar(
            select(func.count())
            .select_from(CustomerDeletionBatch)
            .where(CustomerDeletionBatch.status == "COMPLETED")
        )
        failed = (
            await session.scalars(
                select(CustomerDeletionBatch).where(
                    CustomerDeletionBatch.status == "FAILED"
                )
            )
        ).all()
        audits = await session.scalar(select(func.count()).select_from(AuditEvent))
    assert completed == 0
    assert len(failed) >= 1 and all(f.failure_detail for f in failed)
    assert all(f.manifest_sha256 is None and f.idempotency_key is None for f in failed)
    assert audits == before_audit + len(failed)  # only the failures are audited


class FailingStorage(LocalObjectStorage):
    def __init__(self, root: Path, *, fail_after: int) -> None:
        super().__init__(root)
        self.puts = 0
        self.fail_after = fail_after

    def put(
        self, key: str, data: bytes, *, content_type: str = "application/pdf"
    ) -> str:
        if key.startswith("history/"):
            self.puts += 1
            if self.puts > self.fail_after:
                raise OSError("disk full")
        return super().put(key, data, content_type=content_type)


@pytest.mark.asyncio
async def test_archive_failure_leaves_everything_intact_and_cleans_up(
    factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    store = FailingStorage(
        tmp_path / "failing", fail_after=1
    )  # first copy ok, then fail
    set_object_storage(store)
    try:
        scene = await build_scene(factory, store)
        audit_before = await count(factory, AuditEvent)
        async with client_for(factory) as client:
            response = await delete(client, scene.customer_id)
            still_there = await client.get(f"/api/v1/customers/{scene.customer_id}")
            listed = await client.get("/api/v1/customer-deletions")
            failed_list = await client.get(
                "/api/v1/customer-deletions", params={"status": "FAILED"}
            )
    finally:
        set_object_storage(None)

    assert response.status_code == 500
    assert "nothing was removed" in response.json()["detail"]
    assert "DEL-" in response.json()["detail"]
    assert still_there.status_code == 200
    assert listed.json()["total"] == 0  # failures are not shown as deletions
    assert failed_list.json()["total"] == 1
    await assert_nothing_changed(factory, scene, before_audit=audit_before)
    # The partial copy made by this attempt was removed again.
    assert store.list_objects("history/") == []


@pytest.mark.asyncio
async def test_records_deleted_earlier_are_archived_labelled_and_left_untouched(
    factory: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    scene = await build_scene(factory, storage)
    stamp = datetime(2026, 1, 2, tzinfo=UTC)
    async with factory() as session:
        # A child of the location that was already deleted, itself deleted earlier.
        old = CustomerLocationContact(location_id=scene.ids["gone"], name="Old contact")
        old.deleted_at = stamp
        # The same shape belonging to another customer must not be picked up.
        other_gone = CustomerLocation(customer_id=scene.other_customer_id, name="X")
        other_gone.deleted_at = stamp
        session.add_all([old, other_gone])
        await session.commit()
        old_id = old.id
        gone_row = await session.get(CustomerLocation, scene.ids["gone"])
        assert gone_row is not None
        gone_version = gone_row.version

    async with client_for(factory) as client:
        impact = (await preview(client, scene.customer_id))["impact"]
        done = await delete(client, scene.customer_id)
        records = await client.get(
            f"/api/v1/customer-deletions/{done.json()['id']}/records",
            params={"limit": 200},
        )
    assert done.status_code == 200, done.text
    assert impact["previously_deleted"] == 2
    by_kind = {i["kind"]: i for i in impact["items"]}
    assert by_kind["customer_locations"]["previously_deleted"] == 1
    assert by_kind["customer_location_contacts"]["previously_deleted"] == 1
    assert by_kind["assets"]["previously_deleted"] == 0

    items = {r["original_id"]: r for r in records.json()["items"]}
    assert items[old_id]["previously_deleted"] is True
    assert items[scene.ids["gone"]]["previously_deleted"] is True
    assert items[scene.ids["asset"]]["previously_deleted"] is False
    assert other_gone.id not in items

    async with factory() as session:
        again = await session.get(CustomerLocation, scene.ids["gone"])
        old_row = await session.get(CustomerLocationContact, old_id)
        assert again is not None and old_row is not None
        # Not deleted a second time: same stamp, same version, no new tombstone.
        assert again.version == gone_version
        assert old_row.deleted_at is not None
        assert old_row.deleted_at.replace(tzinfo=UTC) == stamp
        tombstones = (
            await session.scalars(
                select(SyncChange).where(
                    SyncChange.entity_id.in_([scene.ids["gone"], old_id])
                )
            )
        ).all()
        assert tombstones == []


@pytest.mark.asyncio
async def test_missing_file_of_a_record_deleted_earlier_blocks_the_archive(
    factory: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    scene = await build_scene(factory, storage)
    async with factory() as session:
        cert = (
            await session.scalars(
                select(Certificate).where(Certificate.number == "CERT-ACME-1")
            )
        ).one()
        cert.deleted_at = datetime(2026, 1, 2, tzinfo=UTC)
        await session.commit()
    storage.delete("certificates/acme.pdf")
    async with client_for(factory) as client:
        response = await delete(client, scene.customer_id)
    assert response.status_code == 500
    assert await live(factory, Customer, scene.customer_id) == 1
    assert await count(factory, HistoryRecord) == 0  # no archive claimed complete


@pytest.mark.asyncio
async def test_missing_or_altered_certificate_file_blocks_deletion(
    factory: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    scene = await build_scene(factory, storage)
    audit_before = await count(factory, AuditEvent)
    storage.put("certificates/acme.pdf", b"not what was issued")
    async with client_for(factory) as client:
        altered = await delete(client, scene.customer_id)
    assert altered.status_code == 500
    await assert_nothing_changed(factory, scene, before_audit=audit_before)

    storage.delete("certificates/acme.pdf")
    async with client_for(factory) as client:
        missing = await delete(client, scene.customer_id)
    assert missing.status_code == 500
    assert await live(factory, Customer, scene.customer_id) == 1
    async with factory() as session:
        details = (
            await session.scalars(select(CustomerDeletionBatch.failure_detail))
        ).all()
    assert any("issuance hash" in (d or "") for d in details)
    assert any("missing" in (d or "") for d in details)


@pytest.mark.asyncio
async def test_failed_verification_rolls_everything_back(
    factory: async_sessionmaker[AsyncSession],
    storage: LocalObjectStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scene = await build_scene(factory, storage)
    audit_before = await count(factory, AuditEvent)

    async def corrupt(session: AsyncSession, batch: CustomerDeletionBatch) -> None:
        raise history_service.ArchiveError("archive manifest does not match")

    monkeypatch.setattr(history_service, "verify_batch_in_session", corrupt)
    async with client_for(factory) as client:
        response = await delete(client, scene.customer_id)
    assert response.status_code == 500
    # Snapshot rows were flushed inside the transaction, then rolled back with it.
    await assert_nothing_changed(factory, scene, before_audit=audit_before)
    assert storage.list_objects("history/") == []


@pytest.mark.asyncio
async def test_failure_while_removing_records_rolls_back_the_archive_too(
    factory: async_sessionmaker[AsyncSession],
    storage: LocalObjectStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scene = await build_scene(factory, storage)
    audit_before = await count(factory, AuditEvent)

    async def boom(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("database went away")

    monkeypatch.setattr(history_service, "_remove_from_active", boom)
    async with client_for(factory) as client:
        response = await delete(client, scene.customer_id)
    assert response.status_code == 500
    await assert_nothing_changed(factory, scene, before_audit=audit_before)
    assert storage.list_objects("history/") == []


# --- idempotency -------------------------------------------------------------


@pytest.mark.asyncio
async def test_retry_with_the_same_idempotency_key_returns_the_original_result(
    factory: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    scene = await build_scene(factory, storage)
    headers = {"Idempotency-Key": "retry-key-0001"}
    async with client_for(factory) as client:
        fingerprint = (await preview(client, scene.customer_id))["fingerprint"]
        first = await delete(
            client, scene.customer_id, fingerprint=fingerprint, headers=headers
        )
        second = await delete(
            client, scene.customer_id, fingerprint=fingerprint, headers=headers
        )
        other_customer = await delete(
            client,
            scene.other_customer_id,
            name="Other Co",
            fingerprint="0" * 64,
            headers=headers,
        )
        no_key = await delete(client, scene.customer_id, fingerprint=fingerprint)

    assert first.status_code == 200 and second.status_code == 200
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["replayed"] is True
    assert second.headers["idempotent-replay"] == "true"
    assert other_customer.status_code == 409
    assert no_key.status_code == 404
    assert await count(factory, CustomerDeletionBatch) == 1
    assert (
        await count(
            factory, AuditEvent, AuditEvent.action == "customer.deleted_with_history"
        )
        == 1
    )


# --- historical retrieval ----------------------------------------------------


@pytest.mark.asyncio
async def test_history_workspace_lists_searches_filters_and_retrieves_records(
    factory: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    scene = await build_scene(factory, storage)
    base = "/api/v1/customer-deletions"
    today = datetime.now(UTC).date().isoformat()
    async with client_for(factory) as client:
        body = (await delete(client, scene.customer_id)).json()
        everything = (await client.get(base)).json()
        by_name = (await client.get(base, params={"q": "port bot"})).json()
        by_number = (
            await client.get(base, params={"q": body["deletion_number"]})
        ).json()
        no_match = (await client.get(base, params={"q": "zzz"})).json()
        in_range = (await client.get(base, params={"from_date": "2000-01-01"})).json()
        future = (await client.get(base, params={"from_date": "2999-01-01"})).json()
        past = (await client.get(base, params={"to_date": "2000-01-01"})).json()
        detail = (await client.get(f"{base}/{body['id']}")).json()
        assets = (
            await client.get(
                f"{base}/{body['id']}/records", params={"record_type": "assets"}
            )
        ).json()
        paged = (
            await client.get(
                f"{base}/{body['id']}/records", params={"limit": 5, "offset": 5}
            )
        ).json()
        relationships = (await client.get(f"{base}/{body['id']}/relationships")).json()
        missing = await client.get(f"{base}/nope")

    assert today
    assert (
        everything["total"] == 1 and everything["items"][0]["customer_code"] == "ACME"
    )
    assert by_name["total"] == 1 and by_number["total"] == 1
    assert no_match["total"] == 0
    assert in_range["total"] == 1 and future["total"] == 0 and past["total"] == 0
    assert {i["kind"]: i["count"] for i in detail["record_counts"]}["assets"] == 2
    assert sorted(r["label"] for r in assets["items"]) == ["A-1", "A-2"]
    assert assets["items"][0]["payload"]["customer_id"] == scene.customer_id
    assert paged["total"] == body["total_records"] + 1 and len(paged["items"]) == 5
    assert relationships["items"]
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_second_deletion_gets_the_next_number(
    factory: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    scene = await build_scene(factory, storage)
    async with client_for(factory) as client:
        first = (await delete(client, scene.customer_id)).json()
        second = (await delete(client, scene.other_customer_id, name="Other Co")).json()
    assert first["deletion_number"].endswith("000001")
    assert second["deletion_number"].endswith("000002")


# --- schema drift guard ------------------------------------------------------


def test_every_table_that_references_an_owned_table_is_accounted_for() -> None:
    """A new table pointing at customer data must be archived or retained on purpose."""
    owned = set(history_service.OWNED_TABLES)
    unaccounted = []
    for table in Base.metadata.sorted_tables:
        if table.name in owned or table.name in history_service.RETAINED_REFERENCERS:
            continue
        for foreign_key in table.foreign_keys:
            if foreign_key.column.table.name in owned:
                unaccounted.append(f"{table.name}.{foreign_key.parent.name}")
    assert unaccounted == []
    for name, links in history_service.OWNERSHIP.items():
        for column, parent in links:
            assert column in Base.metadata.tables[name].c
            assert parent in owned


# --- the feature gate ---------------------------------------------------------
# Deleting a customer is off unless CUSTOMER_DELETION_ENABLED is set, so a
# deployment can carry the code before evidence storage and retention are approved.

REFUSAL = "Customer deletion is not enabled in this environment."


def test_customer_deletion_is_off_unless_the_environment_enables_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hms_backend.app.core.config import Settings

    monkeypatch.delenv("CUSTOMER_DELETION_ENABLED", raising=False)
    assert Settings(_env_file=None).customer_deletion_enabled is False
    monkeypatch.setenv("CUSTOMER_DELETION_ENABLED", "true")
    assert Settings(_env_file=None).customer_deletion_enabled is True


@pytest.mark.asyncio
async def test_disabled_delete_is_refused_with_no_side_effects(
    factory: async_sessionmaker[AsyncSession],
    storage: LocalObjectStorage,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hms_backend.app.core.config import settings

    scene = await build_scene(factory, storage)
    async with factory() as session:
        audits_before = await session.scalar(
            select(func.count()).select_from(AuditEvent)
        )
    stored_before = sorted(p.name for p in (tmp_path / "objects").rglob("*"))
    async with client_for(factory) as client:
        # The preview still works and tells the screen why the action is unavailable.
        assert (await preview(client, scene.customer_id))["deletion_enabled"] is True
        fingerprint = (await preview(client, scene.customer_id))["fingerprint"]
        monkeypatch.setattr(settings, "customer_deletion_enabled", False)
        assert (await preview(client, scene.customer_id))["deletion_enabled"] is False

        # Valid, replayed, wrong-name and unknown-customer requests are all refused by
        # the gate before the name, fingerprint or version is read; a malformed body
        # never reaches the handler at all.
        valid = await delete(client, scene.customer_id, fingerprint=fingerprint)
        keyed = await delete(
            client,
            scene.customer_id,
            fingerprint=fingerprint,
            headers={"Idempotency-Key": "gate-test-0001", "If-Match": '"1"'},
        )
        wrong_name = await delete(
            client, scene.customer_id, name="nope", fingerprint="0" * 64
        )
        malformed = await client.post(
            f"/api/v1/customers/{scene.customer_id}/delete-with-history", json={}
        )
        unknown = await delete(client, "no-such-customer", fingerprint="0" * 64)
    for response in (valid, keyed, wrong_name, unknown):
        assert response.status_code == 409, response.text
        assert REFUSAL in response.text
    assert (
        malformed.status_code == 422
    )  # rejected by schema validation, before any code runs

    assert await count(factory, CustomerDeletionBatch) == 0
    assert await count(factory, HistoryRecord) == 0
    assert await count(factory, HistoryEvidenceObject) == 0
    assert await count(factory, SyncChange) == 0
    assert await live(factory, Customer, scene.customer_id) == 1
    for model in OPERATIONAL:
        assert await live(factory, model, scene.customer_id) > 0
    async with factory() as session:
        assert (
            await session.scalar(select(func.count()).select_from(AuditEvent))
            == audits_before
        )
    assert sorted(p.name for p in (tmp_path / "objects").rglob("*")) == stored_before
    assert not list((tmp_path / "objects").glob("history*"))


@pytest.mark.asyncio
async def test_disabled_gate_does_not_widen_access_or_revive_the_old_route(
    factory: async_sessionmaker[AsyncSession],
    storage: LocalObjectStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hms_backend.app.core.config import settings

    scene = await build_scene(factory, storage)
    monkeypatch.setattr(settings, "customer_deletion_enabled", False)
    async with client_for(factory, ADMIN) as client:
        # Authorization is checked first: a non-Super Admin never learns the flag.
        assert (
            await delete(client, scene.customer_id, fingerprint="0" * 64)
        ).status_code == 403
    async with client_for(factory) as client:
        # The old plain DELETE stays unavailable whatever the flag says.
        for enabled in (False, True):
            monkeypatch.setattr(settings, "customer_deletion_enabled", enabled)
            old = await client.delete(f"/api/v1/customers/{scene.customer_id}")
            assert old.status_code == 405
    assert await live(factory, Customer, scene.customer_id) == 1


@pytest.mark.asyncio
async def test_archive_restore_and_read_only_history_work_while_deletion_is_off(
    factory: async_sessionmaker[AsyncSession],
    storage: LocalObjectStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hms_backend.app.core.config import settings

    scene = await build_scene(factory, storage)
    monkeypatch.setattr(settings, "customer_deletion_enabled", False)
    async with client_for(factory) as client:
        assert (
            await client.post(f"/api/v1/customers/{scene.customer_id}/archive")
        ).status_code == 200
        assert (
            await client.post(f"/api/v1/customers/{scene.customer_id}/restore")
        ).status_code == 200
        history = await client.get("/api/v1/customer-deletions")
        assert history.status_code == 200
        assert history.json()["total"] == 0
        assert (await preview(client, scene.customer_id))["can_delete"] is True


@pytest.mark.asyncio
async def test_enabled_flag_allows_the_authorised_deletion(
    factory: async_sessionmaker[AsyncSession], storage: LocalObjectStorage
) -> None:
    # The module opts in through the fixture; this pins the gate's enabled side.
    scene = await build_scene(factory, storage)
    async with client_for(factory) as client:
        response = await delete(client, scene.customer_id)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "COMPLETED"
    assert await live(factory, Customer, scene.customer_id) == 0
