"""The daily retest scheduler under real PostgreSQL concurrency.

The scheduler is a daily job that fires on an *exact* day (due today, N days before due,
N days overdue), so a missed or failed run is never made up the next day. Two runs that
overlap (a redelivered acks-late task, or a second beat) must therefore neither fail nor
send a reminder twice, and one bad schedule must not take the whole day down with it.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from datetime import date, timedelta
from random import randint
from uuid import uuid4

import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import delete, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import hms_backend.app.main  # noqa: F401  (registers every ORM model)
import hms_backend.app.modules.notifications.service as service_module
from hms_backend.app.core.config import Settings
from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.notifications.enums import NotificationCategory
from hms_backend.app.modules.notifications.models import OutboxEvent
from hms_backend.app.modules.notifications.outbox import emit_event_if_absent
from hms_backend.app.modules.notifications.service import run_retest_scheduler
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.scheduling.models import (
    RetestSchedule,
    RetestScheduleStatus,
)

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


def unique_today() -> date:
    """A date no other test's schedules are due around, in the shared database."""
    return date(2500, 1, 1) + timedelta(days=randint(0, 200_000))


async def seed_due_today(
    database: async_sessionmaker[AsyncSession], today: date, count: int
) -> list[str]:
    tag = uuid4().hex[:10]
    asset_ids: list[str] = []
    async with database() as session:
        for n in range(count):
            customer = Customer(code=f"S{tag}{n}", name=f"Scheduler {tag} {n}")
            product = Product(category="Hydraulic", code=f"P{tag}{n}", name="Hose")
            asset = Asset(
                customer=customer,
                product=product,
                asset_number=f"SCH-{tag}-{n}",
                lifecycle_status=AssetLifecycleStatus.IN_SERVICE.value,
            )
            session.add(asset)
            await session.flush()
            session.add(
                RetestSchedule(
                    customer_id=customer.id,
                    asset_id=asset.id,
                    due_at=today,
                    status=RetestScheduleStatus.DUE.value,
                    reminder_interval_days=30,
                    escalation_interval_days=7,
                )
            )
            asset_ids.append(asset.id)
        await session.commit()
    return asset_ids


async def events_for(
    database: async_sessionmaker[AsyncSession], today: date
) -> list[OutboxEvent]:
    async with database() as session:
        return list(
            (
                await session.scalars(
                    select(OutboxEvent).where(
                        OutboxEvent.dedupe_key.like("RETEST_DUE:%"),
                        OutboxEvent.dedupe_key.like(f"%:{today.isoformat()}"),
                    )
                )
            ).all()
        )


async def cleanup(database: async_sessionmaker[AsyncSession], today: date) -> None:
    async with database() as session:
        await session.execute(
            delete(OutboxEvent).where(
                OutboxEvent.dedupe_key.like(f"RETEST_%:{today.isoformat()}%")
            )
        )
        await session.commit()


async def _wait_until_done_or_blocked(
    database: async_sessionmaker[AsyncSession], task: asyncio.Task[object]
) -> None:
    """Wait for ``task`` to finish, or to block on another transaction's outbox row."""
    for _ in range(200):
        if task.done():
            return
        async with database() as session:
            blocked = await session.scalar(
                text(
                    "SELECT count(*) FROM pg_stat_activity WHERE "
                    "wait_event_type = 'Lock' AND query ILIKE '%notification_outbox%'"
                )
            )
        if blocked:
            return
        await asyncio.sleep(0.05)
    raise AssertionError("the second run neither finished nor blocked")


@pytest.mark.asyncio
async def test_two_overlapping_scheduler_runs_both_succeed_and_emit_each_event_once(
    database: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Run A is paused after creating its first event; run B then runs; A resumes.

    Without protection B emits everything and commits, and A's pending first event
    then collides with B's on the unique dedupe key when A commits.
    """
    today = unique_today()
    asset_ids = await seed_due_today(database, today, count=3)
    real_emit = service_module._emit  # noqa: SLF001
    reached = asyncio.Event()
    release = asyncio.Event()
    state = {"first": True}

    async def pause_after_first_event(*args: object, **kwargs: object) -> int:
        result = await real_emit(*args, **kwargs)  # type: ignore[arg-type]
        if state["first"]:
            state["first"] = False
            reached.set()
            await release.wait()
        return result

    monkeypatch.setattr(service_module, "_emit", pause_after_first_event)
    try:
        run_a = asyncio.create_task(
            run_retest_scheduler(database, settings=Settings(), today=today)
        )
        await reached.wait()
        run_b = asyncio.create_task(
            run_retest_scheduler(database, settings=Settings(), today=today)
        )
        await _wait_until_done_or_blocked(database, run_b)
        release.set()
        results = await asyncio.wait_for(
            asyncio.gather(run_a, run_b, return_exceptions=True), timeout=60
        )

        failures = [r for r in results if isinstance(r, BaseException)]
        assert failures == [], f"an overlapping run failed: {failures!r}"
        summaries = [r for r in results if isinstance(r, dict)]
        # Neither run lost a schedule to the collision. Per-schedule isolation would
        # otherwise swallow it and report it only as a failed schedule.
        assert [r["failed"] for r in summaries] == [0, 0]
        # Each due reminder is emitted exactly once between the two runs.
        assert sum(r["emitted"] for r in summaries) == len(asset_ids)
        mine = await events_for(database, today)
        assert sorted(e.aggregate_id for e in mine) == sorted(asset_ids)
    finally:
        await cleanup(database, today)


@pytest.mark.asyncio
async def test_a_second_run_steps_aside_while_the_first_holds_the_lock(
    database: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    today = unique_today()
    asset_ids = await seed_due_today(database, today, count=2)
    real_emit = service_module._emit  # noqa: SLF001
    reached = asyncio.Event()
    release = asyncio.Event()
    state = {"first": True}

    async def hold_first_run(*args: object, **kwargs: object) -> int:
        result = await real_emit(*args, **kwargs)  # type: ignore[arg-type]
        if state["first"]:
            state["first"] = False
            reached.set()
            await release.wait()
        return result

    monkeypatch.setattr(service_module, "_emit", hold_first_run)
    try:
        first = asyncio.create_task(
            run_retest_scheduler(database, settings=Settings(), today=today)
        )
        await reached.wait()

        # The first run is mid-way; a concurrent one does no work and says so.
        second = await asyncio.wait_for(
            run_retest_scheduler(database, settings=Settings(), today=today),
            timeout=20,
        )
        assert second == {"emitted": 0, "failed": 0, "skipped_concurrent": 1}

        release.set()
        assert (await first)["emitted"] == len(asset_ids)

        # Once it has finished the lock is free again: a later run is a harmless no-op.
        third = await run_retest_scheduler(database, settings=Settings(), today=today)
        assert third == {"emitted": 0, "failed": 0}
    finally:
        release.set()
        await cleanup(database, today)


@pytest.mark.asyncio
async def test_one_schedule_that_cannot_be_processed_does_not_lose_the_others(
    database: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    today = unique_today()
    asset_ids = await seed_due_today(database, today, count=3)
    real = service_module._emit_for_schedule  # noqa: SLF001
    bad = sorted(asset_ids)[1]

    async def fails_for_one(
        session: AsyncSession, schedule: RetestSchedule, *args: object
    ) -> int:
        if schedule.asset_id == bad:
            raise RuntimeError("this schedule is broken")
        return await real(session, schedule, *args)  # type: ignore[arg-type]

    monkeypatch.setattr(service_module, "_emit_for_schedule", fails_for_one)
    try:
        result = await run_retest_scheduler(database, settings=Settings(), today=today)

        assert result == {"emitted": 2, "failed": 1}
        emitted_for = {e.aggregate_id for e in await events_for(database, today)}
        assert emitted_for == set(asset_ids) - {bad}
    finally:
        await cleanup(database, today)


@pytest.mark.asyncio
async def test_schedules_are_processed_in_a_fixed_order(
    database: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A fixed order means two runs never take unique-key locks in opposite orders."""
    today = unique_today()
    await seed_due_today(database, today, count=4)
    real = service_module._emit_for_schedule  # noqa: SLF001
    seen: list[str] = []

    async def record(
        session: AsyncSession, schedule: RetestSchedule, *args: object
    ) -> int:
        seen.append(schedule.id)
        return await real(session, schedule, *args)  # type: ignore[arg-type]

    monkeypatch.setattr(service_module, "_emit_for_schedule", record)
    try:
        await run_retest_scheduler(database, settings=Settings(), today=today)
        mine = [s for s in seen]
        assert mine == sorted(mine)
    finally:
        await cleanup(database, today)


@pytest.mark.asyncio
async def test_a_concurrent_duplicate_event_loses_cleanly(
    database: async_sessionmaker[AsyncSession],
) -> None:
    """The helper itself tolerates another transaction creating the same event."""
    key = f"RETEST_DUE:helper-{uuid4().hex}:2999-01-01"
    try:
        async with database() as first, database() as second:
            created = await emit_event_if_absent(
                first,
                category=NotificationCategory.RETEST_DUE,
                aggregate_type="asset",
                aggregate_id=str(uuid4()),
                payload={},
                dedupe_key=key,
            )
            assert created is not None  # inserted, not yet committed

            racing = asyncio.create_task(
                emit_event_if_absent(
                    second,
                    category=NotificationCategory.RETEST_DUE,
                    aggregate_type="asset",
                    aggregate_id=str(uuid4()),
                    payload={},
                    dedupe_key=key,
                )
            )
            await _wait_until_done_or_blocked(database, racing)
            assert not racing.done()  # waiting on the unique key
            await first.commit()

            assert await asyncio.wait_for(racing, timeout=10) is None
            await second.commit()
        async with database() as session:
            count = await session.scalar(
                select(func.count())
                .select_from(OutboxEvent)
                .where(OutboxEvent.dedupe_key == key)
            )
        assert count == 1
    finally:
        async with database() as session:
            await session.execute(
                delete(OutboxEvent).where(OutboxEvent.dedupe_key == key)
            )
            await session.commit()
