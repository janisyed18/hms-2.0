"""Certificate issuance races against a dedicated, migrated PostgreSQL database.

SQLite cannot reproduce these: they need independent connections whose unique-index
checks block on each other's uncommitted rows. Synchronisation is by an
``asyncio.Barrier`` inside the engine's ``render`` so every contender has passed
the pre-checks before any of them flushes; no sleeps or timing assumptions.

Object storage is the external side effect under test, so it is instrumented to
record every ``put`` and assert exactly one artifact is ever written.
"""

from __future__ import annotations

import asyncio
import os
import threading
from collections.abc import AsyncIterator
from pathlib import Path
from uuid import uuid4

import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from certificate_support import (
    SigningFakeEngine,
    build_pki,
    seed_approved_inspection,
)
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.core.config import settings as app_settings
from hms_backend.app.core.object_storage import LocalObjectStorage
from hms_backend.app.modules.certificates.integrity import pdf_sha256
from hms_backend.app.modules.certificates.issuance import (
    CertificateConflictError,
    generate_and_store_certificate,
)
from hms_backend.app.modules.certificates.models import Certificate
from hms_backend.app.modules.identity import models as _identity_models  # noqa: F401
from hms_backend.app.modules.inspections.models import Inspection

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)


class RecordingStorage(LocalObjectStorage):
    """Thread-safe local store that records every write for assertions."""

    def __init__(self, root: Path) -> None:
        super().__init__(root)
        self._lock = threading.Lock()
        self.puts: list[tuple[str, str]] = []  # (key, sha256 of bytes written)

    def put(
        self, key: str, data: bytes, *, content_type: str = "application/pdf"
    ) -> str:
        with self._lock:
            self.puts.append((key, pdf_sha256(data)))
        return super().put(key, data, content_type=content_type)

    def keys_on_disk(self) -> list[str]:
        return sorted(str(p.relative_to(self._root)) for p in self._root.rglob("*.pdf"))


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


@pytest.fixture
def storage(tmp_path: Path) -> RecordingStorage:
    return RecordingStorage(tmp_path / "objects")


@pytest.fixture
def trusted_engine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> SigningFakeEngine:
    pki = build_pki(tmp_path / "pki")
    monkeypatch.setattr(
        app_settings, "certificate_trust_anchor_path", str(pki.anchor_path)
    )
    return SigningFakeEngine(pki.signer)


async def _attempt(
    database: async_sessionmaker[AsyncSession],
    inspection_id: str,
    number: str,
    engine: SigningFakeEngine,
    storage: RecordingStorage,
) -> str:
    """Issue in its own session/transaction; report 'issued' or 'conflict'."""
    async with database() as session:
        inspection = await session.get(Inspection, inspection_id)
        assert inspection is not None
        try:
            await generate_and_store_certificate(
                session,
                inspection,
                actor_id=f"issuer-{number}",
                number=number,
                engine=engine,
                storage=storage,
            )
            await session.commit()
        except CertificateConflictError:
            await session.rollback()
            return "conflict"
        return "issued"


def _gate_on_barrier(engine: SigningFakeEngine, parties: int) -> None:
    """Hold every contender inside ``render`` until all have reached it.

    Rendering happens after the number / inspection pre-checks and before the DB
    flush, so once the barrier opens every contender has passed its pre-checks and
    none has yet reserved anything: the flush is the only thing left to decide.
    """
    barrier = asyncio.Barrier(parties)

    async def wait() -> None:
        await barrier.wait()

    engine.on_render = wait


@pytest.mark.asyncio
async def test_same_number_concurrently_has_one_winner_and_one_artifact(
    database: async_sessionmaker[AsyncSession],
    storage: RecordingStorage,
    trusted_engine: SigningFakeEngine,
) -> None:
    contenders = 4
    token = uuid4().hex[:12].upper()
    number = f"CERT-RACE-{token}"
    inspection_ids = [
        await seed_approved_inspection(database, f"{token}-{i}")
        for i in range(contenders)
    ]
    _gate_on_barrier(trusted_engine, contenders)

    results = await asyncio.gather(
        *(
            _attempt(database, inspection_id, number, trusted_engine, storage)
            for inspection_id in inspection_ids
        )
    )

    assert sorted(results) == ["conflict"] * (contenders - 1) + ["issued"]
    async with database() as session:
        winner = (
            await session.scalars(
                select(Certificate).where(Certificate.number == number)
            )
        ).one()
    # Exactly one external write, to the winner's opaque key, with the winner's bytes.
    assert storage.puts == [(winner.pdf_object_key, winner.pdf_sha256)]
    assert storage.keys_on_disk() == [winner.pdf_object_key]
    assert pdf_sha256(storage.get(winner.pdf_object_key)) == winner.pdf_sha256


@pytest.mark.asyncio
async def test_same_inspection_concurrently_has_one_winner_and_one_artifact(
    database: async_sessionmaker[AsyncSession],
    storage: RecordingStorage,
    trusted_engine: SigningFakeEngine,
) -> None:
    contenders = 3
    token = uuid4().hex[:12].upper()
    inspection_id = await seed_approved_inspection(database, token)
    _gate_on_barrier(trusted_engine, contenders)

    results = await asyncio.gather(
        *(
            _attempt(
                database,
                inspection_id,
                f"CERT-INSP-{token}-{i}",
                trusted_engine,
                storage,
            )
            for i in range(contenders)
        )
    )

    assert sorted(results) == ["conflict"] * (contenders - 1) + ["issued"]
    async with database() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(Certificate)
            .where(Certificate.inspection_id == inspection_id)
        )
        winner = (
            await session.scalars(
                select(Certificate).where(Certificate.inspection_id == inspection_id)
            )
        ).one()
    assert count == 1
    assert storage.puts == [(winner.pdf_object_key, winner.pdf_sha256)]
    assert storage.keys_on_disk() == [winner.pdf_object_key]
