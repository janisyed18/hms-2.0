"""The paged, resumable sync bootstrap (protocol 2) and its legacy path."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from collections.abc import AsyncGenerator, Awaitable, Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from datetime import UTC, date, datetime
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

import hms_backend.app.api.sync as sync_module
import hms_backend.app.api.sync_bootstrap as bootstrap_module
from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.api.sync_bootstrap import (
    BOOTSTRAP_ENTITY_ORDER,
    PageToken,
    _signing_key,
    encode_page_token,
)
from hms_backend.app.core.config import settings
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.core.repository import record_create, record_update, soft_delete
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.customers.models import Customer, CustomerLocation
from hms_backend.app.modules.identity.models import User
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionAppointment,
    InspectionAppointmentRevision,
    InspectionBooking,
    InspectionBookingAsset,
)
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.reference.models import Standard
from hms_backend.app.modules.scheduling.models import (
    RetestSchedule,
    RetestScheduleStatus,
)

INSPECTOR = "inspector-1"
OTHER_INSPECTOR = "inspector-2"
URL = "/api/v1/sync/bootstrap"


def headers(device: str = "tablet-1", *, paged: bool = True) -> dict[str, str]:
    result = {
        "X-HMS-Device-Id": device,
        "X-HMS-Device-Platform": "web",
        "X-HMS-App-Version": "0.2.0" if paged else "0.1.0",
    }
    if paged:
        result["X-HMS-Sync-Protocol"] = "2"
    return result


def inspector(user: str = INSPECTOR) -> Principal:
    return Principal(
        user_id=user, roles=frozenset({Role.INSPECTOR}), customer_ids=frozenset()
    )


@pytest.fixture(autouse=True)
def _no_api_rate_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    """These tests make hundreds of requests; the per-IP limiter is not under test."""
    monkeypatch.setattr(settings, "security_api_rate_limit_max_requests", 10**9)


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
    """A private schema, so the PostgreSQL lane never touches shared test data."""
    if request.param == "sqlite":
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        yield engine, async_sessionmaker(engine, expire_on_commit=False)
        await engine.dispose()
        return
    assert POSTGRES_URL is not None
    schema = f"paging_{uuid4().hex[:12]}"
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
    factory: async_sessionmaker[AsyncSession], principal: Principal
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_principal] = lambda: principal
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
    ) as client:
        yield client


async def seed_world(
    factory: async_sessionmaker[AsyncSession],
    *,
    assets: int,
    noise_assets: int = 0,
) -> dict[str, Any]:
    """``assets`` hoses assigned to INSPECTOR, plus ``noise_assets`` for someone else.

    Each assigned hose contributes an Asset, a RetestSchedule and a work context, so the
    inspector sees about ``3 * assets`` items; the noise must never be returned.
    """
    async with factory() as session:
        standard = Standard(code="AS2683", name="AS2683")
        product = Product(
            category="Composite",
            sub_category="Petrol & Oil",
            code="P1",
            name="Hose",
            standard=standard,
        )
        mine = Customer(code="MINE", name="Mine")
        theirs = Customer(code="THEM", name="Theirs")
        mine_site = CustomerLocation(customer=mine, name="Site A")
        theirs_site = CustomerLocation(customer=theirs, name="Site B")
        session.add_all([standard, product, mine, theirs, mine_site, theirs_site])
        session.add_all(
            User(
                id=user,
                oidc_subject=f"subject-{user}",
                email=f"{user}@example.test",
                role=Role.INSPECTOR.value,
            )
            for user in (INSPECTOR, OTHER_INSPECTOR)
        )
        await session.flush()

        def booking_for(
            customer: Customer, site: CustomerLocation, owner: str
        ) -> InspectionBooking:
            return InspectionBooking(
                customer_id=customer.id,
                location_id=site.id,
                scheduled_at=datetime(2026, 10, 20, tzinfo=UTC),
                status="APPROVED",
                requested_by_user_id="customer",
                inspector_user_id=owner,
            )

        mine_booking = booking_for(mine, mine_site, INSPECTOR)
        theirs_booking = booking_for(theirs, theirs_site, OTHER_INSPECTOR)
        session.add_all([mine_booking, theirs_booking])
        await session.flush()
        for booking, owner in (
            (mine_booking, INSPECTOR),
            (theirs_booking, OTHER_INSPECTOR),
        ):
            appointment = InspectionAppointment(
                booking_id=booking.id,
                customer_id=booking.customer_id,
                location_id=booking.location_id,
                status="CONFIRMED",
            )
            session.add(appointment)
            await session.flush()
            session.add(
                InspectionAppointmentRevision(
                    appointment_id=appointment.id,
                    revision_number=1,
                    starts_at=datetime(2026, 10, 20, tzinfo=UTC),
                    ends_at=datetime(2026, 10, 20, 1, tzinfo=UTC),
                    timezone_id="UTC",
                    local_start_snapshot="2026-10-20T00:00:00",
                    local_end_snapshot="2026-10-20T01:00:00",
                    utc_offset_start="+00:00",
                    utc_offset_end="+00:00",
                    tzdata_version="test",
                    inspector_user_id=owner,
                    created_by_user_id="admin",
                )
            )

        async def add_assets(
            customer: Customer,
            site: CustomerLocation,
            booking: InspectionBooking,
            count: int,
            prefix: str,
        ) -> list[str]:
            ids: list[str] = []
            for start in range(0, count, 500):
                batch = []
                for number in range(start, min(count, start + 500)):
                    asset = Asset(
                        customer_id=customer.id,
                        location_id=site.id,
                        product_id=product.id,
                        asset_number=f"{prefix}{number:06d}",
                        lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
                    )
                    asset.retest_schedule = RetestSchedule(
                        customer_id=customer.id,
                        due_at=date(2026, 11, 2),
                        status=RetestScheduleStatus.UPCOMING.value,
                        reminder_interval_days=30,
                        escalation_interval_days=7,
                    )
                    batch.append(asset)
                session.add_all(batch)
                await session.flush()
                session.add_all(
                    InspectionBookingAsset(booking_id=booking.id, asset_id=asset.id)
                    for asset in batch
                )
                await session.flush()
                ids.extend(asset.id for asset in batch)
            return ids

        mine_ids = await add_assets(mine, mine_site, mine_booking, assets, "M")
        theirs_ids = await add_assets(
            theirs, theirs_site, theirs_booking, noise_assets, "T"
        )
        await session.commit()
        return {
            "mine": mine.id,
            "theirs": theirs.id,
            "mine_booking": mine_booking.id,
            "mine_assets": mine_ids,
            "theirs_assets": theirs_ids,
            "product": product.id,
        }


def keys(pages: list[dict[str, Any]]) -> list[tuple[str, str]]:
    return [(r["entity"], r["entity_id"]) for page in pages for r in page["records"]]


def context_keys(pages: list[dict[str, Any]]) -> list[tuple[str, str]]:
    return [
        (c["appointment_id"], c["assignment_id"])
        for page in pages
        for c in page["work_contexts"]
    ]


async def traverse(
    client: httpx.AsyncClient,
    request_headers: dict[str, str],
    *,
    limit: int | None = None,
    after_page: Callable[[int, dict[str, Any]], Awaitable[None]] | None = None,
) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []
    token: str | None = None
    while True:
        params: dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if token is not None:
            params["page_token"] = token
        response = await client.get(URL, params=params, headers=request_headers)
        assert response.status_code == 200, response.text
        body = response.json()
        pages.append(body)
        if after_page is not None:
            await after_page(len(pages), body)
        if not body["has_more"]:
            assert body["next_page_token"] is None
            return pages
        token = body["next_page_token"]
        assert token


@contextmanager
def counting(engine: AsyncEngine) -> Iterator[list[str]]:
    statements: list[str] = []

    def record(*args: Any) -> None:
        statements.append(str(args[2]))

    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        yield statements
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)


async def oracle(
    factory: async_sessionmaker[AsyncSession], principal: Principal
) -> tuple[set[tuple[str, str]], set[tuple[str, str]]]:
    """What the old row-by-row bootstrap would have returned (small data only)."""
    seen: set[tuple[str, str]] = set()
    async with factory() as session:
        for name in BOOTSTRAP_ENTITY_ORDER:
            model = bootstrap_module.SYNC_MODELS[name]
            for row in (
                await session.scalars(select(model).where(model.deleted_at.is_(None)))
            ).all():
                if await sync_module._row_visible(session, principal, name, row.id):
                    seen.add((name, row.id))
        contexts = {
            (c.appointment_id, c.assignment_id)
            for c in await sync_module._inspector_work_contexts(session, principal)
        }
    return seen, contexts


# --- protocol shape and limits --------------------------------------------------------


@pytest.mark.asyncio
async def test_default_page_size_is_200_and_the_hard_maximum_is_500(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    await seed_world(factory, assets=150)
    async with api(factory, inspector()) as client:
        first = await client.get(URL, headers=headers())
        too_big = await client.get(URL, params={"limit": 501}, headers=headers())
        zero = await client.get(URL, params={"limit": 0}, headers=headers())
        biggest = await client.get(URL, params={"limit": 500}, headers=headers())
    assert first.status_code == 200
    body = first.json()
    assert body["protocol_version"] == 2
    assert body["page_size"] == 200
    assert len(body["records"]) + len(body["work_contexts"]) == 200
    assert body["has_more"] is True and body["next_page_token"]
    assert too_big.status_code == 422
    assert zero.status_code == 422
    assert biggest.json()["page_size"] == 500


@pytest.mark.asyncio
async def test_the_protocol_header_must_be_a_number(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    async with api(factory, inspector()) as client:
        response = await client.get(
            URL, headers={**headers(), "X-HMS-Sync-Protocol": "two"}
        )
    assert response.status_code == 400


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", [1, 7, 50, 200])
async def test_a_full_traversal_returns_every_visible_item_exactly_once(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]], limit: int
) -> None:
    _, factory = database
    world = await seed_world(factory, assets=40, noise_assets=25)
    expected_records, expected_contexts = await oracle(factory, inspector())
    async with api(factory, inspector()) as client:
        pages = await traverse(client, headers(), limit=limit)
    assert all(
        len(page["records"]) + len(page["work_contexts"]) <= limit for page in pages
    )
    assert len({page["cursor"] for page in pages}) == 1
    assert len(keys(pages)) == len(set(keys(pages)))
    assert set(keys(pages)) == expected_records
    assert len(context_keys(pages)) == len(set(context_keys(pages)))
    assert set(context_keys(pages)) == expected_contexts
    asset_ids = {entity_id for entity, entity_id in keys(pages) if entity == "Asset"}
    assert asset_ids == set(world["mine_assets"])
    assert not asset_ids & set(world["theirs_assets"])
    # Only the final page ends the traversal.
    assert [page["has_more"] for page in pages] == [True] * (len(pages) - 1) + [False]
    assert pages[-1]["scope_changed"] is False


@pytest.mark.asyncio
async def test_a_page_that_ends_exactly_on_the_last_item_does_not_promise_more(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    await seed_world(factory, assets=3)
    async with api(factory, inspector()) as client:
        everything = await traverse(client, headers(), limit=500)
        total = len(keys(everything)) + len(context_keys(everything))
        exact = await traverse(client, headers(), limit=total)
    assert len(exact) == 1
    assert exact[0]["has_more"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "principal",
    [
        Principal("staff", frozenset({Role.HMS_ADMIN}), frozenset()),
        Principal("cust", frozenset({Role.CUSTOMER_USER}), frozenset({"MINE-ID"})),
        inspector(),
        inspector(OTHER_INSPECTOR),
    ],
    ids=["staff", "customer", "inspector", "other-inspector"],
)
async def test_paged_scope_equals_the_old_row_by_row_visibility(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
    principal: Principal,
) -> None:
    _, factory = database
    world = await seed_world(factory, assets=12, noise_assets=9)
    async with factory() as session:
        inspection = Inspection(
            asset_id=world["mine_assets"][0],
            booking_id=world["mine_booking"],
            inspection_type="SERVICE",
            status="DRAFT",
            inspector_user_id=INSPECTOR,
        )
        session.add(inspection)
        await session.commit()
    if Role.CUSTOMER_USER in principal.roles:
        principal = Principal(
            principal.user_id, principal.roles, frozenset({world["mine"]})
        )
    expected_records, expected_contexts = await oracle(factory, principal)
    async with api(factory, principal) as client:
        pages = await traverse(client, headers(f"d-{principal.user_id}"), limit=11)
    assert set(keys(pages)) == expected_records
    assert set(context_keys(pages)) == expected_contexts
    assert expected_records, "the comparison must not be vacuous"


# --- scale ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bootstrap_work_does_not_grow_with_the_table_size(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine, factory = database

    async def forbidden(*_: Any, **__: Any) -> bool:
        raise AssertionError("bootstrap must not check visibility row by row")

    monkeypatch.setattr(sync_module, "_row_visible", forbidden)

    async def measure(principal: Principal, device: str) -> dict[str, Any]:
        per_page: list[int] = []
        async with api(factory, principal) as client:
            pages: list[dict[str, Any]] = []
            token: str | None = None
            while True:
                params: dict[str, Any] = {"limit": 200}
                if token:
                    params["page_token"] = token
                with counting(engine) as statements:
                    response = await client.get(
                        URL, params=params, headers=headers(device)
                    )
                assert response.status_code == 200, response.text
                per_page.append(len(statements))
                body = response.json()
                assert len(body["records"]) + len(body["work_contexts"]) <= 200, (
                    "a page exceeded its budget"
                )
                pages.append(body)
                token = body["next_page_token"]
                if not body["has_more"]:
                    break
        return {
            "pages": pages,
            "per_page": per_page,
            "items": len(keys(pages)) + len(context_keys(pages)),
        }

    await seed_world(factory, assets=20, noise_assets=20)
    small = await measure(inspector(), "small-device")

    # A bigger table: 2,600 more of the inspector's hoses (at least 5,000 scoped
    # records in total once schedules and contexts are counted) and 2,600 unrelated.
    await seed_world_more(factory, mine=2_600, other=2_600)
    large = await measure(inspector(), "large-device")

    assert large["items"] >= 5_000 > small["items"] * 10
    assert len(keys(large["pages"])) == len(set(keys(large["pages"])))
    # Statements per page are bounded by the number of sections, not by rows.
    assert max(large["per_page"]) <= 60
    assert max(small["per_page"]) <= 60
    assert max(large["per_page"]) <= max(small["per_page"]) + 15
    # One page per `limit` items: total statements track pages, not table rows.
    assert sum(large["per_page"]) <= 60 * len(large["pages"])
    # The unrelated rows never reach the wire.
    returned_assets = {e for ent, e in keys(large["pages"]) if ent == "Asset"}
    async with factory() as session:
        theirs = {
            a.id
            for a in (
                await session.scalars(
                    select(Asset).where(Asset.asset_number.like("T%"))
                )
            ).all()
        }
    assert theirs and not returned_assets & theirs


async def seed_world_more(
    factory: async_sessionmaker[AsyncSession], *, mine: int, other: int
) -> None:
    async with factory() as session:
        customers = {c.code: c for c in (await session.scalars(select(Customer))).all()}
        sites = {
            s.customer_id: s
            for s in (await session.scalars(select(CustomerLocation))).all()
        }
        bookings = {
            b.inspector_user_id: b
            for b in (await session.scalars(select(InspectionBooking))).all()
        }
        product = (await session.scalars(select(Product))).one()
        for code, count, owner, prefix in (
            ("MINE", mine, INSPECTOR, "M2"),
            ("THEM", other, OTHER_INSPECTOR, "T2"),
        ):
            customer = customers[code]
            for start in range(0, count, 500):
                batch = []
                for number in range(start, min(count, start + 500)):
                    asset = Asset(
                        customer_id=customer.id,
                        location_id=sites[customer.id].id,
                        product_id=product.id,
                        asset_number=f"{prefix}{number:06d}",
                        lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
                    )
                    asset.retest_schedule = RetestSchedule(
                        customer_id=customer.id,
                        due_at=date(2026, 11, 2),
                        status=RetestScheduleStatus.UPCOMING.value,
                        reminder_interval_days=30,
                        escalation_interval_days=7,
                    )
                    batch.append(asset)
                session.add_all(batch)
                await session.flush()
                session.add_all(
                    InspectionBookingAsset(
                        booking_id=bookings[owner].id, asset_id=asset.id
                    )
                    for asset in batch
                )
                await session.flush()
        await session.commit()


# --- continuation token ---------------------------------------------------------------


async def first_page(
    client: httpx.AsyncClient, device: str = "tablet-1", limit: int = 5
) -> dict[str, Any]:
    response = await client.get(URL, params={"limit": limit}, headers=headers(device))
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def resume_point(token: str) -> dict[str, Any]:
    body = token.split(".")[0]
    data: dict[str, Any] = json.loads(
        base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
    )
    data.pop("t")
    return data


def invalid(response: httpx.Response) -> bool:
    return (
        response.status_code == 400
        and response.json()["detail"]["code"] == "SYNC_PAGE_TOKEN_INVALID"
    )


def signed(payload: dict[str, Any]) -> str:
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    signature = hmac.new(_signing_key(), body, hashlib.sha256).digest()

    def enc(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    return f"{enc(body)}.{enc(signature)}"


def good_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "v": 1,
        "pv": 2,
        "s": 0,
        "i": 0,
        "k": None,
        "u": INSPECTOR,
        "d": "tablet-1",
        "f": "unscoped",
        "t": int(time.time()),
    }
    payload.update(overrides)
    return payload


@pytest.mark.asyncio
async def test_a_replayed_token_returns_the_same_page(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    await seed_world(factory, assets=10)
    async with api(factory, inspector()) as client:
        token = (await first_page(client))["next_page_token"]
        one = await client.get(
            URL, params={"limit": 5, "page_token": token}, headers=headers()
        )
        two = await client.get(
            URL, params={"limit": 5, "page_token": token}, headers=headers()
        )
    assert one.status_code == two.status_code == 200
    assert one.json()["records"] == two.json()["records"]
    # Tokens differ only in their issue time.
    assert resume_point(one.json()["next_page_token"]) == resume_point(
        two.json()["next_page_token"]
    )


@pytest.mark.asyncio
async def test_tampered_malformed_and_unknown_version_tokens_are_refused(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    await seed_world(factory, assets=10)
    async with api(factory, inspector()) as client:
        token = (await first_page(client))["next_page_token"]
        body, signature = token.split(".")
        forged = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        forged["s"] = 0
        forged["i"] = 0
        forged_body = (
            base64.urlsafe_b64encode(json.dumps(forged, sort_keys=True).encode())
            .rstrip(b"=")
            .decode()
        )
        candidates = {
            "flipped-signature": f"{body}.{signature[:-2]}AA",
            "forged-body-old-signature": f"{forged_body}.{signature}",
            "no-separator": "abc",
            "empty-parts": ".",
            "not-base64": "!!!.???",
            "not-json": signed_raw(b"not json"),
            "json-not-object": signed_raw(b"[1,2]"),
            "unknown-version": signed(good_payload(v=2)),
            "unknown-protocol": signed(good_payload(pv=3)),
            "section-out-of-range": signed(good_payload(i=99)),
            "negative-section": signed(good_payload(i=-1)),
            "string-snapshot": signed(good_payload(s="0")),
            "bool-snapshot": signed(good_payload(s=True)),
            "wrong-key-shape-for-entity": signed(good_payload(i=3, k=["a", "b"])),
            "wrong-key-shape-for-contexts": signed(
                good_payload(i=bootstrap_module.WORK_CONTEXT_SECTION, k=["only-one"])
            ),
            "empty-key": signed(good_payload(i=3, k=[""])),
            "expired": signed(good_payload(t=int(time.time()) - 7 * 3600)),
            "from-the-future": signed(good_payload(t=int(time.time()) + 3600)),
        }
        results = {
            name: await client.get(
                URL, params={"limit": 5, "page_token": value}, headers=headers()
            )
            for name, value in candidates.items()
        }
    for name, response in results.items():
        assert invalid(response), f"{name}: {response.status_code} {response.text}"


def signed_raw(body: bytes) -> str:
    signature = hmac.new(_signing_key(), body, hashlib.sha256).digest()

    def enc(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    return f"{enc(body)}.{enc(signature)}"


@pytest.mark.asyncio
async def test_a_token_only_works_for_the_user_and_device_it_was_issued_to(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    await seed_world(factory, assets=10)
    async with api(factory, inspector()) as client:
        token = (await first_page(client))["next_page_token"]
        other_device = await client.get(
            URL, params={"page_token": token}, headers=headers("tablet-2")
        )
    async with api(factory, inspector(OTHER_INSPECTOR)) as client:
        other_user = await client.get(
            URL, params={"page_token": token}, headers=headers("tablet-1")
        )
    assert invalid(other_device)
    assert invalid(other_user) or other_user.status_code == 403


@pytest.mark.asyncio
async def test_a_token_is_not_authorisation_a_revoked_device_is_refused(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    await seed_world(factory, assets=10)
    async with api(factory, inspector()) as client:
        token = (await first_page(client))["next_page_token"]
    async with factory() as session:
        from hms_backend.app.models.foundation import Device

        device = (await session.scalars(select(Device))).one()
        device.revoked = True
        await session.commit()
    async with api(factory, inspector()) as client:
        refused = await client.get(URL, params={"page_token": token}, headers=headers())
    assert refused.status_code == 403


@pytest.mark.asyncio
async def test_removing_access_between_pages_shrinks_later_pages_and_flags_the_scope(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    """The token never carries permission: page two uses the *current* assignment."""
    _, factory = database
    world = await seed_world(factory, assets=30)
    async with factory() as session:
        booking = await session.get(InspectionBooking, world["mine_booking"])
        assert booking is not None

    async def unassign(page_number: int, _: dict[str, Any]) -> None:
        if page_number != 1:
            return
        async with factory() as session:
            booking = await session.get(InspectionBooking, world["mine_booking"])
            assert booking is not None
            booking.inspector_user_id = OTHER_INSPECTOR
            await session.commit()

    async with api(factory, inspector()) as client:
        pages = await traverse(client, headers(), limit=10, after_page=unassign)
    returned_assets = [e for ent, e in keys(pages) if ent == "Asset"]
    assert len(returned_assets) < 30  # later pages no longer include revoked work
    assert pages[-1]["scope_changed"] is True


# --- convergence with the change feed ---


async def pull(
    client: httpx.AsyncClient, request_headers: dict[str, str], since: int
) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    while True:
        response = await client.get(
            "/api/v1/sync/changes",
            params={"since": since, "limit": 500},
            headers=request_headers,
        )
        assert response.status_code == 200, response.text
        body = response.json()
        changes.extend(body["changes"])
        since = body["cursor"]
        if not body["has_more"]:
            return changes


async def converge(
    client: httpx.AsyncClient,
    request_headers: dict[str, str],
    *,
    limit: int,
    after_page: Callable[[int, dict[str, Any]], Awaitable[None]] | None = None,
) -> dict[tuple[str, str], int]:
    """What the Inspector ends with: pages, then the change feed from the watermark."""
    for attempt in range(3):
        pages = await traverse(
            client,
            request_headers,
            limit=limit,
            after_page=after_page if attempt == 0 else None,
        )
        if pages[-1]["scope_changed"]:
            continue
        state = {
            (r["entity"], r["entity_id"]): r["version"]
            for page in pages
            for r in page["records"]
        }
        for change in await pull(client, request_headers, pages[0]["cursor"]):
            key = (change["entity"], change["entity_id"])
            if change["op"] == "delete":
                state.pop(key, None)
            else:
                state[key] = change["version"]
        return state
    raise AssertionError("bootstrap kept restarting")


async def settled_truth(
    client: httpx.AsyncClient, request_headers: dict[str, str]
) -> dict[tuple[str, str], int]:
    pages = await traverse(client, request_headers, limit=500)
    return {
        (r["entity"], r["entity_id"]): r["version"]
        for page in pages
        for r in page["records"]
    }


@pytest.mark.asyncio
async def test_a_visible_row_created_updated_and_deleted_mid_bootstrap_converges(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    world = await seed_world(factory, assets=30)
    early, late, doomed, doomed_late = (
        world["mine_assets"][0],
        world["mine_assets"][-1],
        world["mine_assets"][1],
        world["mine_assets"][-2],
    )
    created: dict[str, str] = {}

    async def mutate(page_number: int, _: dict[str, Any]) -> None:
        if page_number != 1:
            return
        async with factory() as session:
            for asset_id in (early, late):
                asset = await session.get(Asset, asset_id)
                assert asset is not None
                before = asset.to_audit_dict()
                asset.tag = f"edited-{asset_id}"
                await record_update(
                    session,
                    asset,
                    actor_id="admin",
                    action="asset.update",
                    before=before,
                )
            for asset_id in (doomed, doomed_late):
                asset = await session.get(Asset, asset_id)
                assert asset is not None
                await soft_delete(
                    session, asset, actor_id="admin", action="asset.delete"
                )
            inspection = Inspection(
                asset_id=world["mine_assets"][2],
                booking_id=world["mine_booking"],
                inspection_type="SERVICE",
                status="DRAFT",
                inspector_user_id=INSPECTOR,
            )
            session.add(inspection)
            await record_create(
                session, inspection, actor_id="admin", action="inspection.create"
            )
            created["id"] = inspection.id
            await session.commit()

    async with api(factory, inspector()) as client:
        converged = await converge(client, headers(), limit=10, after_page=mutate)
        truth = await settled_truth(client, headers("tablet-truth"))
    assert ("Inspection", created["id"]) in converged
    assert ("Asset", doomed) not in converged
    assert ("Asset", doomed_late) not in converged
    assert converged == truth


@pytest.mark.asyncio
async def test_a_scope_change_mid_bootstrap_is_flagged_and_the_restart_converges(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    world = await seed_world(factory, assets=20)
    added: list[str] = []

    async def assign_more(page_number: int, _: dict[str, Any]) -> None:
        if page_number != 1:
            return
        async with factory() as session:
            asset = Asset(
                customer_id=world["mine"],
                product_id=world["product"],
                asset_number="ADDED-1",
                lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
            )
            session.add(asset)
            await record_create(session, asset, actor_id="admin", action="asset.create")
            session.add(
                InspectionBookingAsset(
                    booking_id=world["mine_booking"], asset_id=asset.id
                )
            )
            added.append(asset.id)
            await session.commit()

    async with api(factory, inspector()) as client:
        pages = await traverse(
            client, headers("flag"), limit=10, after_page=assign_more
        )
        assert pages[-1]["scope_changed"] is True
        converged = await converge(client, headers("again"), limit=10)
        truth = await settled_truth(client, headers("truth"))
    assert ("Asset", added[0]) in converged
    assert converged == truth


@pytest.mark.asyncio
async def test_unassignment_mid_bootstrap_flags_the_scope_and_the_restart_converges(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    world = await seed_world(factory, assets=20)
    removed = world["mine_assets"][5]

    async def unassign_one(page_number: int, _: dict[str, Any]) -> None:
        if page_number != 1:
            return
        async with factory() as session:
            link = (
                await session.scalars(
                    select(InspectionBookingAsset).where(
                        InspectionBookingAsset.asset_id == removed
                    )
                )
            ).one()
            link.deleted_at = datetime.now(UTC)
            await session.commit()

    async with api(factory, inspector()) as client:
        pages = await traverse(
            client, headers("flag"), limit=10, after_page=unassign_one
        )
        assert pages[-1]["scope_changed"] is True
        converged = await converge(client, headers("again"), limit=10)
        truth = await settled_truth(client, headers("truth"))
    assert ("Asset", removed) not in converged
    assert converged == truth


# --- old clients ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_old_client_below_the_ceiling_gets_the_single_response_shape(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    await seed_world(factory, assets=15, noise_assets=10)
    expected_records, expected_contexts = await oracle(factory, inspector())
    async with api(factory, inspector()) as client:
        response = await client.get(URL, headers=headers("old", paged=False))
    body = response.json()
    assert response.status_code == 200
    assert body["has_more"] is False
    assert body["next_page_token"] is None
    assert body["protocol_version"] == 1
    assert {(r["entity"], r["entity_id"]) for r in body["records"]} == expected_records
    assert {
        (c["appointment_id"], c["assignment_id"]) for c in body["work_contexts"]
    } == expected_contexts


@pytest.mark.asyncio
async def test_an_old_client_over_the_ceiling_is_told_to_upgrade_never_truncated(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, factory = database
    await seed_world(factory, assets=40)
    monkeypatch.setattr(sync_module, "LEGACY_BOOTSTRAP_MAX_ROWS", 50)
    budgets: list[int] = []
    real = bootstrap_module.read_page

    async def spy(*args: Any, **kwargs: Any) -> Any:
        budgets.append(kwargs["budget"])
        return await real(*args, **kwargs)

    monkeypatch.setattr("hms_backend.app.api.sync.read_page", spy)
    async with api(factory, inspector()) as client:
        old = await client.get(URL, headers=headers("old", paged=False))
        new = await traverse(client, headers("new"), limit=20)
    assert old.status_code == 426
    detail = old.json()["detail"]
    assert detail["code"] == "SYNC_CLIENT_UPGRADE_REQUIRED"
    assert detail["required_protocol"] == 2
    assert old.headers["Upgrade"] == "hms-sync/2"
    assert "records" not in old.json()
    # Materialisation was capped at the ceiling, not at the dataset size.
    assert budgets[0] == 50
    assert len(keys(new)) + len(context_keys(new)) > 50


@pytest.mark.asyncio
async def test_a_paged_client_is_never_given_the_legacy_ceiling_error(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, factory = database
    await seed_world(factory, assets=40)
    monkeypatch.setattr(sync_module, "LEGACY_BOOTSTRAP_MAX_ROWS", 5)
    async with api(factory, inspector()) as client:
        pages = await traverse(client, headers(), limit=500)
    assert len(pages) == 1 and pages[0]["has_more"] is False


def test_encoding_round_trips_and_binds_everything_it_claims() -> None:
    token = PageToken(
        snapshot=42,
        section=3,
        key=("abc",),
        user_id="u",
        device_id="d",
        fingerprint="f",
        issued_at=int(time.time()),
    )
    decoded = bootstrap_module.decode_page_token(
        encode_page_token(token), user_id="u", device_id="d"
    )
    assert decoded == token


def test_a_token_is_refused_for_a_different_user_even_on_the_same_device() -> None:
    """Defence in depth: the device check normally fires first."""
    token = encode_page_token(
        PageToken(
            snapshot=1,
            section=0,
            key=None,
            user_id="user-a",
            device_id="d",
            fingerprint="f",
            issued_at=int(time.time()),
        )
    )
    with pytest.raises(bootstrap_module.PageTokenError):
        bootstrap_module.decode_page_token(token, user_id="user-b", device_id="d")


@pytest.mark.asyncio
async def test_the_watermark_stays_pinned_while_the_ledger_moves(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    world = await seed_world(factory, assets=20)

    async def move_ledger(page_number: int, _: dict[str, Any]) -> None:
        if page_number != 1:
            return
        async with factory() as session:
            asset = await session.get(Asset, world["mine_assets"][0])
            assert asset is not None
            before = asset.to_audit_dict()
            asset.tag = "moved"
            await record_update(
                session, asset, actor_id="admin", action="asset.update", before=before
            )
            await session.commit()

    async with api(factory, inspector()) as client:
        pages = await traverse(client, headers(), limit=10, after_page=move_ledger)
    assert len(pages) > 2
    assert len({page["cursor"] for page in pages}) == 1


@pytest.mark.asyncio
async def test_work_contexts_belong_to_scoped_inspectors_only(
    database: tuple[AsyncEngine, async_sessionmaker[AsyncSession]],
) -> None:
    _, factory = database
    await seed_world(factory, assets=5)
    # An administrator who happens to share the inspector's user id.
    admin = Principal(INSPECTOR, frozenset({Role.HMS_ADMIN}), frozenset())
    async with api(factory, admin) as client:
        pages = await traverse(client, headers("admin-device"), limit=50)
    assert context_keys(pages) == []
