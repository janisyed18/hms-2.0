# ruff: noqa: F811
"""Dashboard and Analytics snapshot semantics.

The reporting period selects *activity*. Current work (overdue retests, the review
queue, fleet status, certificate coverage) is a snapshot and must not depend on it.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from test_core_records_api import (  # noqa: F401  (fixtures)
    api_client,
    org_today,
    seeded_session,
    session_factory,
    utc_today,
)

from hms_backend.app.core.config import Settings, settings
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.certificates.models import Certificate, CertificateStatus
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionStatus,
    InspectionType,
)
from hms_backend.app.modules.reporting.periods import (
    Bucket,
    PeriodError,
    build_buckets,
    choose_granularity,
    reference,
)
from hms_backend.app.modules.scheduling.models import (
    RetestSchedule,
    RetestScheduleStatus,
)

ADMIN = Principal(
    user_id="admin-1", roles=frozenset({Role.HMS_ADMIN}), customer_ids=frozenset()
)
LAST_WEEK_WINDOW = {
    "start_at": "2099-01-01T00:00:00Z",
    "end_at": "2099-01-08T00:00:00Z",
}


def recent_window() -> dict[str, str]:
    today = utc_today()
    return {
        "start_at": f"{(today - timedelta(days=7)).isoformat()}T00:00:00Z",
        "end_at": f"{(today + timedelta(days=1)).isoformat()}T00:00:00Z",
    }


async def add_scheduled_asset(
    session_factory: async_sessionmaker[AsyncSession],
    seeded: dict[str, str],
    *,
    number: str,
    due_in_days: int | None,
    lifecycle: AssetLifecycleStatus = AssetLifecycleStatus.IN_SERVICE,
    schedule_status: RetestScheduleStatus = RetestScheduleStatus.UPCOMING,
    escalated_at: datetime | None = None,
) -> str:
    """Create an Orica asset, optionally with a schedule due relative to today."""
    async with session_factory() as session:
        asset = Asset(
            customer_id=seeded["orica_id"],
            product_id=seeded["other_product_id"],
            asset_number=number,
            customer_serial_no=f"SN-{number}",
            tag=f"HMS-{number}",
            lifecycle_status=lifecycle.value,
        )
        session.add(asset)
        await session.flush()
        if due_in_days is not None:
            session.add(
                RetestSchedule(
                    customer_id=seeded["orica_id"],
                    asset_id=asset.id,
                    due_at=org_today() + timedelta(days=due_in_days),
                    status=schedule_status.value,
                    escalated_at=escalated_at,
                )
            )
        await session.commit()
        return asset.id


# --- P0-1: old overdue work must not depend on the reporting period -------------------


@pytest.mark.asyncio
async def test_old_overdue_retest_is_visible_for_any_reporting_period(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    # The seeded Vopak schedule fell due on 2023-11-02: far outside every window below.
    async with api_client(session_factory, ADMIN) as client:
        unfiltered = (await client.get("/api/v1/dashboard")).json()
        recent = (await client.get("/api/v1/dashboard", params=recent_window())).json()
        future = (await client.get("/api/v1/dashboard", params=LAST_WEEK_WINDOW)).json()

    for body in (unfiltered, recent, future):
        assert body["overdue_total"] == 1
        assert body["overdue_assets"] == 1
        assert [r["asset_number"] for r in body["overdue_retests"]] == ["997950"]


@pytest.mark.asyncio
async def test_old_overdue_retest_is_visible_in_analytics_for_any_period(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    async with api_client(session_factory, ADMIN) as client:
        unfiltered = (await client.get("/api/v1/analytics/overview")).json()
        windowed = (
            await client.get("/api/v1/analytics/overview", params=LAST_WEEK_WINDOW)
        ).json()

    assert windowed["overdue_assets"] == unfiltered["overdue_assets"] == 1
    assert windowed["fleet_posture"] == unfiltered["fleet_posture"]
    assert windowed["customer_risk"] == unfiltered["customer_risk"]


@pytest.mark.asyncio
async def test_current_snapshot_ignores_reporting_period_but_validation_remains(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    async with api_client(session_factory, ADMIN) as client:
        unfiltered = (await client.get("/api/v1/dashboard")).json()
        windowed = (
            await client.get("/api/v1/dashboard", params=LAST_WEEK_WINDOW)
        ).json()
        reversed_window = await client.get(
            "/api/v1/dashboard",
            params={
                "start_at": LAST_WEEK_WINDOW["end_at"],
                "end_at": LAST_WEEK_WINDOW["start_at"],
            },
        )

    for field in (
        "total_assets",
        "total_customers",
        "in_service_assets",
        "due_soon_assets",
    ):
        assert windowed[field] == unfiltered[field]
    assert windowed["total_assets"] == 2  # assets created before the window still count
    assert reversed_window.status_code == 422


# --- P0-2: the escalation contract ----------------------------------------------


@pytest.mark.asyncio
async def test_escalation_confirmation_count_matches_what_is_dispatched(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    # Eligible: the seeded Vopak asset (overdue 2023) and an overdue in-service asset.
    await add_scheduled_asset(
        session_factory, seeded_session, number="ESC-OK", due_in_days=-5
    )
    # Not eligible: suspended, condemned, retired, draft, due later, unscheduled.
    await add_scheduled_asset(
        session_factory,
        seeded_session,
        number="ESC-SUSP",
        due_in_days=-5,
        schedule_status=RetestScheduleStatus.SUSPENDED,
    )
    for number, lifecycle in (
        ("ESC-COND", AssetLifecycleStatus.CONDEMNED),
        ("ESC-RET", AssetLifecycleStatus.RETIRED),
        ("ESC-DRAFT", AssetLifecycleStatus.DRAFT),
    ):
        await add_scheduled_asset(
            session_factory,
            seeded_session,
            number=number,
            due_in_days=-5,
            lifecycle=lifecycle,
        )
    await add_scheduled_asset(
        session_factory, seeded_session, number="ESC-FUT", due_in_days=20
    )
    await add_scheduled_asset(
        session_factory, seeded_session, number="ESC-NONE", due_in_days=None
    )
    # Already escalated today: skipped by the backend, so not part of the count either.
    await add_scheduled_asset(
        session_factory,
        seeded_session,
        number="ESC-DONE",
        due_in_days=-5,
        escalated_at=datetime.now(UTC),
    )

    async with api_client(session_factory, ADMIN) as client:
        before = (await client.get("/api/v1/dashboard")).json()
        first = await client.post("/api/v1/retest-schedules/escalate-overdue")
        second = await client.post("/api/v1/retest-schedules/escalate-overdue")
        after = (await client.get("/api/v1/dashboard")).json()

    assert before["escalation_eligible_total"] == 2
    assert first.json()["dispatched"] == before["escalation_eligible_total"]
    assert second.json()["dispatched"] == 0
    assert after["escalation_eligible_total"] == 0
    assert after["escalated_today"] == 3  # ESC-OK, the seeded Vopak asset, ESC-DONE
    # Only fleet assets count as overdue; condemned/retired/draft never do.
    assert before["overdue_total"] == 3  # seeded Vopak, ESC-OK, ESC-DONE
    assert before["overdue_assets"] == before["overdue_total"]


@pytest.mark.asyncio
async def test_escalation_never_notifies_ineligible_lifecycle_assets(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    condemned = await add_scheduled_asset(
        session_factory,
        seeded_session,
        number="ESC-COND",
        due_in_days=-30,
        lifecycle=AssetLifecycleStatus.CONDEMNED,
    )
    async with api_client(session_factory, ADMIN) as client:
        await client.post("/api/v1/retest-schedules/escalate-overdue")

    async with session_factory() as session:
        schedule = await session.scalar(
            select(RetestSchedule).where(RetestSchedule.asset_id == condemned)
        )
    assert schedule is not None
    assert schedule.escalated_at is None


def test_retest_schedule_is_one_to_one_with_asset() -> None:
    """Why there are no duplicate-schedule fixtures: the schema forbids them."""
    column = RetestSchedule.__table__.c.asset_id
    assert column.unique is True


@pytest.mark.asyncio
async def test_escalated_today_follows_the_organisation_calendar_day(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    ref = reference()
    just_before = ref.day_start - timedelta(seconds=1)
    for number, escalated_at in (
        ("ESC-PREV", just_before),  # yesterday locally: eligible again
        ("ESC-START", ref.day_start),  # first instant of today: already escalated
    ):
        await add_scheduled_asset(
            session_factory,
            seeded_session,
            number=number,
            due_in_days=-3,
            escalated_at=escalated_at,
        )
    async with api_client(session_factory, ADMIN) as client:
        body = (await client.get("/api/v1/dashboard")).json()
    # seeded Vopak (never escalated) + ESC-PREV are eligible; ESC-START is not.
    assert body["escalation_eligible_total"] == 2
    assert body["escalated_today"] == 1


# --- fleet status: one mutually exclusive partition ----


async def _seed_status_fleet(
    session_factory: async_sessionmaker[AsyncSession], seeded: dict[str, str]
) -> None:
    for number, due in (
        ("FLEET-LATE30", 30),
        ("FLEET-LATE8", 8),  # first day beyond the due-soon window
        ("FLEET-SOON7", 7),  # last day inside it
        ("FLEET-TODAY", 0),  # due today is not yet overdue
        ("FLEET-LATE", -1),  # yesterday is overdue
    ):
        await add_scheduled_asset(
            session_factory, seeded, number=number, due_in_days=due
        )
    await add_scheduled_asset(
        session_factory,
        seeded,
        number="FLEET-SUSP",
        due_in_days=-5,
        schedule_status=RetestScheduleStatus.SUSPENDED,
    )
    # Never part of the fleet, whatever their schedule says.
    for number, lifecycle in (
        ("FLEET-COND", AssetLifecycleStatus.CONDEMNED),
        ("FLEET-RET", AssetLifecycleStatus.RETIRED),
        ("FLEET-DRAFT", AssetLifecycleStatus.DRAFT),
    ):
        await add_scheduled_asset(
            session_factory,
            seeded,
            number=number,
            due_in_days=-9,
            lifecycle=lifecycle,
        )


@pytest.mark.asyncio
async def test_fleet_status_partitions_the_eligible_fleet_exactly_once(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    await _seed_status_fleet(session_factory, seeded_session)
    async with api_client(session_factory, ADMIN) as client:
        dashboard = (await client.get("/api/v1/dashboard")).json()
        analytics = (await client.get("/api/v1/analytics/overview")).json()

    # Seeded: Vopak overdue (lifecycle OVERDUE, schedule 2023) and Orica unscheduled.
    expected = {
        "on_track": 2,
        "due_soon": 2,
        "overdue": 2,
        "suspended": 1,
        "unscheduled": 1,
        "total": 8,
        "on_track_percent": 25,
    }
    assert dashboard["fleet_status"] == expected
    assert analytics["fleet_status"] == expected
    parts = {
        k: v for k, v in expected.items() if k not in {"total", "on_track_percent"}
    }
    assert sum(parts.values()) == expected["total"]
    # The three excluded lifecycles are in total_assets but not in the fleet.
    assert dashboard["total_assets"] == 11
    assert dashboard["overdue_assets"] == analytics["overdue_assets"] == 2
    assert dashboard["due_soon_assets"] == analytics["due_soon_assets"] == 2
    assert analytics["fleet_posture"] == {"clear": 2, "due_soon": 2, "overdue": 2}


@pytest.mark.asyncio
async def test_asset_without_a_schedule_is_unscheduled_never_on_track(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    async with api_client(session_factory, ADMIN) as client:
        body = (await client.get("/api/v1/dashboard")).json()
    assert body["fleet_status"]["unscheduled"] == 1  # the seeded Orica asset
    assert body["fleet_status"]["on_track"] == 0
    assert body["fleet_status"]["on_track_percent"] == 0


@pytest.mark.asyncio
async def test_empty_fleet_has_no_on_track_percent(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with api_client(session_factory, ADMIN) as client:
        body = (await client.get("/api/v1/dashboard")).json()
    assert body["fleet_status"]["total"] == 0
    assert body["fleet_status"]["on_track_percent"] is None


@pytest.mark.asyncio
async def test_customer_scope_limits_every_snapshot_metric(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    await _seed_status_fleet(session_factory, seeded_session)
    vopak_user = Principal(
        user_id="customer-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({seeded_session["vopak_id"]}),
    )
    nobody = Principal(
        user_id="customer-2",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset(),
    )
    async with api_client(session_factory, vopak_user) as client:
        body = (await client.get("/api/v1/dashboard")).json()
        activity = (
            await client.get("/api/v1/reporting/activity", params=recent_window())
        ).json()
    async with api_client(session_factory, nobody) as client:
        empty = (await client.get("/api/v1/dashboard")).json()

    assert body["fleet_status"]["total"] == 1
    assert body["fleet_status"]["overdue"] == 1
    assert body["escalation_eligible_total"] == 1
    assert activity["totals"]["assets_added"] == 1  # only Vopak's own asset
    assert empty["fleet_status"]["total"] == 0
    assert empty["overdue_total"] == 0


# --- certificate coverage ----


async def _add_certificate(
    session_factory: async_sessionmaker[AsyncSession],
    asset_id: str,
    tag: str,
    *,
    valid_in_days: int | None,
    status: CertificateStatus = CertificateStatus.ISSUED,
    issued_at: datetime | None = None,
) -> None:
    async with session_factory() as session:
        inspection = Inspection(
            asset_id=asset_id,
            inspection_type=InspectionType.SERVICE.value,
            status=InspectionStatus.APPROVED.value,
            result="PASS",
            inspector_user_id="inspector-1",
        )
        session.add(inspection)
        await session.flush()
        certificate = Certificate(
            inspection_id=inspection.id,
            asset_id=asset_id,
            number=f"CERT-{tag}",
            valid_until=(
                None
                if valid_in_days is None
                else org_today() + timedelta(days=valid_in_days)
            ),
            pdf_object_key=f"certificates/{tag}.pdf",
            verification_hash=f"hash-{tag}",
            public_token=f"token-{tag}",
            issued_by_user_id="admin-1",
            status=status.value,
        )
        if issued_at is not None:
            certificate.issued_at = issued_at
        session.add(certificate)
        await session.commit()


@pytest.mark.asyncio
async def test_certificate_coverage_counts_assets_by_current_validity(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    last_year = datetime.now(UTC) - timedelta(days=400)
    ids: dict[str, str] = {}
    for tag in "ABCDEFGHI":
        ids[tag] = await add_scheduled_asset(
            session_factory, seeded_session, number=f"CERT-{tag}", due_in_days=60
        )
    await _add_certificate(  # A: issued last year, still valid for 200 days
        session_factory, ids["A"], "A1", valid_in_days=200, issued_at=last_year
    )
    await _add_certificate(session_factory, ids["B"], "B1", valid_in_days=100)
    await _add_certificate(session_factory, ids["B"], "B2", valid_in_days=20)
    await _add_certificate(session_factory, ids["C"], "C1", valid_in_days=0)
    await _add_certificate(session_factory, ids["D"], "D1", valid_in_days=-1)
    await _add_certificate(session_factory, ids["E"], "E1", valid_in_days=None)
    await _add_certificate(
        session_factory,
        ids["F"],
        "F1",
        valid_in_days=90,
        status=CertificateStatus.REVOKED,
    )
    await _add_certificate(
        session_factory,
        ids["G"],
        "G1",
        valid_in_days=90,
        status=CertificateStatus.SUPERSEDED,
    )
    await _add_certificate(session_factory, ids["H"], "H1", valid_in_days=-30)
    await _add_certificate(session_factory, ids["H"], "H2", valid_in_days=None)
    # I has no certificate.

    async with api_client(session_factory, ADMIN) as client:
        snapshot = (await client.get("/api/v1/analytics/overview")).json()
        in_far_window = (
            await client.get("/api/v1/analytics/overview", params=LAST_WEEK_WINDOW)
        ).json()
        in_recent_window = (
            await client.get("/api/v1/analytics/overview", params=recent_window())
        ).json()

    coverage = snapshot["certificate_coverage"]
    # 11 eligible assets: A-I plus the two seeded ones, which hold no certificate.
    assert coverage["eligible_assets"] == 11
    assert (
        coverage["covered_assets"] == 3
    )  # A (old but valid), B once, C (expires today)
    assert coverage["unverified_assets"] == 2  # E undated; H has only undated + expired
    assert coverage["expired_assets"] == 1  # D
    assert coverage["missing_assets"] == 5  # I, F revoked, G superseded, two seeded
    assert (
        coverage["covered_assets"]
        + coverage["unverified_assets"]
        + coverage["expired_assets"]
        + coverage["missing_assets"]
        == coverage["eligible_assets"]
    )
    assert coverage["coverage_percent"] == 27
    assert coverage["expiring_assets"] == 1  # C only: B's other certificate is far off
    # Certificate-level counts stay separate from the asset-level numbers.
    assert coverage["issued"] == 8
    assert coverage["expiring_soon"] == 2  # C (today) and B2 (+20)
    assert coverage["expired"] == 2  # D and H's -30
    assert coverage["issued_in_period"] is None
    # The period never changes coverage; it only changes how many were issued in it.
    for windowed in (in_far_window, in_recent_window):
        assert {
            k: v
            for k, v in windowed["certificate_coverage"].items()
            if k != "issued_in_period"
        } == {k: v for k, v in coverage.items() if k != "issued_in_period"}
    assert in_far_window["certificate_coverage"]["issued_in_period"] == 0
    # Everything except A (issued last year) and the DRAFT-free set was issued just now.
    assert in_recent_window["certificate_coverage"]["issued_in_period"] == 9


@pytest.mark.asyncio
async def test_undated_certificate_is_never_reported_valid_or_expired(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    asset_id = await add_scheduled_asset(
        session_factory, seeded_session, number="UNDATED", due_in_days=60
    )
    await _add_certificate(session_factory, asset_id, "U1", valid_in_days=None)
    async with api_client(session_factory, ADMIN) as client:
        coverage = (await client.get("/api/v1/analytics/overview")).json()[
            "certificate_coverage"
        ]
    assert coverage["unverified_assets"] == 1
    assert coverage["covered_assets"] == 0
    assert coverage["expired"] == 0 and coverage["expiring_soon"] == 0
    assert coverage["issued"] == 1  # the certificate itself is untouched


# --- reference date and bucket boundaries ----


def test_reference_uses_the_organisation_calendar_date() -> None:
    now = datetime(2026, 11, 13, 14, 30, tzinfo=UTC)  # 01:30 on 14 Nov in Sydney
    ref = reference(now)
    assert ref.today.isoformat() == "2026-11-14"
    assert ref.due_soon_end.isoformat() == "2026-11-21"
    assert ref.day_start == datetime(2026, 11, 13, 13, 0, tzinfo=UTC)
    assert ref.day_end == datetime(2026, 11, 14, 13, 0, tzinfo=UTC)


def test_reference_follows_a_configured_timezone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "reporting_timezone", "UTC")
    ref = reference(datetime(2026, 11, 13, 14, 30, tzinfo=UTC))
    assert ref.today.isoformat() == "2026-11-13"
    assert ref.timezone == "UTC"


def test_unknown_reporting_timezone_is_rejected() -> None:
    with pytest.raises(ValueError):
        Settings(reporting_timezone="Mars/Olympus")


def _hours(bucket: Bucket) -> float:
    return (bucket.end - bucket.start).total_seconds() / 3600


def test_day_buckets_are_25_hours_when_daylight_saving_ends() -> None:
    buckets = build_buckets(
        datetime(2026, 4, 4, 13, 0, tzinfo=UTC),  # 5 April 00:00 AEDT
        datetime(2026, 4, 6, 14, 0, tzinfo=UTC),  # 7 April 00:00 AEST
        "day",
    )
    assert [_hours(b) for b in buckets] == [25, 24]
    assert buckets[0].end == buckets[1].start


def test_day_buckets_are_23_hours_when_daylight_saving_starts() -> None:
    buckets = build_buckets(
        datetime(2026, 10, 3, 14, 0, tzinfo=UTC),  # 4 October 00:00 AEST
        datetime(2026, 10, 5, 13, 0, tzinfo=UTC),  # 6 October 00:00 AEDT
        "day",
    )
    assert [_hours(b) for b in buckets] == [23, 24]


def test_buckets_cover_the_interval_exactly_and_clip_partial_days() -> None:
    start = datetime(2026, 3, 1, 5, 17, tzinfo=UTC)
    end = datetime(2026, 3, 4, 2, 41, tzinfo=UTC)
    buckets = build_buckets(start, end, "day")
    assert buckets[0].start == start and buckets[-1].end == end
    assert all(a.end == b.start for a, b in zip(buckets, buckets[1:], strict=False))


def test_year_end_single_local_day() -> None:
    buckets = build_buckets(
        datetime(2025, 12, 31, 13, 0, tzinfo=UTC),  # 1 Jan 00:00 AEDT
        datetime(2026, 1, 1, 13, 0, tzinfo=UTC),
        "day",
    )
    assert len(buckets) == 1 and _hours(buckets[0]) == 24


def test_week_buckets_start_on_local_monday() -> None:
    buckets = build_buckets(
        datetime(2026, 11, 10, 0, 0, tzinfo=UTC),  # a Tuesday
        datetime(2026, 11, 25, 0, 0, tzinfo=UTC),
        "week",
    )
    zone = ZoneInfo("Australia/Sydney")
    for bucket in buckets[1:]:
        local = bucket.start.astimezone(zone)
        assert local.weekday() == 0 and local.hour == 0


def test_hour_buckets_respect_half_hour_offsets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "reporting_timezone", "Australia/Adelaide")
    buckets = build_buckets(
        datetime(2026, 6, 1, 0, 0, tzinfo=UTC),
        datetime(2026, 6, 1, 3, 0, tzinfo=UTC),
        "hour",
    )
    assert buckets[0].start == datetime(2026, 6, 1, 0, 0, tzinfo=UTC)
    assert sum(_hours(b) for b in buckets) == 3


def test_granularity_is_chosen_from_the_span() -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    assert choose_granularity(start, start + timedelta(hours=24)) == "hour"
    assert choose_granularity(start, start + timedelta(days=30)) == "day"
    assert choose_granularity(start, start + timedelta(days=400)) == "week"


def test_an_unbounded_period_is_refused() -> None:
    start = datetime(2020, 1, 1, tzinfo=UTC)
    with pytest.raises(PeriodError):
        build_buckets(start, start + timedelta(days=3000), "week")
    with pytest.raises(PeriodError):
        build_buckets(start, start + timedelta(days=200), "day")
    with pytest.raises(PeriodError):
        build_buckets(start, start, "day")


# --- activity API ----


async def _add_assets_created_at(
    session_factory: async_sessionmaker[AsyncSession],
    seeded: dict[str, str],
    stamps: list[datetime],
    *,
    prefix: str = "ACT",
) -> None:
    async with session_factory() as session:
        session.add_all(
            Asset(
                customer_id=seeded["orica_id"],
                product_id=seeded["other_product_id"],
                asset_number=f"{prefix}-{index}",
                customer_serial_no=f"SN-{prefix}-{index}",
                tag=f"HMS-{prefix}-{index}",
                lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
                created_at=stamp,
            )
            for index, stamp in enumerate(stamps)
        )
        await session.commit()


@pytest.mark.asyncio
async def test_activity_uses_half_open_intervals_at_the_boundaries(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    start = datetime(2026, 3, 1, 0, 0, tzinfo=UTC)
    end = datetime(2026, 3, 4, 0, 0, tzinfo=UTC)
    micro = timedelta(microseconds=1)
    await _add_assets_created_at(
        session_factory,
        seeded_session,
        [start - micro, start, end - micro, end, end + micro],
    )
    async with api_client(session_factory, ADMIN) as client:
        body = (
            await client.get(
                "/api/v1/reporting/activity",
                params={"start_at": start.isoformat(), "end_at": end.isoformat()},
            )
        ).json()

    assert body["totals"]["assets_added"] == 2  # start included, end excluded
    assert sum(b["assets_added"] for b in body["buckets"]) == 2
    assert body["timezone"] == "Australia/Sydney"
    assert body["buckets"][0]["start"].startswith("2026-03-01T00:00:00")
    assert body["buckets"][-1]["end"].startswith("2026-03-04T00:00:00")


@pytest.mark.asyncio
async def test_activity_buckets_reconcile_with_records_at_volume(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    start = datetime(2026, 5, 1, 0, 0, tzinfo=UTC)
    end = datetime(2026, 5, 31, 0, 0, tzinfo=UTC)
    stamps = [start + timedelta(minutes=29 * n + 7) for n in range(1_500)]
    inside = [stamp for stamp in stamps if start <= stamp < end]
    await _add_assets_created_at(session_factory, seeded_session, stamps)
    async with api_client(session_factory, ADMIN) as client:
        body = (
            await client.get(
                "/api/v1/reporting/activity",
                params={"start_at": start.isoformat(), "end_at": end.isoformat()},
            )
        ).json()

    assert body["granularity"] == "day"
    assert len(inside) > 900  # a genuinely large slice, far beyond a 100-row limit
    assert body["totals"]["assets_added"] == len(inside)
    assert sum(b["assets_added"] for b in body["buckets"]) == len(inside)
    zone = ZoneInfo("Australia/Sydney")
    for bucket in body["buckets"]:
        b_start = datetime.fromisoformat(bucket["start"])
        b_end = datetime.fromisoformat(bucket["end"])
        assert bucket["assets_added"] == sum(1 for s in inside if b_start <= s < b_end)
        assert b_start.astimezone(zone).hour == 0 or b_start == start


@pytest.mark.asyncio
async def test_activity_for_an_empty_period_returns_zero_buckets(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    async with api_client(session_factory, ADMIN) as client:
        body = (
            await client.get("/api/v1/reporting/activity", params=LAST_WEEK_WINDOW)
        ).json()
    assert len(body["buckets"]) >= 7
    assert all(value == 0 for key, value in body["totals"].items())


@pytest.mark.asyncio
async def test_activity_counts_each_escalation_event_not_just_the_latest(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    async with api_client(session_factory, ADMIN) as client:
        first = await client.post("/api/v1/retest-schedules/escalate-overdue")
        # Pretend the last escalation was yesterday so it can be escalated again.
        async with session_factory() as session:
            schedule = (await session.scalars(select(RetestSchedule))).first()
            assert schedule is not None
            schedule.escalated_at = reference().day_start - timedelta(hours=1)
            await session.commit()
        async with session_factory() as session:
            # Re-key yesterday's outbox dedupe so a second event can be queued.
            from hms_backend.app.modules.notifications.models import OutboxEvent

            for event in (await session.scalars(select(OutboxEvent))).all():
                event.dedupe_key = f"{event.dedupe_key}:previous-day"
            await session.commit()
        second = await client.post("/api/v1/retest-schedules/escalate-overdue")
        window = {
            "start_at": (datetime.now(UTC) - timedelta(days=1)).isoformat(),
            "end_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
        }
        activity = (
            await client.get("/api/v1/reporting/activity", params=window)
        ).json()

    assert first.json()["dispatched"] == 1 and second.json()["dispatched"] == 1
    assert activity["totals"]["retests_escalated"] == 2
    assert "audit" not in str(activity).lower()  # aggregates only


@pytest.mark.asyncio
async def test_activity_validates_the_period(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    async with api_client(session_factory, ADMIN) as client:
        reversed_period = await client.get(
            "/api/v1/reporting/activity",
            params={
                "start_at": "2026-03-04T00:00:00Z",
                "end_at": "2026-03-01T00:00:00Z",
            },
        )
        too_long = await client.get(
            "/api/v1/reporting/activity",
            params={
                "start_at": "2015-01-01T00:00:00Z",
                "end_at": "2026-01-01T00:00:00Z",
            },
        )
        missing = await client.get("/api/v1/reporting/activity")
    assert reversed_period.status_code == 422
    assert too_long.status_code == 422
    assert missing.status_code == 422


@pytest.mark.asyncio
async def test_inspectors_cannot_read_reporting_endpoints(
    session_factory: async_sessionmaker[AsyncSession],
    seeded_session: dict[str, str],
) -> None:
    inspector = Principal(
        user_id="inspector-1",
        roles=frozenset({Role.INSPECTOR}),
        customer_ids=frozenset(),
    )
    async with api_client(session_factory, inspector) as client:
        responses = [
            await client.get("/api/v1/dashboard"),
            await client.get("/api/v1/analytics/overview"),
            await client.get("/api/v1/reporting/activity", params=recent_window()),
        ]
    assert [r.status_code for r in responses] == [403, 403, 403]
