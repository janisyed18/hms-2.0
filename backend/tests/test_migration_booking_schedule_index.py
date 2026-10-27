"""Migration 20261023_0023: the booking schedule index must not block writers."""

from __future__ import annotations

import asyncio
import importlib.util
import os
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType
from typing import Any
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

BACKEND = Path(__file__).resolve().parents[1]
MIGRATION = BACKEND / "alembic" / "versions" / "20261023_0023_booking_schedule_index.py"
INDEX = "ix_inspection_bookings_scheduled_at"
POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")


def load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("booking_schedule_index", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Recorder:
    """A stand-in for ``alembic.op`` noting what ran, and whether in autocommit."""

    def __init__(self, dialect: str, existing: bool | None = None) -> None:
        self.dialect = dialect
        self.existing = existing
        self.calls: list[tuple[str, dict[str, Any], bool]] = []
        self.in_autocommit = False

    def get_bind(self) -> Any:
        recorder = self

        class Bind:
            dialect = type("Dialect", (), {"name": recorder.dialect})()

            def execute(self, *_: Any, **__: Any) -> Any:
                return type("Result", (), {"scalar": lambda _self: recorder.existing})()

        return Bind()

    def get_context(self) -> Any:
        recorder = self

        class Context:
            @contextmanager
            def autocommit_block(self) -> Iterator[None]:
                recorder.in_autocommit = True
                try:
                    yield
                finally:
                    recorder.in_autocommit = False

        return Context()

    def create_index(self, *args: Any, **kwargs: Any) -> None:
        self.calls.append(("create_index", kwargs, self.in_autocommit))

    def drop_index(self, *args: Any, **kwargs: Any) -> None:
        self.calls.append(("drop_index", kwargs, self.in_autocommit))


def run(direction: str, recorder: Recorder) -> list[tuple[str, dict[str, Any], bool]]:
    module = load()
    module.__dict__["op"] = recorder
    getattr(module, direction)()
    return recorder.calls


def test_postgresql_builds_the_index_concurrently_outside_a_transaction() -> None:
    calls = run("upgrade", Recorder("postgresql", existing=None))
    assert [name for name, _, _ in calls] == ["create_index"]
    _, kwargs, in_autocommit = calls[0]
    assert kwargs.get("postgresql_concurrently") is True
    assert in_autocommit, "CREATE INDEX CONCURRENTLY cannot run inside a transaction"


def test_postgresql_drops_the_index_concurrently_outside_a_transaction() -> None:
    calls = run("downgrade", Recorder("postgresql"))
    assert [name for name, _, _ in calls] == ["drop_index"]
    _, kwargs, in_autocommit = calls[0]
    assert kwargs.get("postgresql_concurrently") is True
    assert in_autocommit


def test_an_interrupted_concurrent_build_is_replaced_not_trusted() -> None:
    calls = run(
        "upgrade", Recorder("postgresql", existing=False)
    )  # present but INVALID
    assert [name for name, _, _ in calls] == ["drop_index", "create_index"]
    assert all(
        kwargs.get("postgresql_concurrently") is True and auto
        for _, kwargs, auto in calls
    )


def test_a_valid_existing_index_is_left_alone() -> None:
    assert run("upgrade", Recorder("postgresql", existing=True)) == []


def test_other_dialects_use_the_plain_statements() -> None:
    up = run("upgrade", Recorder("sqlite"))
    down = run("downgrade", Recorder("sqlite"))
    assert [name for name, _, _ in up] == ["create_index"]
    assert [name for name, _, _ in down] == ["drop_index"]
    assert not any("postgresql_concurrently" in kwargs for _, kwargs, _ in up + down)


# --- real PostgreSQL: writers are not blocked while the index is built ----------------

pytestmark_pg = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)


@pytest_asyncio.fixture
async def scratch_database() -> Any:
    """A throwaway database migrated to the revision before this one."""
    assert POSTGRES_URL is not None
    base = make_url(POSTGRES_URL)
    name = f"hms_idx_{uuid4().hex[:10]}_test"
    admin = create_async_engine(base, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'CREATE DATABASE "{name}"'))
    url = base.set(database=name)
    environment = {
        **os.environ,
        "DATABASE_URL": url.render_as_string(hide_password=False),
    }

    def alembic(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-m", "alembic", *args],
            cwd=BACKEND,
            env=environment,
            capture_output=True,
            text=True,
            timeout=300,
        )

    first = alembic("upgrade", "20261022_0022")
    assert first.returncode == 0, first.stderr
    try:
        yield url, environment, admin
    finally:
        async with admin.connect() as connection:
            await connection.execute(
                text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = :name AND pid <> pg_backend_pid()"
                ),
                {"name": name},
            )
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
        await admin.dispose()


async def _index_state(engine: Any) -> tuple[bool, bool | None]:
    async with engine.connect() as connection:
        row = (
            await connection.execute(
                text(
                    "SELECT i.indisvalid FROM pg_index i "
                    "JOIN pg_class c ON c.oid = i.indexrelid "
                    "WHERE c.relname = :name"
                ),
                {"name": INDEX},
            )
        ).first()
    return (row is not None, None if row is None else bool(row[0]))


@pytestmark_pg
@pytest.mark.asyncio
async def test_writers_are_not_blocked_while_the_index_is_built(
    scratch_database: Any,
) -> None:
    url, environment, admin = scratch_database
    engine = create_async_engine(url)
    insert = text(
        "INSERT INTO inspection_bookings (id, version, created_at, updated_at, "
        "customer_id, location_id, scheduled_at, status, requested_by_user_id) VALUES "
        "(:id, 1, now(), now(), :customer, :location, now(), 'PENDING_APPROVAL', 'u')"
    )
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO customers (id, version, created_at, updated_at, code, "
                "name, retest_enabled) "
                "VALUES ('c1', 1, now(), now(), 'C1', 'Customer', false)"
            )
        )
        await connection.execute(
            text(
                "INSERT INTO customer_locations (id, version, created_at, updated_at, "
                "customer_id, name) VALUES ('l1', 1, now(), now(), 'c1', 'Site')"
            )
        )
    params = {"customer": "c1", "location": "l1"}

    # An application transaction that has written to the table and is still open.
    open_writer = await engine.connect()
    transaction = await open_writer.begin()
    await open_writer.execute(insert, {**params, "id": "held"})

    migration = subprocess.Popen(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=BACKEND,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        # Wait until the build is under way and waiting for the open writer.
        deadline = time.monotonic() + 60
        building = False
        while time.monotonic() < deadline and not building:
            async with admin.connect() as connection:
                building = bool(
                    (
                        await connection.execute(
                            text(
                                "SELECT count(*) FROM pg_stat_activity WHERE "
                                "query ILIKE 'CREATE INDEX CONCURRENTLY%' "
                                "AND wait_event_type = 'Lock'"
                            )
                        )
                    ).scalar()
                )
            if not building:
                assert migration.poll() is None, migration.communicate()
                await asyncio.sleep(0.2)
        assert building, (
            "the concurrent index build never started waiting on the writer"
        )

        # A plain CREATE INDEX would hold a SHARE lock here and block this write.
        async def another_write() -> None:
            async with engine.begin() as connection:
                await connection.execute(text("SET LOCAL lock_timeout = '5s'"))
                await connection.execute(insert, {**params, "id": "during"})

        await asyncio.wait_for(another_write(), timeout=15)
    finally:
        await transaction.commit()
        await open_writer.close()

    stdout, stderr = await asyncio.to_thread(migration.communicate)
    assert migration.returncode == 0, stderr
    assert await _index_state(engine) == (True, True)
    async with engine.connect() as connection:
        rows = (
            await connection.execute(text("SELECT count(*) FROM inspection_bookings"))
        ).scalar()
    assert rows == 2  # both writes landed, including the one made mid-build
    await engine.dispose()


@pytestmark_pg
@pytest.mark.asyncio
async def test_upgrade_downgrade_and_reupgrade_on_postgresql(
    scratch_database: Any,
) -> None:
    url, environment, _ = scratch_database
    engine = create_async_engine(url)

    def alembic(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-m", "alembic", *args],
            cwd=BACKEND,
            env=environment,
            capture_output=True,
            text=True,
            timeout=300,
        )

    assert await _index_state(engine) == (False, None)
    assert alembic("upgrade", "head").returncode == 0
    assert await _index_state(engine) == (True, True)
    assert alembic("check").returncode == 0, "the model and the migration disagree"
    assert alembic("downgrade", "20261022_0022").returncode == 0
    assert await _index_state(engine) == (False, None)
    assert alembic("upgrade", "head").returncode == 0
    assert await _index_state(engine) == (True, True)
    await engine.dispose()
