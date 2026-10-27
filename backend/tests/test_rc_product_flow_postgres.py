"""Release-candidate product flow on real PostgreSQL, one continuous narrative.

booking request -> approval and inspector assignment -> inspector edits and submits ->
reviewer approves -> signed certificate issued -> public verification -> revocation,
then the notifications those actions caused are relayed and dispatched, and a second
pass must change nothing (exactly once).

Each step is already unit-tested in isolation elsewhere. What this adds is the seams:
that the state one step leaves is what the next step needs, that every actor sees only
what they should, and that the audit chain, sync ledger and outbox stay consistent
across the whole journey. Everything is synthetic and uniquely tagged, so it is safe in
the shared test database.
"""

from __future__ import annotations

import asyncio
import os
from collections import Counter
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from random import randint
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx
import pytest
import pytest_asyncio
import tzdata  # type: ignore[import-untyped]
from alembic.config import Config
from alembic.script import ScriptDirectory
from certificate_support import SigningFakeEngine, build_pki
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import hms_backend.app.api.public as public_module
import hms_backend.app.api.records as records_module
import hms_backend.app.modules.certificates.issuance as issuance_module
from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.audit import verify_audit_chain
from hms_backend.app.core.config import settings as app_settings
from hms_backend.app.core.object_storage import LocalObjectStorage
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.foundation import AuditEvent, SyncChange
from hms_backend.app.modules.assets.models import (
    Asset,
    AssetEndConfiguration,
    AssetLifecycleStatus,
)
from hms_backend.app.modules.certificates.models import Certificate
from hms_backend.app.modules.customers.models import (
    Customer,
    CustomerContact,
    CustomerLocation,
)
from hms_backend.app.modules.identity.models import AccountStatus, User
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionAppointmentRevision,
)
from hms_backend.app.modules.notifications.channels.base import (
    DeliveryResult,
    OutgoingMessage,
)
from hms_backend.app.modules.notifications.enums import NotificationChannel
from hms_backend.app.modules.notifications.models import Notification, OutboxEvent
from hms_backend.app.modules.notifications.service import (
    dispatch_pending,
    relay_outbox,
)
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.reference.models import Standard

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)


@pytest_asyncio.fixture
async def database() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert POSTGRES_URL is not None
    if not POSTGRES_URL.startswith("postgresql+asyncpg://"):
        raise ValueError("These tests require a dedicated async PostgreSQL database")
    database_name = make_url(POSTGRES_URL).database
    if database_name is None or not database_name.endswith("_test"):
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


@pytest.fixture
def issuing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SigningFakeEngine:
    """A genuinely signing engine and local storage, wired into the API."""
    pki = build_pki(tmp_path / "pki")
    monkeypatch.setattr(
        app_settings, "certificate_trust_anchor_path", str(pki.anchor_path)
    )
    engine = SigningFakeEngine(pki.signer)
    storage = LocalObjectStorage(tmp_path / "objects")
    monkeypatch.setattr(records_module, "get_certificate_engine", lambda: engine)
    monkeypatch.setattr(issuance_module, "get_object_storage", lambda: storage)
    monkeypatch.setattr(public_module, "get_object_storage", lambda: storage)
    return engine


@asynccontextmanager
async def api_as(
    database: async_sessionmaker[AsyncSession], principal: Principal | None
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with database() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    if principal is not None:

        async def override_principal() -> Principal:
            return principal

        app.dependency_overrides[get_current_principal] = override_principal
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        yield client


# A fixed-offset, non-UTC zone: UTC+08:00 all year, so the expected offset is exact.
LOCATION_TIMEZONE = "Australia/Perth"


class RecordingAdapter:
    """Counts every message a dispatcher hands to a channel."""

    def __init__(self, channel: NotificationChannel) -> None:
        self.channel = channel
        self.sent: list[OutgoingMessage] = []

    async def send(self, message: OutgoingMessage) -> DeliveryResult:
        self.sent.append(message)
        return DeliveryResult(success=True, provider_message_id=f"rc-{uuid4().hex}")


def _adapters() -> dict[NotificationChannel, RecordingAdapter]:
    return {channel: RecordingAdapter(channel) for channel in NotificationChannel}


class World:
    """Synthetic, uniquely tagged records for one run."""

    def __init__(self) -> None:
        self.tag = uuid4().hex[:8]
        self.customer_id = ""
        self.other_customer_id = ""
        self.location_id = ""
        self.asset_ids: list[str] = []
        self.customer_user = f"cu-{self.tag}"
        self.admin = f"ad-{self.tag}"
        self.inspector = f"in-{self.tag}"
        self.other_inspector = f"io-{self.tag}"
        self.reviewer = f"rv-{self.tag}"
        self.contact_email = f"contact-{self.tag}@example.test"

    def principal(
        self, role: Role, user_id: str, *, customer: bool = False
    ) -> Principal:
        return Principal(
            user_id=user_id,
            roles=frozenset({role}),
            customer_ids=frozenset({self.customer_id}) if customer else frozenset(),
        )


async def _seed(database: async_sessionmaker[AsyncSession], assets: int = 1) -> World:
    world = World()
    async with database() as session:
        standard = Standard(code=f"AS-{world.tag}", name="Hydraulic hose")
        product = Product(
            category="Hydraulic",
            code=f"HP-{world.tag}",
            name="2-Wire Hose",
            standard=standard,
        )
        customer = Customer(code=f"C{world.tag}", name=f"Acme {world.tag} Pty Ltd")
        other = Customer(code=f"O{world.tag}", name=f"Other {world.tag} Pty Ltd")
        location = CustomerLocation(
            customer=customer,
            name="North Pit",
            city="Kalgoorlie",
            state="WA",
            scheduling_timezone=LOCATION_TIMEZONE,
        )
        built: list[Asset] = []
        for n in range(assets):
            asset = Asset(
                customer=customer,
                location=location,
                product=product,
                asset_number=f"HA-{world.tag}-{n}",
                lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
            )
            asset.ends.append(AssetEndConfiguration(end="A"))
            built.append(asset)
        session.add_all(
            [
                standard,
                product,
                customer,
                other,
                location,
                *built,
                CustomerContact(
                    customer=customer,
                    name="Site contact",
                    email=world.contact_email,
                    phone="+61 2 5555 0100",
                    role="Maintenance",
                ),
            ]
        )
        for user_id, role in (
            (world.customer_user, Role.CUSTOMER_USER),
            (world.admin, Role.HMS_ADMIN),
            (world.inspector, Role.INSPECTOR),
            (world.other_inspector, Role.INSPECTOR),
            (world.reviewer, Role.REVIEWER),
        ):
            session.add(
                User(
                    id=user_id,
                    oidc_subject=f"local:{user_id}",
                    email=f"{user_id}@example.test",
                    role=role.value,
                    account_status=AccountStatus.ACTIVE.value,
                    customer_id=customer.id if role is Role.CUSTOMER_USER else None,
                )
            )
        await session.flush()
        world.customer_id, world.other_customer_id = customer.id, other.id
        world.location_id = location.id
        world.asset_ids = [asset.id for asset in built]
        await session.commit()
    return world


async def _quote(
    client: httpx.AsyncClient, world: World, *, start: date | None = None
) -> tuple[dict[str, object], str]:
    """The first available quote on a far-future weekday nobody else is using."""
    day = start or date(2028, 1, 3) + timedelta(days=randint(0, 2500))
    for _ in range(14):
        if day.weekday() < 5:
            response = await client.get(
                "/api/v1/inspection-availability",
                params={
                    "customer_id": world.customer_id,
                    "location_id": world.location_id,
                    "local_date": day.isoformat(),
                    "duration_minutes": 60,
                },
            )
            assert response.status_code == 200, response.text
            items = response.json()["items"]
            if items:
                return items[0], day.isoformat()
        day += timedelta(days=1)
    raise AssertionError("no availability found on any nearby weekday")


async def _book(
    client: httpx.AsyncClient,
    world: World,
    quote: dict[str, object],
    asset_ids: list[str],
) -> httpx.Response:
    return await client.post(
        "/api/v1/inspection-bookings",
        json={
            "customer_id": world.customer_id,
            "location_id": world.location_id,
            "asset_ids": asset_ids,
            "availability_quote_id": quote["quote_id"],
        },
    )


@pytest.mark.asyncio
async def test_booking_to_certificate_to_notification_flow(
    database: async_sessionmaker[AsyncSession], issuing: SigningFakeEngine
) -> None:
    world = await _seed(database)
    customer = world.principal(Role.CUSTOMER_USER, world.customer_user, customer=True)
    admin = world.principal(Role.HMS_ADMIN, world.admin)
    inspector = world.principal(Role.INSPECTOR, world.inspector)
    other_inspector = world.principal(Role.INSPECTOR, world.other_inspector)
    reviewer = world.principal(Role.REVIEWER, world.reviewer)
    outsider = Principal(
        user_id=f"out-{world.tag}",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({world.other_customer_id}),
    )

    # 1. BOOKING: a customer books a quoted slot; the slot's local time is preserved.
    async with api_as(database, customer) as client:
        quote, _ = await _quote(client, world)
        booking_response = await _book(client, world, quote, world.asset_ids)
    assert booking_response.status_code == 201, booking_response.text
    booking = booking_response.json()
    assert booking["status"] == "PENDING_APPROVAL"
    assert booking["scheduled_at"] == quote["starts_at"]
    assert booking["scheduled_end_at"] == quote["ends_at"]

    # Another customer can neither book against nor read this customer's records.
    async with api_as(database, outsider) as client:
        denied = await _book(client, world, quote, world.asset_ids)
        hidden = await client.get(f"/api/v1/inspection-bookings/{booking['id']}")
    assert denied.status_code in (403, 404), denied.text
    assert hidden.status_code in (403, 404), hidden.text

    # 2. ASSIGNMENT: the admin approves and assigns an inspector.
    async with api_as(database, admin) as client:
        approved = await client.post(
            f"/api/v1/inspection-bookings/{booking['id']}/approve",
            json={"inspector_user_id": world.inspector},
        )
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "APPROVED"
    assert approved.json()["appointment"]["status"] == "CONFIRMED"
    assert approved.json()["appointment"]["revision_number"] == 1

    # The appointment keeps the quoted local time and zone, not just a UTC instant.
    # The location is in Perth (UTC+08:00, no DST), so every value is pinned exactly.
    starts = datetime.fromisoformat(str(quote["starts_at"]))
    ends = datetime.fromisoformat(str(quote["ends_at"]))
    zone = ZoneInfo(LOCATION_TIMEZONE)
    expected_local_start = starts.astimezone(zone).replace(tzinfo=None).isoformat()
    expected_local_end = ends.astimezone(zone).replace(tzinfo=None).isoformat()
    assert starts.astimezone(zone).utcoffset() == timedelta(hours=8)
    appointment = approved.json()["appointment"]
    async with database() as session:
        revision = await session.scalar(
            select(InspectionAppointmentRevision).where(
                InspectionAppointmentRevision.inspector_user_id == world.inspector
            )
        )
    assert revision is not None
    for source in (
        appointment,
        {
            "timezone_id": revision.timezone_id,
            "local_start_snapshot": revision.local_start_snapshot,
            "local_end_snapshot": revision.local_end_snapshot,
            "utc_offset_start": revision.utc_offset_start,
            "utc_offset_end": revision.utc_offset_end,
            "tzdata_version": revision.tzdata_version,
        },
    ):
        assert source["timezone_id"] == LOCATION_TIMEZONE
        assert source["local_start_snapshot"] == expected_local_start
        assert source["local_end_snapshot"] == expected_local_end
        assert source["utc_offset_start"] == "+08:00"
        assert source["utc_offset_end"] == "+08:00"
        assert source["tzdata_version"] == tzdata.IANA_VERSION
    # Local wall-clock time differs from the UTC instant by exactly the offset.
    assert expected_local_start != starts.replace(tzinfo=None).isoformat()
    assert datetime.fromisoformat(appointment["starts_at"]) == starts
    assert datetime.fromisoformat(appointment["ends_at"]) == ends

    # 3. INSPECTOR VISIBILITY: only the assigned inspector sees the case.
    async with api_as(database, inspector) as client:
        mine = (await client.get("/api/v1/inspections")).json()["items"]
    async with api_as(database, other_inspector) as client:
        theirs = (await client.get("/api/v1/inspections")).json()["items"]
    assigned = [i for i in mine if i["asset_id"] == world.asset_ids[0]]
    assert len(assigned) == 1
    assert assigned[0]["status"] == "DRAFT"
    assert assigned[0]["inspector_user_id"] == world.inspector
    assert not [i for i in theirs if i["asset_id"] == world.asset_ids[0]]
    inspection_id = assigned[0]["id"]

    # The field app sees the same case through sync, and the other inspector does not.
    headers = {
        "X-HMS-Device-Id": f"rc-tablet-{world.tag}",
        "X-HMS-Device-Platform": "ios",
        "X-HMS-App-Version": "0.1.0",
    }
    async with api_as(database, inspector) as client:
        boot = await client.get("/api/v1/sync/bootstrap", headers=headers)
    assert boot.status_code == 200, boot.text
    assert any(
        r["entity"] == "Inspection" and r["entity_id"] == inspection_id
        for r in boot.json()["records"]
    )
    assert any(
        c["asset_id"] == world.asset_ids[0] for c in boot.json()["work_contexts"]
    )
    async with api_as(database, other_inspector) as client:
        other_boot = await client.get(
            "/api/v1/sync/bootstrap",
            headers={**headers, "X-HMS-Device-Id": f"rc-other-{world.tag}"},
        )
    assert other_boot.status_code == 200, other_boot.text
    assert not any(
        r["entity_id"] == inspection_id for r in other_boot.json()["records"]
    )
    assert not any(
        c["asset_id"] == world.asset_ids[0] for c in other_boot.json()["work_contexts"]
    )
    async with api_as(database, other_inspector) as client:
        foreign_edit = await client.patch(
            f"/api/v1/inspections/{inspection_id}", json={"result": "FAIL"}
        )
    assert foreign_edit.status_code in (403, 404), foreign_edit.text

    # 4. INSPECTION: edit, submit; the inspector cannot approve their own work.
    async with api_as(database, inspector) as client:
        started = await client.post(f"/api/v1/inspections/{inspection_id}/start")
        assert started.status_code == 200, started.text
        edited = await client.patch(
            f"/api/v1/inspections/{inspection_id}",
            json={
                "result": "PASS",
                "pressure_test": {
                    "applied_pressure_kpa": 42000,
                    "hold_time_seconds": 120,
                    "passed": True,
                    "measurements": {"leak": "none"},
                },
            },
        )
        submitted = await client.post(f"/api/v1/inspections/{inspection_id}/submit")
        self_approval = await client.post(
            f"/api/v1/inspections/{inspection_id}/approve"
        )
        resubmitted_edit = await client.patch(
            f"/api/v1/inspections/{inspection_id}", json={"result": "FAIL"}
        )
    assert edited.status_code == 200, edited.text
    assert submitted.status_code == 200, submitted.text
    assert self_approval.status_code in (401, 403), self_approval.text
    assert resubmitted_edit.status_code == 409, resubmitted_edit.text

    async with api_as(database, reviewer) as client:
        early_certificate = await client.post(
            f"/api/v1/inspections/{inspection_id}/certificate", json={}
        )
        reviewed = await client.post(f"/api/v1/inspections/{inspection_id}/approve")
    assert early_certificate.status_code == 409, early_certificate.text
    assert reviewed.status_code == 200, reviewed.text
    assert reviewed.json()["status"] == "APPROVED"
    assert reviewed.json()["reviewer_user_id"] == world.reviewer

    # 5. CERTIFICATE: issued once, really signed, verifiable by anyone.
    async with api_as(database, reviewer) as client:
        issued = await client.post(
            f"/api/v1/inspections/{inspection_id}/certificate",
            json={"valid_until": (date.today() + timedelta(days=300)).isoformat()},
        )
        duplicate = await client.post(
            f"/api/v1/inspections/{inspection_id}/certificate", json={}
        )
    assert issued.status_code == 201, issued.text
    certificate = issued.json()
    assert certificate["status"] == "ISSUED"
    assert duplicate.status_code == 409, duplicate.text
    async with database() as session:
        row = await session.get(Certificate, certificate["id"])
        assert row is not None
        token = row.public_token
    async with api_as(database, None) as anonymous:
        verified = await anonymous.get(f"/api/v1/certificates/verify/{token}")
        pdf = await anonymous.get(f"/api/v1/certificates/verify/{token}/pdf")
    assert verified.status_code == 200, verified.text
    assert verified.json()["valid"] is True
    assert verified.json()["signed"] is True
    assert verified.json()["integrity"] == "VERIFIED"
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")

    # The customer sees the certificate, the outsider does not.
    async with api_as(database, customer) as client:
        own = await client.get(f"/api/v1/certificates/{certificate['id']}")
    async with api_as(database, outsider) as client:
        foreign = await client.get(f"/api/v1/certificates/{certificate['id']}")
    assert own.status_code == 200, own.text
    assert foreign.status_code in (403, 404), foreign.text

    # 6. REVOCATION: the public check reflects it.
    # Revocation is a reviewer decision: an admin and the customer cannot do it.
    for refused in (admin, customer):
        async with api_as(database, refused) as client:
            denied_revoke = await client.post(
                f"/api/v1/certificates/{certificate['id']}/revoke"
            )
        assert denied_revoke.status_code == 403, denied_revoke.text
    async with api_as(database, reviewer) as client:
        revoked = await client.post(f"/api/v1/certificates/{certificate['id']}/revoke")
    assert revoked.status_code == 200, revoked.text
    async with api_as(database, None) as anonymous:
        after = await anonymous.get(f"/api/v1/certificates/verify/{token}")
    assert after.json()["status"] == "REVOKED"
    assert after.json()["valid"] is False

    # 7. AUDIT AND SYNC: every mutation left an audit event and a ledger entry, the
    # chain still verifies, and the ledger is strictly ordered.
    async with database() as session:
        actions = set(
            (
                await session.scalars(
                    select(AuditEvent.action).where(
                        AuditEvent.entity_id.in_([inspection_id, certificate["id"]])
                    )
                )
            ).all()
        )
        assert {
            "inspection.submitted",
            "inspection.approved",
            "certificate.issued",
            "certificate.revoked",
        } <= actions
        seqs = list(
            (
                await session.scalars(
                    select(SyncChange.seq)
                    .where(SyncChange.entity_id.in_([inspection_id, certificate["id"]]))
                    .order_by(SyncChange.seq)
                )
            ).all()
        )
        assert len(seqs) >= 4 and seqs == sorted(set(seqs))
        assert await verify_audit_chain(session)

    # 8. NOTIFICATIONS: the flow's events relay and dispatch exactly once.
    async with database() as session:
        event_ids = [
            e.id
            for e in (
                await session.scalars(
                    select(OutboxEvent).where(
                        OutboxEvent.aggregate_id.in_(
                            [booking["id"], inspection_id, certificate["id"]]
                        )
                    )
                )
            ).all()
        ]
        event_counts = Counter(
            e.event_type
            for e in (
                await session.scalars(
                    select(OutboxEvent).where(OutboxEvent.id.in_(event_ids))
                )
            ).all()
        )
    # Exactly one of each business event: a duplicated emit would notify twice.
    assert {
        name: event_counts[name]
        for name in (
            "INSPECTION_BOOKING_REQUESTED",
            "INSPECTION_BOOKING_APPROVED",
            "INSPECTION_SUBMITTED",
            "INSPECTION_APPROVED",
            "CERTIFICATE_ISSUED",
            "CERTIFICATE_REVOKED",
        )
    } == {
        "INSPECTION_BOOKING_REQUESTED": 1,
        "INSPECTION_BOOKING_APPROVED": 1,
        "INSPECTION_SUBMITTED": 1,
        "INSPECTION_APPROVED": 1,
        "CERTIFICATE_ISSUED": 1,
        "CERTIFICATE_REVOKED": 1,
    }, event_counts

    adapters = _adapters()
    for _ in range(3):  # the shared database may hold other tests' rows: drain it
        await relay_outbox(database, limit=500)
    first = await dispatch_pending(database, adapters=adapters, limit=500)  # type: ignore[arg-type]
    assert first["dead_letter"] == 0

    async def flow_notifications(session: AsyncSession) -> list[Notification]:
        return list(
            (
                await session.scalars(
                    select(Notification).where(Notification.event_ref.in_(event_ids))
                )
            ).all()
        )

    async with database() as session:
        notifications = await flow_notifications(session)
        unprocessed = await session.scalar(
            select(func.count())
            .select_from(OutboxEvent)
            .where(OutboxEvent.id.in_(event_ids), OutboxEvent.processed_at.is_(None))
        )
    assert unprocessed == 0
    assert notifications, "the flow produced no notifications"
    keys = [(n.event_ref, n.recipient_id, n.channel) for n in notifications]
    assert len(keys) == len(set(keys)), "a recipient was notified twice for one event"
    assert len({n.idempotency_key for n in notifications}) == len(notifications)
    assert {n.status for n in notifications} <= {"SENT", "DELIVERED", "SUPPRESSED"}
    # The customer contact heard about the issued certificate.
    assert any(
        n.recipient_address == world.contact_email
        and n.category == "CERTIFICATE_ISSUED"
        for n in notifications
    )

    # A second full pass must send and create nothing more for this flow.
    sent_before = sum(len(a.sent) for a in adapters.values())
    mine_before = len(
        [
            m
            for a in adapters.values()
            for m in a.sent
            if m.to_address == world.contact_email
        ]
    )
    for _ in range(2):
        await relay_outbox(database, limit=500)
        await dispatch_pending(database, adapters=adapters, limit=500)  # type: ignore[arg-type]
    async with database() as session:
        again = await flow_notifications(session)
    assert len(again) == len(notifications)
    assert {(n.id, n.status, n.attempts) for n in again} == {
        (n.id, n.status, n.attempts) for n in notifications
    }
    mine_sent = [
        m
        for a in adapters.values()
        for m in a.sent
        if m.to_address == world.contact_email
    ]
    assert len(mine_sent) == len({(m.subject, m.body_text) for m in mine_sent})
    assert len(mine_sent) == mine_before
    assert sum(len(a.sent) for a in adapters.values()) == sent_before


@pytest.mark.asyncio
async def test_two_bookings_for_the_same_asset_and_slot_cannot_both_be_approved(
    database: async_sessionmaker[AsyncSession],
) -> None:
    world = await _seed(database)
    customer = world.principal(Role.CUSTOMER_USER, world.customer_user, customer=True)
    admin = world.principal(Role.HMS_ADMIN, world.admin)

    async with api_as(database, customer) as client:
        first_quote, day = await _quote(client, world)
        second_quote, _ = await _quote(client, world, start=date.fromisoformat(day))
        first = await _book(client, world, first_quote, world.asset_ids)
        second = await _book(client, world, second_quote, world.asset_ids)
    assert first.status_code == 201 and second.status_code == 201

    async def approve(booking_id: str, inspector_id: str) -> httpx.Response:
        async with api_as(database, admin) as client:
            return await client.post(
                f"/api/v1/inspection-bookings/{booking_id}/approve",
                json={"inspector_user_id": inspector_id},
            )

    results = await asyncio.gather(
        approve(first.json()["id"], world.inspector),
        approve(second.json()["id"], world.other_inspector),
    )
    assert sorted(r.status_code for r in results) == [200, 409], [
        (r.status_code, r.text) for r in results
    ]
    async with database() as session:
        drafts = (
            await session.scalars(
                select(Inspection).where(Inspection.asset_id == world.asset_ids[0])
            )
        ).all()
    assert len(drafts) == 1, "the losing approval must not leave a second inspection"
    # The conflict message is calm and actionable.
    loser = next(r for r in results if r.status_code == 409)
    assert "no longer available" in loser.json()["detail"]
