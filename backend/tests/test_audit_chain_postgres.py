"""Audit-ledger serialization against a dedicated, migrated PostgreSQL database."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import delete, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.core import audit
from hms_backend.app.core.audit import append_audit_event, verify_audit_chain
from hms_backend.app.models.foundation import AuditEvent

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)

@pytest_asyncio.fixture
async def database() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert POSTGRES_URL is not None
    if not POSTGRES_URL.startswith("postgresql+asyncpg://"):
        raise ValueError(
            "Audit race tests require a dedicated async PostgreSQL database"
        )
    database_name = make_url(POSTGRES_URL).database
    if database_name is None or not database_name.endswith("_test"):
        raise ValueError("Audit race tests require a database name ending in _test")
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


async def _append(
    database: async_sessionmaker[AsyncSession],
    tag: str,
    index: int,
    barrier: asyncio.Barrier,
) -> None:
    async with database() as session:
        await barrier.wait()
        await append_audit_event(
            session,
            actor_id=f"race-{tag}",
            action=f"audit.race.{tag}",
            entity="AuditRace",
            entity_id=str(index),
            before=None,
            after={"index": index},
        )
        await session.commit()


async def _assert_linear_chain(
    database: async_sessionmaker[AsyncSession], tag: str, expected_count: int
) -> None:
    async with database() as session:
        events = (
            await session.scalars(
                select(AuditEvent)
                .where(AuditEvent.action == f"audit.race.{tag}")
                .order_by(AuditEvent.sequence)
            )
        ).all()
        assert len(events) == expected_count
        assert await verify_audit_chain(session)


async def _cleanup(database: async_sessionmaker[AsyncSession], tag: str) -> None:
    async with database() as session:
        await session.execute(
            delete(AuditEvent).where(AuditEvent.action == f"audit.race.{tag}")
        )
        await session.commit()


async def _empty_audit_chain(database: async_sessionmaker[AsyncSession]) -> None:
    async with database() as session:
        await session.execute(text("TRUNCATE TABLE audit_events RESTART IDENTITY"))
        await session.commit()
        assert await session.scalar(select(func.count()).select_from(AuditEvent)) == 0


@pytest.mark.asyncio
async def test_append_holds_the_postgresql_audit_chain_lock_until_commit(
    database: async_sessionmaker[AsyncSession],
) -> None:
    tag = uuid4().hex[:12]
    try:
        async with database() as writer:
            await append_audit_event(
                writer,
                actor_id="race-lock",
                action=f"audit.race.{tag}",
                entity="AuditRace",
                entity_id="lock",
                before=None,
                after=None,
            )
            async with database() as contender:
                acquired = await contender.scalar(
                    text("SELECT pg_try_advisory_xact_lock(:key)"),
                    {"key": audit._AUDIT_CHAIN_LOCK_KEY},
                )
            assert acquired is False
            await writer.commit()
    finally:
        await _cleanup(database, tag)


@pytest.mark.asyncio
@pytest.mark.parametrize("seed_chain", [False, True], ids=["genesis", "nonempty"])
async def test_concurrent_appends_preserve_a_linear_chain(
    database: async_sessionmaker[AsyncSession], seed_chain: bool
) -> None:
    tag = uuid4().hex[:12]
    writers = 4
    try:
        if seed_chain:
            async with database() as session:
                await append_audit_event(
                    session,
                    actor_id="race-seed",
                    action=f"audit.race.{tag}",
                    entity="AuditRace",
                    entity_id="seed",
                    before=None,
                    after={"seed": True},
                )
                await session.commit()
        else:
            await _empty_audit_chain(database)

        barrier = asyncio.Barrier(writers)
        await asyncio.gather(
            *(_append(database, tag, index, barrier) for index in range(writers))
        )
        await _assert_linear_chain(database, tag, writers + int(seed_chain))
    finally:
        await _cleanup(database, tag)


@pytest.mark.asyncio
async def test_neutralising_the_lock_reproduces_a_forked_chain(
    database: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    tag = uuid4().hex[:12]
    writers = 2
    original_latest = audit._latest_audit_event
    barrier = asyncio.Barrier(writers)

    async def unlocked(_session: AsyncSession) -> None:
        return None

    async def gated_latest(session: AsyncSession) -> AuditEvent | None:
        latest = await original_latest(session)
        await barrier.wait()
        return latest

    monkeypatch.setattr(audit, "_acquire_audit_chain_lock", unlocked)
    monkeypatch.setattr(audit, "_latest_audit_event", gated_latest)
    try:
        await asyncio.gather(
            *(
                _append(database, tag, index, asyncio.Barrier(1))
                for index in range(writers)
            )
        )
        async with database() as session:
            assert not await verify_audit_chain(session)
    finally:
        await _cleanup(database, tag)
