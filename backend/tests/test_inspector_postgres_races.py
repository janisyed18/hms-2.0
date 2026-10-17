"""Inspector authorization races against a dedicated, migrated PostgreSQL database."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.records import (
    approve_inspection_booking_change_request,
    cancel_inspection_booking,
)
from hms_backend.app.api.schemas import (
    InspectionAppointmentChangeRequestApproval,
    InspectionBookingCancelRequest,
)
from hms_backend.app.api.sync import _inspector_work_contexts, sync_push
from hms_backend.app.api.sync_schemas import (
    SyncOperationWrite,
    SyncPushRequest,
    SyncPushResponse,
    SyncWorkContext,
)
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.customers.models import Customer, CustomerLocation
from hms_backend.app.modules.identity.models import User
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionAppointment,
    InspectionAppointmentChangeRequest,
    InspectionAppointmentRevision,
    InspectionAvailabilityQuote,
    InspectionBooking,
    InspectionBookingAsset,
    PressureTestResult,
)
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.reference.models import Standard

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)


@dataclass(frozen=True)
class Assignment:
    context: SyncWorkContext
    inspector_a: Principal
    inspector_b: Principal
    change_id: str


@pytest_asyncio.fixture
async def database() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert POSTGRES_URL is not None
    if not POSTGRES_URL.startswith("postgresql+asyncpg://"):
        raise ValueError("Race tests require a dedicated async PostgreSQL database")
    database_name = make_url(POSTGRES_URL).database
    if database_name is None or not database_name.endswith("_test"):
        raise ValueError("Race tests require a database name ending in _test")
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


@pytest_asyncio.fixture
async def assignment(database: async_sessionmaker[AsyncSession]) -> Assignment:
    token = uuid4().hex[:16]
    user_a, user_b = f"a-{token}", f"b-{token}"
    start = datetime(2031, 1, 1, 8, tzinfo=UTC)
    async with database() as session:
        standard = Standard(code=f"S-{token}", name="Race standard")
        product = Product(
            category="Hose",
            sub_category="Test",
            code=f"P-{token}",
            name="Race product",
            standard=standard,
        )
        customer = Customer(code=f"C-{token}", name="Race customer")
        location = CustomerLocation(customer=customer, name="Race site")
        asset = Asset(
            customer=customer,
            location=location,
            product=product,
            asset_number=f"A-{token}",
            lifecycle_status="IN_SERVICE",
        )
        session.add_all(
            [
                asset,
                User(
                    id=user_a,
                    oidc_subject=f"oidc:{user_a}",
                    email=f"{user_a}@example.test",
                    role="INSPECTOR",
                ),
                User(
                    id=user_b,
                    oidc_subject=f"oidc:{user_b}",
                    email=f"{user_b}@example.test",
                    role="INSPECTOR",
                ),
            ]
        )
        await session.flush()
        booking = InspectionBooking(
            customer_id=customer.id,
            location_id=location.id,
            scheduled_at=start,
            scheduled_end_at=start + timedelta(hours=1),
            status="APPROVED",
            requested_by_user_id="customer",
            inspector_user_id=user_a,
        )
        session.add(booking)
        await session.flush()
        appointment = InspectionAppointment(
            booking_id=booking.id,
            customer_id=customer.id,
            location_id=location.id,
            status="CONFIRMED",
            current_revision_number=1,
        )
        link = InspectionBookingAsset(booking_id=booking.id, asset_id=asset.id)
        session.add_all([appointment, link])
        await session.flush()
        revision = InspectionAppointmentRevision(
            appointment_id=appointment.id,
            revision_number=1,
            starts_at=start,
            ends_at=start + timedelta(hours=1),
            timezone_id="UTC",
            local_start_snapshot="2031-01-01T08:00:00",
            local_end_snapshot="2031-01-01T09:00:00",
            utc_offset_start="+00:00",
            utc_offset_end="+00:00",
            tzdata_version="test",
            inspector_user_id=user_a,
            created_by_user_id="admin",
        )
        quote = InspectionAvailabilityQuote(
            customer_id=customer.id,
            location_id=location.id,
            starts_at=start + timedelta(days=1),
            ends_at=start + timedelta(days=1, hours=1),
            candidate_inspector_ids=[user_a, user_b],
            expires_at=datetime.now(UTC) + timedelta(days=1),
        )
        session.add_all([revision, quote])
        await session.flush()
        change = InspectionAppointmentChangeRequest(
            booking_id=booking.id,
            appointment_id=appointment.id,
            availability_quote_id=quote.id,
            requested_by_user_id="customer",
            status="PENDING_ADMIN_APPROVAL",
        )
        session.add(change)
        await session.flush()
        context = SyncWorkContext(
            appointment_id=appointment.id,
            booking_id=booking.id,
            revision_id=revision.id,
            assignment_id=link.id,
            asset_id=asset.id,
        )
        await session.commit()
        return Assignment(
            context=context,
            inspector_a=Principal(
                user_id=f"oidc:{user_a}",
                record_user_id=user_a,
                roles=frozenset({Role.INSPECTOR}),
                customer_ids=frozenset(),
            ),
            inspector_b=Principal(
                user_id=f"oidc:{user_b}",
                record_user_id=user_b,
                roles=frozenset({Role.INSPECTOR}),
                customer_ids=frozenset(),
            ),
            change_id=change.id,
        )


def draft(context: SyncWorkContext, *, key: str | None = None) -> SyncPushRequest:
    token = uuid4().hex
    return SyncPushRequest(
        operations=[
            SyncOperationWrite(
                op_id=f"op-{token}",
                idempotency_key=key or f"key-{token}",
                entity="Inspection",
                entity_id=str(uuid4()),
                op="create",
                work_context=context,
                payload={"asset_id": context.asset_id, "inspection_type": "SERVICE"},
            )
        ]
    )


async def push(
    session: AsyncSession, principal: Principal, payload: SyncPushRequest
) -> SyncPushResponse:
    return await sync_push(payload, session, principal, "race-device", "test", "1")


async def lock_booking(session: AsyncSession, booking_id: str) -> int:
    pid = await session.scalar(text("SELECT pg_backend_pid()"))
    await session.execute(
        select(InspectionBooking.id)
        .where(InspectionBooking.id == booking_id)
        .with_for_update()
    )
    assert isinstance(pid, int)
    return pid


async def wait_for_blocked(
    database: async_sessionmaker[AsyncSession], pid: int, blocker: int
) -> None:
    async with database() as observer:
        async with asyncio.timeout(10):
            while not await observer.scalar(
                text("SELECT :blocker = ANY(pg_blocking_pids(:pid))"),
                {"pid": pid, "blocker": blocker},
            ):
                await asyncio.sleep(0.02)


async def backend_pid(session: AsyncSession) -> int:
    pid = await session.scalar(text("SELECT pg_backend_pid()"))
    assert isinstance(pid, int)
    return pid


@pytest.mark.asyncio
async def test_cancel_wins_over_a_blocked_sync(
    database: async_sessionmaker[AsyncSession],
    assignment: Assignment,
) -> None:
    admin = Principal(
        user_id="admin", roles=frozenset({Role.HMS_ADMIN}), customer_ids=frozenset()
    )
    async with database() as admin_session, database() as sync_session:
        blocker = await lock_booking(admin_session, assignment.context.booking_id)
        sync_pid = await backend_pid(sync_session)
        task = asyncio.create_task(
            push(sync_session, assignment.inspector_a, draft(assignment.context))
        )
        try:
            await wait_for_blocked(database, sync_pid, blocker)
            await cancel_inspection_booking(
                assignment.context.booking_id,
                InspectionBookingCancelRequest(),
                admin_session,
                admin,
            )
            result = await asyncio.wait_for(task, 10)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        assert result.results[0].status == "rejected"
        assert result.results[0].error_code == "WORK_CONTEXT_STALE"
    async with database() as session:
        assert (
            await session.scalar(
                select(func.count())
                .select_from(Inspection)
                .where(Inspection.booking_id == assignment.context.booking_id)
            )
            == 0
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("reassign", [False, True], ids=["reschedule", "reassign"])
async def test_changed_assignment_wins_over_blocked_sync(
    database: async_sessionmaker[AsyncSession],
    assignment: Assignment,
    reassign: bool,
) -> None:
    admin = Principal(
        user_id="admin", roles=frozenset({Role.HMS_ADMIN}), customer_ids=frozenset()
    )
    new_inspector = assignment.inspector_b if reassign else assignment.inspector_a
    assert new_inspector.record_user_id is not None
    async with database() as admin_session, database() as sync_session:
        blocker = await lock_booking(admin_session, assignment.context.booking_id)
        pid = await backend_pid(sync_session)
        task = asyncio.create_task(
            push(sync_session, assignment.inspector_a, draft(assignment.context))
        )
        try:
            await wait_for_blocked(database, pid, blocker)
            await approve_inspection_booking_change_request(
                assignment.change_id,
                InspectionAppointmentChangeRequestApproval(
                    inspector_user_id=new_inspector.record_user_id
                ),
                admin_session,
                admin,
            )
            result = await asyncio.wait_for(task, 10)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        assert result.results[0].status == "rejected"
        assert result.results[0].error_code == "WORK_CONTEXT_STALE"
    async with database() as session:
        old_contexts = await _inspector_work_contexts(session, assignment.inspector_a)
        new_contexts = await _inspector_work_contexts(session, new_inspector)
        assert assignment.context not in old_contexts
        current = next(
            c for c in new_contexts if c.booking_id == assignment.context.booking_id
        )
        assert current.revision_id != assignment.context.revision_id
        result = await push(session, new_inspector, draft(current))
        assert result.results[0].status == "applied"
        assert (
            await session.scalar(
                select(func.count())
                .select_from(Inspection)
                .where(Inspection.booking_id == assignment.context.booking_id)
            )
            == 1
        )


@pytest.mark.asyncio
async def test_sync_wins_before_cancellation(
    database: async_sessionmaker[AsyncSession],
    assignment: Assignment,
) -> None:
    admin = Principal(
        user_id="admin", roles=frozenset({Role.HMS_ADMIN}), customer_ids=frozenset()
    )
    async with database() as sync_session, database() as admin_session:
        blocker = await lock_booking(sync_session, assignment.context.booking_id)
        pid = await backend_pid(admin_session)
        task = asyncio.create_task(
            cancel_inspection_booking(
                assignment.context.booking_id,
                InspectionBookingCancelRequest(),
                admin_session,
                admin,
            )
        )
        try:
            await wait_for_blocked(database, pid, blocker)
            result = await push(
                sync_session, assignment.inspector_a, draft(assignment.context)
            )
            assert result.results[0].status == "applied"
            await asyncio.wait_for(task, 10)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    async with database() as session:
        booking = await session.get(InspectionBooking, assignment.context.booking_id)
        assert booking is not None and booking.status == "CANCELLED"
        assert (
            await session.scalar(
                select(func.count())
                .select_from(Inspection)
                .where(Inspection.booking_id == assignment.context.booking_id)
            )
            == 1
        )


@pytest.mark.asyncio
async def test_new_inspector_syncs_while_old_inspector_is_waiting(
    database: async_sessionmaker[AsyncSession],
    assignment: Assignment,
) -> None:
    admin = Principal(
        user_id="admin", roles=frozenset({Role.HMS_ADMIN}), customer_ids=frozenset()
    )
    assert assignment.inspector_b.record_user_id is not None
    async with (
        database() as admin_session,
        database() as old_session,
        database() as new_session,
    ):
        blocker = await lock_booking(admin_session, assignment.context.booking_id)
        pid = await backend_pid(old_session)
        old_task = asyncio.create_task(
            push(old_session, assignment.inspector_a, draft(assignment.context))
        )
        try:
            await wait_for_blocked(database, pid, blocker)
            assert not await _inspector_work_contexts(
                new_session, assignment.inspector_b
            )
            await approve_inspection_booking_change_request(
                assignment.change_id,
                InspectionAppointmentChangeRequestApproval(
                    inspector_user_id=assignment.inspector_b.record_user_id
                ),
                admin_session,
                admin,
            )
            contexts = await _inspector_work_contexts(
                new_session, assignment.inspector_b
            )
            current = next(
                c for c in contexts if c.booking_id == assignment.context.booking_id
            )
            new_task = asyncio.create_task(
                push(new_session, assignment.inspector_b, draft(current))
            )
            try:
                old_result, new_result = await asyncio.wait_for(
                    asyncio.gather(old_task, new_task), 10
                )
            finally:
                if not new_task.done():
                    new_task.cancel()
                    await asyncio.gather(new_task, return_exceptions=True)
            assert old_result.results[0].error_code == "WORK_CONTEXT_STALE"
            assert new_result.results[0].status == "applied"
        finally:
            if not old_task.done():
                old_task.cancel()
                await asyncio.gather(old_task, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("reassign", [False, True], ids=["reschedule", "reassign"])
async def test_sync_wins_before_assignment_change(
    database: async_sessionmaker[AsyncSession],
    assignment: Assignment,
    reassign: bool,
) -> None:
    admin = Principal(
        user_id="admin", roles=frozenset({Role.HMS_ADMIN}), customer_ids=frozenset()
    )
    new_inspector = assignment.inspector_b if reassign else assignment.inspector_a
    assert new_inspector.record_user_id is not None
    payload = draft(assignment.context)
    async with database() as sync_session, database() as admin_session:
        blocker = await lock_booking(sync_session, assignment.context.booking_id)
        pid = await backend_pid(admin_session)
        task = asyncio.create_task(
            approve_inspection_booking_change_request(
                assignment.change_id,
                InspectionAppointmentChangeRequestApproval(
                    inspector_user_id=new_inspector.record_user_id
                ),
                admin_session,
                admin,
            )
        )
        try:
            await wait_for_blocked(database, pid, blocker)
            result = await push(sync_session, assignment.inspector_a, payload)
            assert result.results[0].status == "applied"
            await asyncio.wait_for(task, 10)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    async with database() as session:
        inspection = await session.get(Inspection, payload.operations[0].entity_id)
        assert inspection is not None
        assert inspection.booking_id == assignment.context.booking_id
        contexts = await _inspector_work_contexts(session, assignment.inspector_a)
        assert assignment.context not in contexts


@pytest.mark.asyncio
async def test_old_work_cannot_follow_asset_to_another_appointment(
    database: async_sessionmaker[AsyncSession],
    assignment: Assignment,
) -> None:
    admin = Principal(
        user_id="admin", roles=frozenset({Role.HMS_ADMIN}), customer_ids=frozenset()
    )
    async with database() as session:
        original = await session.get(InspectionBooking, assignment.context.booking_id)
        assert original is not None
        assert original.scheduled_end_at is not None
        later = InspectionBooking(
            customer_id=original.customer_id,
            location_id=original.location_id,
            scheduled_at=original.scheduled_at + timedelta(days=3),
            scheduled_end_at=original.scheduled_end_at + timedelta(days=3),
            status="APPROVED",
            requested_by_user_id="customer",
            inspector_user_id=assignment.inspector_a.record_user_id,
        )
        session.add(later)
        await session.flush()
        later_id = later.id
        appointment = InspectionAppointment(
            booking_id=later.id,
            customer_id=later.customer_id,
            location_id=later.location_id,
            status="CONFIRMED",
            current_revision_number=1,
        )
        session.add_all(
            [
                appointment,
                InspectionBookingAsset(
                    booking_id=later.id, asset_id=assignment.context.asset_id
                ),
            ]
        )
        await session.flush()
        session.add(
            InspectionAppointmentRevision(
                appointment_id=appointment.id,
                revision_number=1,
                starts_at=later.scheduled_at,
                ends_at=later.scheduled_end_at,
                timezone_id="UTC",
                local_start_snapshot="2031-01-04T08:00:00",
                local_end_snapshot="2031-01-04T09:00:00",
                utc_offset_start="+00:00",
                utc_offset_end="+00:00",
                tzdata_version="test",
                inspector_user_id=assignment.inspector_a.record_user_id,
                created_by_user_id="admin",
            )
        )
        await session.commit()
    async with database() as admin_session, database() as sync_session:
        blocker = await lock_booking(admin_session, assignment.context.booking_id)
        pid = await backend_pid(sync_session)
        task = asyncio.create_task(
            push(sync_session, assignment.inspector_a, draft(assignment.context))
        )
        try:
            await wait_for_blocked(database, pid, blocker)
            await cancel_inspection_booking(
                assignment.context.booking_id,
                InspectionBookingCancelRequest(),
                admin_session,
                admin,
            )
            result = await asyncio.wait_for(task, 10)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        assert result.results[0].error_code == "WORK_CONTEXT_STALE"
    async with database() as session:
        assert (
            await session.scalar(
                select(func.count())
                .select_from(Inspection)
                .where(
                    Inspection.booking_id.in_([assignment.context.booking_id, later_id])
                )
            )
            == 0
        )


@pytest.mark.asyncio
async def test_simultaneous_identical_retries_are_idempotent(
    database: async_sessionmaker[AsyncSession],
    assignment: Assignment,
) -> None:
    from hms_backend.app.models.foundation import Device

    async with database() as session:
        device = await session.get(Device, "race-device")
        if device is None:
            session.add(
                Device(
                    device_id="race-device",
                    user_id=assignment.inspector_a.user_id,
                    platform="test",
                    app_version="1",
                )
            )
            await session.commit()
    payload = draft(assignment.context)
    payload.operations[0].payload["pressure_test"] = {
        "applied_pressure_kpa": 1750,
        "hold_time_seconds": 360,
        "passed": True,
    }
    async with database() as first, database() as second:
        blocker = await lock_booking(first, assignment.context.booking_id)
        await first.execute(
            select(Device).where(Device.device_id == "race-device").with_for_update()
        )
        pid = await backend_pid(second)
        task = asyncio.create_task(push(second, assignment.inspector_a, payload))
        try:
            await wait_for_blocked(database, pid, blocker)
            result1 = await push(first, assignment.inspector_a, payload)
            result2 = await asyncio.wait_for(task, 10)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        assert result1.results[0].status == "applied"
        assert result1.results == result2.results
    async with database() as session:
        assert (
            await session.scalar(
                select(func.count())
                .select_from(Inspection)
                .where(Inspection.booking_id == assignment.context.booking_id)
            )
            == 1
        )
        assert (
            await session.scalar(
                select(func.count())
                .select_from(PressureTestResult)
                .where(
                    PressureTestResult.inspection_id == payload.operations[0].entity_id
                )
            )
            == 1
        )
