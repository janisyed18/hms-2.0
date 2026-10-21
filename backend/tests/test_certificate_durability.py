"""Certificate PDF / database crash consistency (SQLite + local object storage).

The external object write is the side effect that a database transaction cannot roll
back, so each failure point is injected explicitly and the invariants asserted:

* a committed certificate never references a missing or unverified PDF;
* a failure after the object write leaves no database/object inconsistency;
* regeneration never overwrites the committed artifact before the replacement is
  safely committed;
* retries are deterministic and never create a duplicate certificate.
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio
from certificate_support import SigningFakeEngine, build_pki
from certificate_support import seed_approved_inspection as seed
from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import hms_backend.app.modules.certificates.issuance as issuance_module
from hms_backend.app.core.config import settings as app_settings
from hms_backend.app.core.object_storage import LocalObjectStorage
from hms_backend.app.models.base import Base
from hms_backend.app.modules.certificates.integrity import pdf_sha256
from hms_backend.app.modules.certificates.issuance import (
    CertificateStorageError,
    generate_and_store_certificate,
    next_revision_key,
    regenerate_certificate_pdf,
)
from hms_backend.app.modules.certificates.models import Certificate
from hms_backend.app.modules.certificates.reconcile import (
    ORPHAN,
    SUPERSEDED,
    UNCLASSIFIED,
    delete_orphans,
    find_unreferenced_artifacts,
)
from hms_backend.app.modules.identity import models as _identity_models  # noqa: F401
from hms_backend.app.modules.inspections.models import Inspection
from hms_backend.app.modules.jobs import models as _jobs_models  # noqa: F401
from hms_backend.app.modules.notifications import (
    models as _notification_models,  # noqa: F401
)


class FlakyStorage(LocalObjectStorage):
    """Local store with explicit, single-shot failure injection."""

    def __init__(self, root: Path) -> None:
        super().__init__(root)
        self.fail_next_puts = 0  # raise before writing anything
        self.write_then_fail_next_puts = 0  # write the object, then raise
        self.corrupt_reads = False
        self.fail_deletes = False
        self.deleted: list[str] = []

    def put(
        self, key: str, data: bytes, *, content_type: str = "application/pdf"
    ) -> str:
        if self.fail_next_puts:
            self.fail_next_puts -= 1
            raise OSError("disk full")
        super().put(key, data, content_type=content_type)
        if self.write_then_fail_next_puts:
            self.write_then_fail_next_puts -= 1
            raise OSError("connection reset after the write was accepted")
        return key

    def get(self, key: str) -> bytes:
        data = super().get(key)
        return data + b"corrupt" if self.corrupt_reads else data

    def delete(self, key: str) -> None:
        if self.fail_deletes:
            raise OSError("delete denied")
        self.deleted.append(key)
        super().delete(key)

    def keys(self) -> list[str]:
        return [o.key for o in self.list_objects("certificates/")]


@pytest.fixture(scope="module")
def pki(tmp_path_factory: pytest.TempPathFactory) -> Any:
    return build_pki(tmp_path_factory.mktemp("durability-pki"))


@pytest.fixture(autouse=True)
def _trust_anchor(pki: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        app_settings, "certificate_trust_anchor_path", str(pki.anchor_path)
    )


@pytest.fixture
def storage(tmp_path: Path) -> FlakyStorage:
    return FlakyStorage(tmp_path / "objects")


@pytest.fixture
def engine(pki: Any) -> SigningFakeEngine:
    return SigningFakeEngine(pki.signer)


@pytest_asyncio.fixture
async def factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    db = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with db.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(db, expire_on_commit=False)
    await db.dispose()


async def _count(factory: async_sessionmaker[AsyncSession]) -> int:
    async with factory() as session:
        return int(
            await session.scalar(select(func.count()).select_from(Certificate)) or 0
        )


async def _issue_once(
    factory: async_sessionmaker[AsyncSession],
    inspection_id: str,
    engine: SigningFakeEngine,
    storage: FlakyStorage,
) -> Certificate:
    async with factory() as session:
        inspection = await session.get(Inspection, inspection_id)
        assert inspection is not None
        certificate = await generate_and_store_certificate(
            session, inspection, actor_id="issuer", engine=engine, storage=storage
        )
        await session.commit()
        return certificate


async def _attempt_and_roll_back(
    factory: async_sessionmaker[AsyncSession],
    inspection_id: str,
    engine: SigningFakeEngine,
    storage: FlakyStorage,
) -> None:
    async with factory() as session:
        inspection = await session.get(Inspection, inspection_id)
        assert inspection is not None
        try:
            await generate_and_store_certificate(
                session, inspection, actor_id="issuer", engine=engine, storage=storage
            )
        finally:
            await session.rollback()


async def _assert_committed_pdf_is_intact(
    factory: async_sessionmaker[AsyncSession], storage: FlakyStorage
) -> None:
    """The headline invariant, checked against the database as committed."""
    async with factory() as session:
        for certificate in (await session.scalars(select(Certificate))).all():
            assert storage.exists(certificate.pdf_object_key), certificate.number
            if certificate.pdf_sha256 is not None:
                stored = storage.get(certificate.pdf_object_key)
                assert pdf_sha256(stored) == certificate.pdf_sha256


# --- issuance ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_storage_failure_writes_nothing_and_a_retry_issues_exactly_one(
    factory: async_sessionmaker[AsyncSession],
    storage: FlakyStorage,
    engine: SigningFakeEngine,
) -> None:
    inspection_id = await seed(factory, "D1")
    storage.fail_next_puts = 1

    with pytest.raises(OSError, match="disk full"):
        await _attempt_and_roll_back(factory, inspection_id, engine, storage)
    assert await _count(factory) == 0
    assert storage.keys() == []

    certificate = await _issue_once(factory, inspection_id, engine, storage)

    assert await _count(factory) == 1
    assert storage.keys() == [certificate.pdf_object_key]
    await _assert_committed_pdf_is_intact(factory, storage)


@pytest.mark.asyncio
async def test_ambiguous_write_error_is_cleaned_up_and_retry_succeeds(
    factory: async_sessionmaker[AsyncSession],
    storage: FlakyStorage,
    engine: SigningFakeEngine,
) -> None:
    """The store accepted the bytes but the caller saw an error: no orphan remains."""
    inspection_id = await seed(factory, "D2")
    storage.write_then_fail_next_puts = 1

    with pytest.raises(OSError, match="connection reset"):
        await _attempt_and_roll_back(factory, inspection_id, engine, storage)
    assert await _count(factory) == 0
    assert storage.keys() == []
    assert len(storage.deleted) == 1

    await _issue_once(factory, inspection_id, engine, storage)
    assert await _count(factory) == 1
    await _assert_committed_pdf_is_intact(factory, storage)


@pytest.mark.asyncio
@pytest.mark.parametrize("failing_step", ["record_create", "emit_event"])
async def test_failure_after_the_object_write_removes_the_object(
    failing_step: str,
    factory: async_sessionmaker[AsyncSession],
    storage: FlakyStorage,
    engine: SigningFakeEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    inspection_id = await seed(factory, f"D3{failing_step[:2].upper()}")

    async def boom(*_a: object, **_k: object) -> None:
        raise RuntimeError(f"{failing_step} failed")

    with monkeypatch.context() as patch:
        patch.setattr(issuance_module, failing_step, boom)
        with pytest.raises(RuntimeError, match=f"{failing_step} failed"):
            await _attempt_and_roll_back(factory, inspection_id, engine, storage)

    assert await _count(factory) == 0
    assert storage.keys() == []

    await _issue_once(factory, inspection_id, engine, storage)
    assert await _count(factory) == 1
    await _assert_committed_pdf_is_intact(factory, storage)


@pytest.mark.asyncio
async def test_unverifiable_readback_is_refused_and_cleaned_up(
    factory: async_sessionmaker[AsyncSession],
    storage: FlakyStorage,
    engine: SigningFakeEngine,
) -> None:
    inspection_id = await seed(factory, "D4")
    storage.corrupt_reads = True

    with pytest.raises(CertificateStorageError):
        await _attempt_and_roll_back(factory, inspection_id, engine, storage)

    storage.corrupt_reads = False
    assert await _count(factory) == 0
    assert storage.keys() == []


@pytest.mark.asyncio
async def test_a_failed_cleanup_never_masks_the_original_error(
    factory: async_sessionmaker[AsyncSession],
    storage: FlakyStorage,
    engine: SigningFakeEngine,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    inspection_id = await seed(factory, "D5")
    storage.fail_deletes = True

    async def boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("the real failure")

    monkeypatch.setattr(issuance_module, "record_create", boom)
    with caplog.at_level(logging.WARNING, logger=issuance_module.logger.name):
        with pytest.raises(RuntimeError, match="the real failure"):
            await _attempt_and_roll_back(factory, inspection_id, engine, storage)

    assert await _count(factory) == 0
    assert len(storage.keys()) == 1  # an orphan, left for reconciliation
    assert "reconcile_certificate_artifacts" in caplog.text


@pytest.mark.asyncio
async def test_commit_failure_leaves_a_reconcilable_orphan_and_retry_is_clean(
    factory: async_sessionmaker[AsyncSession],
    storage: FlakyStorage,
    engine: SigningFakeEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed commit cannot trigger in-process cleanup; reconciliation covers it."""
    inspection_id = await seed(factory, "D6")
    async with factory() as session:
        inspection = await session.get(Inspection, inspection_id)
        assert inspection is not None
        staged = await generate_and_store_certificate(
            session, inspection, actor_id="issuer", engine=engine, storage=storage
        )
        orphan_key = staged.pdf_object_key

        async def failing_commit() -> None:
            raise OperationalError("COMMIT", {}, Exception("connection lost"))

        monkeypatch.setattr(session, "commit", failing_commit)
        with pytest.raises(OperationalError):
            await session.commit()
        await session.rollback()

    assert await _count(factory) == 0
    assert storage.keys() == [orphan_key]

    async with factory() as session:
        # Inside the grace period the object might belong to an open transaction.
        assert (
            await find_unreferenced_artifacts(
                session, storage, older_than=timedelta(hours=1)
            )
            == []
        )
        later = datetime.now(UTC) + timedelta(hours=2)
        findings = await find_unreferenced_artifacts(
            session, storage, older_than=timedelta(hours=1), now=later
        )
        assert [(f.stored.key, f.classification) for f in findings] == [
            (orphan_key, ORPHAN)
        ]
        result = await delete_orphans(session, storage, findings)
    assert result.deleted == [orphan_key]
    assert storage.keys() == []

    certificate = await _issue_once(factory, inspection_id, engine, storage)
    assert await _count(factory) == 1
    assert storage.keys() == [certificate.pdf_object_key]
    await _assert_committed_pdf_is_intact(factory, storage)


# --- regeneration ---------------------------------------------------------------


async def _legacy_certificate(
    factory: async_sessionmaker[AsyncSession],
    label: str,
    engine: SigningFakeEngine,
    storage: FlakyStorage,
) -> tuple[str, str, bytes]:
    """An issued certificate recast as legacy: returns (id, key, committed bytes)."""
    inspection_id = await seed(factory, label)
    certificate = await _issue_once(factory, inspection_id, engine, storage)
    async with factory() as session:
        row = await session.get(Certificate, certificate.id)
        assert row is not None
        row.issuance_facts = None
        row.pdf_sha256 = None
        row.verification_hash = f"stale-{label}"
        await session.commit()
    return (
        certificate.id,
        certificate.pdf_object_key,
        storage.get(certificate.pdf_object_key),
    )


async def _regenerate(
    factory: async_sessionmaker[AsyncSession],
    certificate_id: str,
    engine: SigningFakeEngine,
    storage: FlakyStorage,
    *,
    commit: bool = True,
) -> str:
    async with factory() as session:
        certificate = await session.get(Certificate, certificate_id)
        assert certificate is not None
        try:
            await regenerate_certificate_pdf(
                session, certificate, actor_id="repair", engine=engine, storage=storage
            )
            key = certificate.pdf_object_key
            if commit:
                await session.commit()
            return key
        finally:
            if not commit:
                await session.rollback()


async def _committed_key(
    factory: async_sessionmaker[AsyncSession], certificate_id: str
) -> str:
    async with factory() as session:
        certificate = await session.get(Certificate, certificate_id)
        assert certificate is not None
        return certificate.pdf_object_key


@pytest.mark.asyncio
async def test_regeneration_writes_a_new_key_and_keeps_the_committed_artifact(
    factory: async_sessionmaker[AsyncSession],
    storage: FlakyStorage,
    engine: SigningFakeEngine,
) -> None:
    cid, old_key, old_bytes = await _legacy_certificate(factory, "R1", engine, storage)

    new_key = await _regenerate(factory, cid, engine, storage)

    assert new_key == next_revision_key(old_key) != old_key
    assert await _committed_key(factory, cid) == new_key
    assert storage.get(old_key) == old_bytes  # never overwritten
    assert storage.exists(new_key)
    await _assert_committed_pdf_is_intact(factory, storage)


@pytest.mark.asyncio
async def test_regeneration_failure_after_the_write_keeps_the_committed_artifact(
    factory: async_sessionmaker[AsyncSession],
    storage: FlakyStorage,
    engine: SigningFakeEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cid, old_key, old_bytes = await _legacy_certificate(factory, "R2", engine, storage)

    async def boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("audit write failed")

    with monkeypatch.context() as patch:
        patch.setattr(issuance_module, "record_update", boom)
        with pytest.raises(RuntimeError, match="audit write failed"):
            await _regenerate(factory, cid, engine, storage, commit=False)

    assert await _committed_key(factory, cid) == old_key
    assert storage.get(old_key) == old_bytes
    assert storage.keys() == [old_key]  # the replacement was removed
    await _assert_committed_pdf_is_intact(factory, storage)


@pytest.mark.asyncio
async def test_regeneration_storage_failure_changes_nothing(
    factory: async_sessionmaker[AsyncSession],
    storage: FlakyStorage,
    engine: SigningFakeEngine,
) -> None:
    cid, old_key, old_bytes = await _legacy_certificate(factory, "R3", engine, storage)
    storage.fail_next_puts = 1

    with pytest.raises(OSError, match="disk full"):
        await _regenerate(factory, cid, engine, storage, commit=False)

    assert await _committed_key(factory, cid) == old_key
    assert storage.get(old_key) == old_bytes
    assert storage.keys() == [old_key]


@pytest.mark.asyncio
async def test_regeneration_rollback_leaves_the_row_and_old_object_untouched(
    factory: async_sessionmaker[AsyncSession],
    storage: FlakyStorage,
    engine: SigningFakeEngine,
) -> None:
    cid, old_key, old_bytes = await _legacy_certificate(factory, "R4", engine, storage)

    first = await _regenerate(factory, cid, engine, storage, commit=False)

    assert await _committed_key(factory, cid) == old_key
    assert storage.get(old_key) == old_bytes
    assert first == next_revision_key(old_key)

    # A retry is deterministic: it targets the same (unreferenced) key and commits.
    retry = await _regenerate(factory, cid, engine, storage)
    assert retry == first
    assert await _committed_key(factory, cid) == first
    await _assert_committed_pdf_is_intact(factory, storage)

    # A later regeneration moves on to the next revision; nothing is overwritten.
    second = await _regenerate(factory, cid, engine, storage)
    assert second == next_revision_key(first)
    assert storage.exists(first) and storage.exists(old_key)
    assert await _count(factory) == 1


# --- reconciliation -------------------------------------------------------------


@pytest.mark.asyncio
async def test_reconciliation_only_reports_old_unreferenced_objects(
    factory: async_sessionmaker[AsyncSession],
    storage: FlakyStorage,
    engine: SigningFakeEngine,
) -> None:
    kept = await _issue_once(factory, await seed(factory, "C1"), engine, storage)
    soft_deleted = await _issue_once(
        factory, await seed(factory, "C2"), engine, storage
    )
    async with factory() as session:
        row = await session.get(Certificate, soft_deleted.id)
        assert row is not None
        row.deleted_at = datetime.now(UTC)
        await session.commit()
    storage.put("certificates/orphan/v1.pdf", b"%PDF-orphan")
    storage.put("other/prefix/file.pdf", b"%PDF-elsewhere")
    later = datetime.now(UTC) + timedelta(hours=2)

    async with factory() as session:
        young = await find_unreferenced_artifacts(
            session, storage, older_than=timedelta(hours=1)
        )
        old = await find_unreferenced_artifacts(
            session, storage, older_than=timedelta(hours=1), now=later
        )

    assert young == []
    # Referenced objects (including a soft-deleted certificate's) and objects outside
    # the certificate prefix are never candidates.
    assert [(f.stored.key, f.classification) for f in old] == [
        ("certificates/orphan/v1.pdf", ORPHAN)
    ]
    assert storage.exists(kept.pdf_object_key)
    assert storage.exists(soft_deleted.pdf_object_key)
    assert storage.exists("certificates/orphan/v1.pdf")  # finding never deletes


def _aged() -> datetime:
    return datetime.now(UTC) + timedelta(hours=2)


@pytest.mark.asyncio
async def test_committed_revision_history_is_never_treated_as_an_orphan(
    factory: async_sessionmaker[AsyncSession],
    storage: FlakyStorage,
    engine: SigningFakeEngine,
) -> None:
    """v1 -> r1 -> r2 is committed history; only a newer, uncommitted r3 is garbage."""
    cid, v1_key, v1_bytes = await _legacy_certificate(factory, "H1", engine, storage)
    r1 = await _regenerate(factory, cid, engine, storage)
    r2 = await _regenerate(factory, cid, engine, storage)
    r3 = next_revision_key(r2)
    storage.put(r3, b"%PDF-failed-attempt")  # a leftover from a failed attempt
    custom = f"certificates/{cid}/custom-name.pdf"
    storage.put(custom, b"%PDF-unrelated")

    async with factory() as session:
        findings = await find_unreferenced_artifacts(
            session, storage, older_than=timedelta(hours=1), now=_aged()
        )
        by_key = {f.stored.key: f.classification for f in findings}
        assert by_key == {
            v1_key: SUPERSEDED,
            r1: SUPERSEDED,
            r3: ORPHAN,
            custom: UNCLASSIFIED,
        }
        result = await delete_orphans(session, storage, findings)

    # Blanket "apply" removes only the genuine orphan; history and the committed
    # artifact survive.
    assert result.deleted == [r3]
    assert storage.get(v1_key) == v1_bytes
    assert storage.exists(r1) and storage.exists(r2) and storage.exists(custom)
    assert not storage.exists(r3)
    await _assert_committed_pdf_is_intact(factory, storage)


@pytest.mark.asyncio
async def test_a_stale_scan_cannot_delete_a_key_a_regeneration_has_since_adopted(
    factory: async_sessionmaker[AsyncSession],
    storage: FlakyStorage,
    engine: SigningFakeEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Scan selects r1 as an orphan; a retry then legitimately adopts r1."""
    cid, v1_key, _ = await _legacy_certificate(factory, "S1", engine, storage)
    r1 = next_revision_key(v1_key)

    # A failed attempt whose own cleanup also failed leaves r1 behind, unreferenced.
    async def boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("audit write failed")

    storage.fail_deletes = True
    with monkeypatch.context() as patch:
        patch.setattr(issuance_module, "record_update", boom)
        with pytest.raises(RuntimeError, match="audit write failed"):
            await _regenerate(factory, cid, engine, storage, commit=False)
    storage.fail_deletes = False
    assert storage.exists(r1)

    async with factory() as session:
        stale = await find_unreferenced_artifacts(
            session, storage, older_than=timedelta(hours=1), now=_aged()
        )
        assert [(f.stored.key, f.classification) for f in stale] == [(r1, ORPHAN)]

        # The legitimate retry commits, adopting the very same key.
        assert await _regenerate(factory, cid, engine, storage) == r1

        result = await delete_orphans(session, storage, stale)

    assert result.deleted == []
    assert result.skipped == [(r1, "now referenced by a certificate")]
    assert await _committed_key(factory, cid) == r1
    await _assert_committed_pdf_is_intact(factory, storage)


@pytest.mark.asyncio
async def test_regeneration_rechecks_eligibility_after_taking_the_lock(
    factory: async_sessionmaker[AsyncSession],
    storage: FlakyStorage,
    engine: SigningFakeEngine,
) -> None:
    """A concurrent change made after the in-memory copy was loaded is honoured."""
    cid, old_key, old_bytes = await _legacy_certificate(factory, "E1", engine, storage)
    async with factory() as stale_session:
        stale_copy = await stale_session.get(Certificate, cid)
        assert stale_copy is not None
        assert stale_copy.status == "ISSUED"  # what the stale copy believes

        async with factory() as other:
            row = await other.get(Certificate, cid)
            assert row is not None
            row.status = "REVOKED"
            await other.commit()

        with pytest.raises(ValueError, match="only issued certificates"):
            await regenerate_certificate_pdf(
                stale_session,
                stale_copy,
                actor_id="repair",
                engine=engine,
                storage=storage,
            )

    assert storage.keys() == [old_key]  # nothing was rendered or written
    assert storage.get(old_key) == old_bytes


@pytest.mark.asyncio
async def test_regeneration_rechecks_issuance_evidence_after_taking_the_lock(
    factory: async_sessionmaker[AsyncSession],
    storage: FlakyStorage,
    engine: SigningFakeEngine,
) -> None:
    cid, old_key, _ = await _legacy_certificate(factory, "E2", engine, storage)
    async with factory() as stale_session:
        stale_copy = await stale_session.get(Certificate, cid)
        assert stale_copy is not None
        assert stale_copy.issuance_facts is None

        async with factory() as other:
            row = await other.get(Certificate, cid)
            assert row is not None
            row.issuance_facts = {"upgraded": True}
            await other.commit()

        with pytest.raises(ValueError, match="issuance evidence"):
            await regenerate_certificate_pdf(
                stale_session,
                stale_copy,
                actor_id="repair",
                engine=engine,
                storage=storage,
            )

    assert storage.keys() == [old_key]


# --- key derivation and local storage primitives --------------------------------


@pytest.mark.parametrize(
    ("key", "expected"),
    [
        ("certificates/abc/v1.pdf", "certificates/abc/v1-r1.pdf"),
        ("certificates/abc/v1-r1.pdf", "certificates/abc/v1-r2.pdf"),
        ("certificates/abc/v1-r9.pdf", "certificates/abc/v1-r10.pdf"),
        ("legacy/some-file.pdf", "legacy/some-file-r1.pdf"),
        ("legacy/no-extension", "legacy/no-extension-r1"),
    ],
)
def test_next_revision_key_is_deterministic(key: str, expected: str) -> None:
    assert next_revision_key(key) == expected


def test_local_put_is_atomic_and_delete_is_idempotent(
    storage: FlakyStorage, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage.put("certificates/a/v1.pdf", b"one")
    real_replace = os.replace

    def failing_replace(*_a: object, **_k: object) -> None:
        raise OSError("rename failed")

    monkeypatch.setattr(os, "replace", failing_replace)
    with pytest.raises(OSError, match="rename failed"):
        LocalObjectStorage.put(storage, "certificates/a/v1.pdf", b"two")
    monkeypatch.setattr(os, "replace", real_replace)

    # The committed bytes are intact and no temp file is left behind or listed.
    assert storage.get("certificates/a/v1.pdf") == b"one"
    assert [o.key for o in storage.list_objects("")] == ["certificates/a/v1.pdf"]
    assert list((storage._root / "certificates" / "a").iterdir()) == [  # noqa: SLF001
        storage._root / "certificates" / "a" / "v1.pdf"  # noqa: SLF001
    ]

    storage.delete("certificates/a/v1.pdf")
    storage.delete("certificates/a/v1.pdf")  # missing key: not an error
    assert not storage.exists("certificates/a/v1.pdf")


def test_local_list_objects_filters_by_prefix(storage: FlakyStorage) -> None:
    storage.put("certificates/a/v1.pdf", b"a")
    storage.put("certificates/b/v1.pdf", b"bb")
    storage.put("media/x.png", b"x")

    listed = {o.key: o.size for o in storage.list_objects("certificates/")}

    assert listed == {"certificates/a/v1.pdf": 1, "certificates/b/v1.pdf": 2}
