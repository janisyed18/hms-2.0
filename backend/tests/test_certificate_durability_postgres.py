"""Certificate PDF / database crash consistency against real PostgreSQL.

Only PostgreSQL shows the transaction behaviour that matters here: a commit that
fails because the connection is genuinely gone, unique constraints released by a
rollback, and row locks serialising concurrent regenerations.
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import test_certificate_postgres_races as _races
from certificate_support import SigningFakeEngine, seed_approved_inspection
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError, InterfaceError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from test_certificate_postgres_races import RecordingStorage

import hms_backend.app.modules.certificates.issuance as issuance_module
from hms_backend.app.modules.certificates.integrity import pdf_sha256
from hms_backend.app.modules.certificates.issuance import (
    generate_and_store_certificate,
    next_revision_key,
    regenerate_certificate_pdf,
)
from hms_backend.app.modules.certificates.models import Certificate
from hms_backend.app.modules.certificates.reconcile import (
    delete_artifacts,
    find_unreferenced_artifacts,
)
from hms_backend.app.modules.inspections.models import Inspection

# Reuse the migrated-database wiring and instrumented storage from the race tests
# (assigned, not imported by name, so they register as fixtures in this module too).
database = _races.database
storage = _races.storage
trusted_engine = _races.trusted_engine

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)


async def _certificate_count(
    database: async_sessionmaker[AsyncSession], inspection_id: str
) -> int:
    async with database() as session:
        return int(
            await session.scalar(
                select(func.count())
                .select_from(Certificate)
                .where(Certificate.inspection_id == inspection_id)
            )
            or 0
        )


async def _terminate_backend(session: AsyncSession) -> None:
    """Kill this session's PostgreSQL backend from a second connection."""
    pid = await session.scalar(text("SELECT pg_backend_pid()"))
    async with session.bind.connect() as killer:  # type: ignore[union-attr]
        await killer.execute(text("SELECT pg_terminate_backend(:pid)"), {"pid": pid})
        await killer.commit()


@pytest.mark.asyncio
async def test_commit_that_really_fails_leaves_nothing_committed_and_retry_is_clean(
    database: async_sessionmaker[AsyncSession],
    storage: RecordingStorage,
    trusted_engine: SigningFakeEngine,
) -> None:
    tag = uuid4().hex[:10].upper()
    inspection_id = await seed_approved_inspection(database, tag)

    async with database() as session:
        inspection = await session.get(Inspection, inspection_id)
        assert inspection is not None
        staged = await generate_and_store_certificate(
            session,
            inspection,
            actor_id="issuer",
            engine=trusted_engine,
            storage=storage,
        )
        orphan_key = staged.pdf_object_key
        # The connection dies before COMMIT: PostgreSQL rolls the transaction back.
        await _terminate_backend(session)
        with pytest.raises((OperationalError, InterfaceError, DBAPIError)):
            await session.commit()
        await session.rollback()

    # Nothing committed, so no row can reference the object; the object is an orphan.
    assert await _certificate_count(database, inspection_id) == 0
    assert storage.exists(orphan_key)

    async with database() as session:
        young = await find_unreferenced_artifacts(
            session, storage, older_than=timedelta(hours=1)
        )
        assert orphan_key not in {o.key for o in young}  # inside the grace period
        later = datetime.now(UTC) + timedelta(hours=2)
        old = await find_unreferenced_artifacts(
            session, storage, older_than=timedelta(hours=1), now=later
        )
    orphans = [o for o in old if o.key == orphan_key]
    assert len(orphans) == 1
    await delete_artifacts(storage, orphans)
    assert not storage.exists(orphan_key)

    # Retry: exactly one certificate, whose object is present and byte-identical.
    async with database() as session:
        inspection = await session.get(Inspection, inspection_id)
        assert inspection is not None
        certificate = await generate_and_store_certificate(
            session,
            inspection,
            actor_id="issuer",
            engine=trusted_engine,
            storage=storage,
        )
        await session.commit()
        key, expected = certificate.pdf_object_key, certificate.pdf_sha256
    assert await _certificate_count(database, inspection_id) == 1
    assert pdf_sha256(storage.get(key)) == expected
    assert key != orphan_key


@pytest.mark.asyncio
async def test_failure_after_the_write_releases_the_number_and_retry_reuses_it(
    database: async_sessionmaker[AsyncSession],
    storage: RecordingStorage,
    trusted_engine: SigningFakeEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tag = uuid4().hex[:10].upper()
    inspection_id = await seed_approved_inspection(database, tag)
    number = f"CERT-DUR-{tag}"

    async def boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("audit write failed")

    async with database() as session:
        inspection = await session.get(Inspection, inspection_id)
        assert inspection is not None
        with monkeypatch.context() as patch:
            patch.setattr(issuance_module, "record_create", boom)
            with pytest.raises(RuntimeError, match="audit write failed"):
                await generate_and_store_certificate(
                    session,
                    inspection,
                    actor_id="issuer",
                    number=number,
                    engine=trusted_engine,
                    storage=storage,
                )
        await session.rollback()

    # The object was removed and the unique number/inspection were released.
    assert await _certificate_count(database, inspection_id) == 0
    assert storage.puts and storage.keys_on_disk() == []

    async with database() as session:
        inspection = await session.get(Inspection, inspection_id)
        assert inspection is not None
        certificate = await generate_and_store_certificate(
            session,
            inspection,
            actor_id="issuer",
            number=number,
            engine=trusted_engine,
            storage=storage,
        )
        await session.commit()
        assert certificate.number == number
    assert await _certificate_count(database, inspection_id) == 1
    assert storage.keys_on_disk() == [certificate.pdf_object_key]


async def _legacy_certificate(
    database: async_sessionmaker[AsyncSession],
    tag: str,
    engine: SigningFakeEngine,
    storage: RecordingStorage,
) -> tuple[str, str, bytes]:
    inspection_id = await seed_approved_inspection(database, tag)
    async with database() as session:
        inspection = await session.get(Inspection, inspection_id)
        assert inspection is not None
        certificate = await generate_and_store_certificate(
            session, inspection, actor_id="issuer", engine=engine, storage=storage
        )
        certificate.issuance_facts = None
        certificate.pdf_sha256 = None
        certificate.verification_hash = f"stale-{tag}"
        await session.commit()
        return (
            certificate.id,
            certificate.pdf_object_key,
            storage.get(certificate.pdf_object_key),
        )


async def _regenerate(
    database: async_sessionmaker[AsyncSession],
    certificate_id: str,
    engine: SigningFakeEngine,
    storage: RecordingStorage,
) -> str:
    async with database() as session:
        certificate = await session.get(Certificate, certificate_id)
        assert certificate is not None
        await regenerate_certificate_pdf(
            session, certificate, actor_id="repair", engine=engine, storage=storage
        )
        await session.commit()
        return certificate.pdf_object_key


@pytest.mark.asyncio
async def test_concurrent_regenerations_are_serialised_and_never_overwrite(
    database: async_sessionmaker[AsyncSession],
    storage: RecordingStorage,
    trusted_engine: SigningFakeEngine,
) -> None:
    tag = uuid4().hex[:10].upper()
    cid, old_key, old_bytes = await _legacy_certificate(
        database, tag, trusted_engine, storage
    )

    keys = await asyncio.gather(
        _regenerate(database, cid, trusted_engine, storage),
        _regenerate(database, cid, trusted_engine, storage),
    )

    # The row lock serialises them: each sees the previous committed key, so the two
    # replacements get distinct write-once keys and neither clobbers the other.
    first = next_revision_key(old_key)
    assert sorted(keys) == [first, next_revision_key(first)]
    async with database() as session:
        certificate = await session.get(Certificate, cid)
        assert certificate is not None
        assert certificate.pdf_object_key == next_revision_key(first)
    assert storage.get(old_key) == old_bytes
    assert all(storage.exists(k) for k in (old_key, *keys))
    assert await _count_for(database, cid) == 1


async def _count_for(database: async_sessionmaker[AsyncSession], cid: str) -> int:
    async with database() as session:
        return int(
            await session.scalar(
                select(func.count())
                .select_from(Certificate)
                .where(Certificate.id == cid)
            )
            or 0
        )


@pytest.mark.asyncio
async def test_regeneration_failing_mid_transaction_keeps_the_committed_artifact(
    database: async_sessionmaker[AsyncSession],
    storage: RecordingStorage,
    trusted_engine: SigningFakeEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tag = uuid4().hex[:10].upper()
    cid, old_key, old_bytes = await _legacy_certificate(
        database, tag, trusted_engine, storage
    )

    async def boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("audit write failed")

    async with database() as session:
        certificate = await session.get(Certificate, cid)
        assert certificate is not None
        with monkeypatch.context() as patch:
            patch.setattr(issuance_module, "record_update", boom)
            with pytest.raises(RuntimeError, match="audit write failed"):
                await regenerate_certificate_pdf(
                    session,
                    certificate,
                    actor_id="repair",
                    engine=trusted_engine,
                    storage=storage,
                )
        await session.rollback()

    async with database() as session:
        certificate = await session.get(Certificate, cid)
        assert certificate is not None
        assert certificate.pdf_object_key == old_key
    assert storage.get(old_key) == old_bytes
    assert not storage.exists(next_revision_key(old_key))  # replacement removed
