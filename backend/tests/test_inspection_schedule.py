"""``GET /inspection-schedule``: the bounded read behind the Staff calendar."""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import event, select, text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.modules.customers.models import Customer, CustomerLocation
from hms_backend.app.modules.identity.models import AccountStatus, User
from hms_backend.app.modules.inspections.models import (
    InspectionAppointment,
    InspectionAppointmentChangeRequest,
    InspectionAppointmentRevision,
    InspectionAvailabilityQuote,
    InspectionBooking,
)

ADMIN = Principal("admin-1", frozenset({Role.HMS_ADMIN}), frozenset())
URL = "/api/v1/inspection-schedule"


def utc(year: int, month: int, day: int, hour: int = 0) -> datetime:
    return datetime(year, month, day, hour, tzinfo=UTC)


POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")


@pytest_asyncio.fixture(
    params=[
        "sqlite",
        pytest.param(
            "postgres",
            marks=pytest.mark.skipif(
                not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
            ),
        ),
    ]
)
async def database(
    request: pytest.FixtureRequest,
) -> AsyncGenerator[tuple[AsyncEngine, async_sessionmaker[AsyncSession]]]:
    """A private schema on PostgreSQL, so shared test data is never touched."""
    if request.param == "sqlite":
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        yield engine, async_sessionmaker(engine, expire_on_commit=False)
        await engine.dispose()
        return
    assert POSTGRES_URL is not None
    schema = f"schedule_{uuid4().hex[:12]}"
    admin = create_async_engine(POSTGRES_URL)
    async with admin.begin() as connection:
        await connection.execute(text(f"CREATE SCHEMA {schema}"))
    engine = create_async_engine(
        POSTGRES_URL, connect_args={"server_settings": {"search_path": schema}}
    )
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        yield engine, async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()
        async with admin.begin() as connection:
            await connection.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        await admin.dispose()


@asynccontextmanager
async def api(
    factory: async_sessionmaker[AsyncSession], principal: Principal = ADMIN
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_principal] = lambda: principal
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        yield client


async def seed(factory: async_sessionmaker[AsyncSession]) -> dict[str, Any]:
    """Two customers/locations (Sydney and Perth) and bookings across several days."""
    async with factory() as session:
        for user_id, first, last in (
            ("insp-a", "Ada", "Archer"),
            ("insp-b", "Ben", None),
        ):
            session.add(
                User(
                    id=user_id,
                    oidc_subject=f"local:{user_id}",
                    email=f"{user_id}@example.test",
                    first_name=first,
                    last_name=last,
                    role=Role.INSPECTOR.value,
                    account_status=AccountStatus.ACTIVE.value,
                )
            )
        vopak = Customer(code="VOPA", name="Vopak")
        orica = Customer(code="ORIC", name="Orica")
        sydney = CustomerLocation(
            customer=vopak, name="Botany", scheduling_timezone="Australia/Sydney"
        )
        perth = CustomerLocation(
            customer=orica, name="Kwinana", scheduling_timezone="Australia/Perth"
        )
        session.add_all([vopak, orica, sydney, perth])
        await session.flush()

        def booking(
            customer: Customer,
            location: CustomerLocation,
            starts: datetime,
            ends: datetime | None,
            *,
            inspector: str | None,
            status: str = "APPROVED",
        ) -> InspectionBooking:
            return InspectionBooking(
                customer_id=customer.id,
                location_id=location.id,
                scheduled_at=starts,
                scheduled_end_at=ends,
                status=status,
                requested_by_user_id="customer",
                inspector_user_id=inspector,
            )

        rows = {
            "mon_a": booking(
                vopak,
                sydney,
                utc(2027, 3, 1, 0),
                utc(2027, 3, 1, 1),
                inspector="insp-a",
            ),
            "tue_b": booking(
                orica, perth, utc(2027, 3, 2, 2), utc(2027, 3, 2, 4), inspector="insp-b"
            ),
            "wed_pending": booking(
                vopak,
                sydney,
                utc(2027, 3, 3, 1),
                utc(2027, 3, 3, 2),
                inspector=None,
                status="PENDING_APPROVAL",
            ),
            "later": booking(
                vopak,
                sydney,
                utc(2027, 6, 1, 0),
                utc(2027, 6, 1, 1),
                inspector="insp-a",
            ),
            "straddle": booking(
                vopak,
                sydney,
                utc(2027, 2, 28, 23),
                utc(2027, 3, 1, 1),
                inspector="insp-b",
            ),
            "open_ended": booking(
                vopak,
                sydney,
                utc(2027, 3, 4, 3),
                None,
                inspector=None,
                status="PENDING_APPROVAL",
            ),
            "cancelled": booking(
                orica,
                perth,
                utc(2027, 3, 2, 5),
                utc(2027, 3, 2, 6),
                inspector="insp-a",
                status="CANCELLED",
            ),
        }
        session.add_all(rows.values())
        await session.flush()
        for key in ("mon_a", "tue_b", "later", "straddle"):
            row = rows[key]
            appointment = InspectionAppointment(
                booking_id=row.id,
                customer_id=row.customer_id,
                location_id=row.location_id,
                status="CONFIRMED",
            )
            session.add(appointment)
            await session.flush()
            session.add(
                InspectionAppointmentRevision(
                    appointment_id=appointment.id,
                    revision_number=1,
                    starts_at=row.scheduled_at,
                    ends_at=row.scheduled_end_at or row.scheduled_at,
                    timezone_id="Australia/Sydney"
                    if key != "tue_b"
                    else "Australia/Perth",
                    local_start_snapshot="2027-03-01T11:00:00",
                    local_end_snapshot="2027-03-01T12:00:00",
                    utc_offset_start="+11:00",
                    utc_offset_end="+11:00",
                    tzdata_version="test",
                    inspector_user_id=row.inspector_user_id,
                    created_by_user_id="admin",
                )
            )
        await session.commit()
        return {
            "ids": {key: row.id for key, row in rows.items()},
            "vopak": vopak.id,
            "orica": orica.id,
            "sydney": sydney.id,
            "perth": perth.id,
        }


def ids_of(response: httpx.Response) -> list[str]:
    assert response.status_code == 200, response.text
    return [item["id"] for item in response.json()["items"]]


WEEK = {"start": "2027-03-01T00:00:00Z", "end": "2027-03-08T00:00:00Z"}


@pytest.mark.asyncio
async def test_only_bookings_overlapping_the_range_are_returned_in_time_order(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    world = await seed(factory)
    ids = world["ids"]
    async with api(factory) as client:
        response = await client.get(URL, params=WEEK)
    assert ids_of(response) == [
        ids["straddle"],  # starts before the range but overlaps it
        ids["mon_a"],
        ids["tue_b"],
        ids["cancelled"],
        ids["wed_pending"],
        ids["open_ended"],
    ]
    assert ids["later"] not in ids_of(response)
    body = response.json()
    assert body["total"] == 6
    assert body["start"].startswith("2027-03-01") and body["end"].startswith(
        "2027-03-08"
    )


@pytest.mark.asyncio
async def test_range_edges_are_half_open(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    world = await seed(factory)
    ids = world["ids"]
    async with api(factory) as client:
        # mon_a is 00:00-01:00 on 1 March. A range starting exactly when it ends does
        # not include it; one ending exactly when it starts does not either.
        after = await client.get(
            URL, params={"start": "2027-03-01T01:00:00Z", "end": "2027-03-01T02:00:00Z"}
        )
        before = await client.get(
            URL, params={"start": "2027-02-28T00:00:00Z", "end": "2027-03-01T00:00:00Z"}
        )
    assert ids["mon_a"] not in ids_of(after)
    assert ids["mon_a"] not in ids_of(before)
    assert ids["straddle"] not in ids_of(after)  # it also ends at 01:00


@pytest.mark.asyncio
async def test_filters_apply_in_the_database(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    world = await seed(factory)
    ids = world["ids"]
    async with api(factory) as client:
        by_inspector = await client.get(
            URL, params={**WEEK, "inspector_user_id": "insp-a"}
        )
        by_customer = await client.get(
            URL, params={**WEEK, "customer_id": world["orica"]}
        )
        by_location = await client.get(
            URL, params={**WEEK, "location_id": world["perth"]}
        )
        by_status = await client.get(URL, params={**WEEK, "status": "PENDING_APPROVAL"})
        unassigned = await client.get(URL, params={**WEEK, "unassigned": "true"})
    assert ids_of(by_inspector) == [ids["mon_a"], ids["cancelled"]]
    assert ids_of(by_customer) == [ids["tue_b"], ids["cancelled"]]
    assert ids_of(by_location) == ids_of(by_customer)
    assert set(ids_of(by_status)) == {ids["wed_pending"], ids["open_ended"]}
    assert set(ids_of(unassigned)) == {ids["wed_pending"], ids["open_ended"]}


@pytest.mark.asyncio
async def test_entries_carry_the_persisted_appointment_snapshot_and_inspector_names(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    world = await seed(factory)
    async with api(factory) as client:
        response = await client.get(URL, params={**WEEK, "inspector_user_id": "insp-a"})
        everyone = await client.get(URL, params=WEEK)
    body = response.json()
    first = body["items"][0]
    assert first["appointment"]["timezone_id"] == "Australia/Sydney"
    assert first["appointment"]["local_start_snapshot"] == "2027-03-01T11:00:00"
    assert first["appointment"]["utc_offset_start"] == "+11:00"
    assert first["location"]["scheduling_timezone"] == "Australia/Sydney"
    assert first["customer"]["name"] == "Vopak"
    assert {"id": "insp-a", "display_name": "Ada Archer"} in body["inspectors"]
    # An inspector with no surname falls back to what exists; nobody is a bare UUID.
    assert {"id": "insp-b", "display_name": "Ben"} in everyone.json()["inspectors"]
    assert world["sydney"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "params",
    [
        {"start": "2027-03-08T00:00:00Z", "end": "2027-03-01T00:00:00Z"},
        {"start": "2027-03-01T00:00:00Z", "end": "2027-03-01T00:00:00Z"},
        {"start": "2027-01-01T00:00:00Z", "end": "2027-03-01T00:00:00Z"},
        {"start": "2027-03-01T00:00:00", "end": "2027-03-08T00:00:00"},
        {"start": "2027-03-01T00:00:00Z"},
        {**WEEK, "limit": "1001"},
    ],
    ids=[
        "reversed",
        "empty",
        "too-wide",
        "no-timezone",
        "missing-end",
        "limit-too-big",
    ],
)
async def test_the_range_is_validated_and_bounded(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
    params: dict[str, str],
) -> None:
    _, factory = database
    await seed(factory)
    async with api(factory) as client:
        response = await client.get(URL, params=params)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_a_large_table_does_not_widen_the_work_or_the_response(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    engine, factory = database
    world = await seed(factory)

    def counted(fn_params: dict[str, str]) -> Any:
        async def run() -> tuple[int, int]:
            statements: list[str] = []

            def record(*args: Any) -> None:
                statements.append(str(args[2]))

            event.listen(engine.sync_engine, "before_cursor_execute", record)
            try:
                async with api(factory) as client:
                    response = await client.get(URL, params=fn_params)
            finally:
                event.remove(engine.sync_engine, "before_cursor_execute", record)
            assert response.status_code == 200
            return len(statements), len(response.json()["items"])

        return run()

    small_statements, small_items = await counted(WEEK)

    async with factory() as session:
        for index in range(400):
            session.add(
                InspectionBooking(
                    customer_id=world["vopak"],
                    location_id=world["sydney"],
                    scheduled_at=utc(2028, 1, 1) + timedelta(hours=index),
                    scheduled_end_at=utc(2028, 1, 1) + timedelta(hours=index + 1),
                    status="PENDING_APPROVAL",
                    requested_by_user_id="customer",
                )
            )
        await session.commit()

    large_statements, large_items = await counted(WEEK)
    assert large_items == small_items  # the new rows are outside the range
    assert large_statements == small_statements  # no per-row queries, no fetch-all
    # ...and the same endpoint still pages inside a busy range.
    async with api(factory) as client:
        busy = await client.get(
            URL,
            params={
                "start": "2028-01-01T00:00:00Z",
                "end": "2028-01-15T00:00:00Z",
                "limit": "50",
            },
        )
    assert len(busy.json()["items"]) == 50
    assert busy.json()["total"] == 336


@pytest.mark.asyncio
async def test_customers_only_see_their_own_bookings_and_inspectors_only_theirs(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    world = await seed(factory)
    ids = world["ids"]
    customer = Principal(
        "cust", frozenset({Role.CUSTOMER_USER}), frozenset({world["orica"]})
    )
    async with api(factory, customer) as client:
        own = await client.get(URL, params=WEEK)
        other = await client.get(URL, params={**WEEK, "customer_id": world["vopak"]})
    assert set(ids_of(own)) == {ids["tue_b"], ids["cancelled"]}
    assert ids_of(other) == []

    inspector = Principal("insp-a", frozenset({Role.INSPECTOR}), frozenset())
    async with api(factory, inspector) as client:
        mine = await client.get(URL, params=WEEK)
    # Only approved bookings with a confirmed appointment assigned to this inspector.
    assert ids_of(mine) == [ids["mon_a"]]


@pytest.mark.asyncio
async def test_users_without_scheduling_read_access_are_refused(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    await seed(factory)
    nobody = Principal("nobody", frozenset(), frozenset())
    async with api(factory, nobody) as client:
        response = await client.get(URL, params=WEEK)
    assert response.status_code in {401, 403}


@pytest.mark.asyncio
async def test_the_pending_change_filter_finds_bookings_awaiting_a_decision(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    world = await seed(factory)
    ids = world["ids"]
    async with factory() as session:
        booking = await session.get(InspectionBooking, ids["mon_a"])
        other = await session.get(InspectionBooking, ids["tue_b"])
        assert booking is not None and other is not None
        appointment = (
            await session.scalars(
                select(InspectionAppointment).where(
                    InspectionAppointment.booking_id.in_([booking.id, other.id])
                )
            )
        ).all()
        by_booking = {item.booking_id: item for item in appointment}
        quote = InspectionAvailabilityQuote(
            customer_id=booking.customer_id,
            location_id=booking.location_id,
            starts_at=utc(2027, 3, 5, 1),
            ends_at=utc(2027, 3, 5, 2),
            candidate_inspector_ids=["insp-a"],
            expires_at=utc(2030, 1, 1),
        )
        session.add(quote)
        await session.flush()
        for target, state in ((booking, "PENDING_ADMIN_APPROVAL"), (other, "APPLIED")):
            session.add(
                InspectionAppointmentChangeRequest(
                    booking_id=target.id,
                    appointment_id=by_booking[target.id].id,
                    availability_quote_id=quote.id,
                    requested_by_user_id="customer",
                    status=state,
                )
            )
        await session.commit()
    async with api(factory) as client:
        response = await client.get(
            "/api/v1/inspection-bookings", params={"has_pending_change": "true"}
        )
    assert [item["id"] for item in response.json()["items"]] == [ids["mon_a"]]


@pytest.mark.asyncio
async def test_six_local_weeks_across_a_daylight_saving_change_fit_the_cap(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    """The Month view asks for 42 local days; a 25-hour day makes that 42 days + 1h."""
    _, factory = database
    await seed(factory)
    async with api(factory) as client:
        month = await client.get(
            URL,
            params={"start": "2027-02-28T13:00:00Z", "end": "2027-04-11T14:00:00Z"},
        )
        too_wide = await client.get(
            URL,
            params={"start": "2027-02-28T13:00:00Z", "end": "2027-04-13T14:00:00Z"},
        )
    assert month.status_code == 200
    assert too_wide.status_code == 422
