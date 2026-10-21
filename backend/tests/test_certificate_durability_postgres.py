"""Certificate PDF / database crash consistency against real PostgreSQL.

Only PostgreSQL shows the transaction behaviour that matters here: a commit that
fails because the connection is genuinely gone, unique constraints released by a
rollback, and row locks serialising concurrent regenerations.
"""

from __future__ import annotations

import asyncio
import os
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
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
    ORPHAN,
    SUPERSEDED,
    delete_orphans,
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
        assert orphan_key not in {f.stored.key for f in young}  # inside the grace
        later = datetime.now(UTC) + timedelta(hours=2)
        old = await find_unreferenced_artifacts(
            session, storage, older_than=timedelta(hours=1), now=later
        )
        mine = [f for f in old if f.stored.key == orphan_key]
        assert [f.classification for f in mine] == [ORPHAN]
        result = await delete_orphans(session, storage, mine)
    assert result.deleted == [orphan_key]
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


def _aged() -> datetime:
    return datetime.now(UTC) + timedelta(hours=2)


@pytest.mark.asyncio
async def test_committed_revision_history_survives_orphan_reconciliation(
    database: async_sessionmaker[AsyncSession],
    storage: RecordingStorage,
    trusted_engine: SigningFakeEngine,
) -> None:
    tag = uuid4().hex[:10].upper()
    cid, v1_key, v1_bytes = await _legacy_certificate(
        database, tag, trusted_engine, storage
    )
    r1 = await _regenerate(database, cid, trusted_engine, storage)
    r2 = await _regenerate(database, cid, trusted_engine, storage)
    r3 = next_revision_key(r2)
    storage.put(r3, b"%PDF-failed-attempt")

    async with database() as session:
        findings = [
            f
            for f in await find_unreferenced_artifacts(
                session, storage, older_than=timedelta(hours=1), now=_aged()
            )
            if f.certificate_id == cid
        ]
        assert {f.stored.key: f.classification for f in findings} == {
            v1_key: SUPERSEDED,
            r1: SUPERSEDED,
            r3: ORPHAN,
        }
        result = await delete_orphans(session, storage, findings)

    assert result.deleted == [r3]
    assert storage.get(v1_key) == v1_bytes
    assert storage.exists(r1) and storage.exists(r2) and not storage.exists(r3)
    async with database() as session:
        certificate = await session.get(Certificate, cid)
        assert certificate is not None
        assert certificate.pdf_object_key == r2


@pytest.mark.asyncio
async def test_a_stale_scan_cannot_delete_a_key_a_regeneration_adopts_in_between(
    database: async_sessionmaker[AsyncSession],
    storage: RecordingStorage,
    trusted_engine: SigningFakeEngine,
) -> None:
    """The reviewed race: the reconciler selected r1; a retry then adopts r1."""
    tag = uuid4().hex[:10].upper()
    cid, v1_key, _ = await _legacy_certificate(database, tag, trusted_engine, storage)
    r1 = next_revision_key(v1_key)
    storage.put(r1, b"%PDF-left-by-a-failed-attempt")  # unreferenced, hours old

    async with database() as session:
        stale = [
            f
            for f in await find_unreferenced_artifacts(
                session, storage, older_than=timedelta(hours=1), now=_aged()
            )
            if f.certificate_id == cid
        ]
        assert [(f.stored.key, f.classification) for f in stale] == [(r1, ORPHAN)]

        # Between the scan and the delete, a legitimate retry adopts the same key.
        assert await _regenerate(database, cid, trusted_engine, storage) == r1
        result = await delete_orphans(session, storage, stale)

    assert result.deleted == []
    assert result.skipped == [(r1, "now referenced by a certificate")]
    async with database() as session:
        certificate = await session.get(Certificate, cid)
        assert certificate is not None
        assert certificate.pdf_object_key == r1
    assert storage.exists(r1)  # the committed artifact survived


class _BlockingDeleteStorage(RecordingStorage):
    """Pauses inside ``delete`` so the test can interleave a regeneration."""

    def __init__(self, root: Path) -> None:
        super().__init__(root)
        self.delete_started = threading.Event()
        self.release_delete = threading.Event()

    def delete(self, key: str) -> None:
        self.delete_started.set()
        assert self.release_delete.wait(timeout=30), "test never released the delete"
        super().delete(key)


async def _wait_until_blocked_on_certificate_row_lock(
    database: async_sessionmaker[AsyncSession],
) -> None:
    for _ in range(200):
        async with database() as session:
            blocked = await session.scalar(
                text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE wait_event_type = 'Lock' AND query ILIKE '%certificates%' "
                    "AND query ILIKE '%FOR UPDATE%'"
                )
            )
        if blocked:
            return
        await asyncio.sleep(0.05)
    raise AssertionError("no session is blocked on the certificate row lock")


@pytest.mark.asyncio
async def test_the_reconciler_holds_the_row_lock_through_the_delete(
    database: async_sessionmaker[AsyncSession],
    tmp_path: Path,
    trusted_engine: SigningFakeEngine,
) -> None:
    """A regeneration cannot adopt a candidate while it is being deleted."""
    store = _BlockingDeleteStorage(tmp_path / "objects")
    tag = uuid4().hex[:10].upper()
    cid, v1_key, _ = await _legacy_certificate(database, tag, trusted_engine, store)
    r1 = next_revision_key(v1_key)
    store.put(r1, b"%PDF-left-by-a-failed-attempt")

    async def reconcile() -> list[str]:
        async with database() as session:
            findings = [
                f
                for f in await find_unreferenced_artifacts(
                    session, store, older_than=timedelta(hours=1), now=_aged()
                )
                if f.certificate_id == cid
            ]
            return (await delete_orphans(session, store, findings)).deleted

    reconciling = asyncio.create_task(reconcile())
    # The reconciler now holds the lock and is paused inside the delete.
    assert await asyncio.to_thread(store.delete_started.wait, 30)

    regenerating = asyncio.create_task(
        _regenerate(database, cid, trusted_engine, store)
    )
    await _wait_until_blocked_on_certificate_row_lock(database)
    assert not regenerating.done()  # it cannot proceed while the delete is running

    store.release_delete.set()
    assert await reconciling == [r1]
    # Only after the delete does the regeneration run; it writes r1 afresh.
    assert await regenerating == r1
    async with database() as session:
        certificate = await session.get(Certificate, cid)
        assert certificate is not None
        assert certificate.pdf_object_key == r1
    assert store.exists(r1)
    assert pdf_sha256(store.get(r1)) != pdf_sha256(b"%PDF-left-by-a-failed-attempt")


@pytest.mark.asyncio
async def test_regeneration_eligibility_is_rechecked_under_the_row_lock(
    database: async_sessionmaker[AsyncSession],
    storage: RecordingStorage,
    trusted_engine: SigningFakeEngine,
) -> None:
    tag = uuid4().hex[:10].upper()
    cid, old_key, old_bytes = await _legacy_certificate(
        database, tag, trusted_engine, storage
    )
    async with database() as stale_session:
        stale_copy = await stale_session.get(Certificate, cid)
        assert stale_copy is not None and stale_copy.status == "ISSUED"

        async with database() as other:
            row = await other.get(Certificate, cid)
            assert row is not None
            row.status = "REVOKED"
            await other.commit()

        with pytest.raises(ValueError, match="only issued certificates"):
            await regenerate_certificate_pdf(
                stale_session,
                stale_copy,
                actor_id="repair",
                engine=trusted_engine,
                storage=storage,
            )

    assert storage.get(old_key) == old_bytes
    assert not storage.exists(next_revision_key(old_key))
