"""Find certificate PDFs in object storage that no certificate row references.

Issuance writes the PDF before the caller commits, so a process crash (or a failed
commit) after the write can leave an object nothing refers to. In-process
compensation cannot run in those cases; this does, out of band.

Every unreferenced object older than the grace period is *classified*, and only one
class is ever deletable:

``orphan``
    A leftover that no committed history needs: an issuance whose certificate row
    does not exist, or a regeneration attempt whose revision is **newer than** the
    revision the certificate currently points at (a failed or rolled-back attempt).
``superseded``
    An older revision of a certificate that was successfully regenerated
    (``v1.pdf`` once ``v1-r1.pdf`` is current). This is committed history and is
    retained; deleting it would be a separate retention decision, so this module
    never does.
``unclassified``
    Anything whose key does not follow the certificate key scheme. Reported, never
    deleted.

Deleting is safe against a concurrent regeneration because regeneration reuses the
``-rN`` key after a rolled-back attempt, so a candidate can legitimately become
referenced between the scan and the delete. For each candidate that belongs to an
existing certificate, :func:`delete_orphans` takes the same row lock regeneration
takes, re-checks the candidate under it, and holds the lock until the object is
deleted. The grace period is an additional safety buffer for issuance orphans, whose
row cannot be locked because it does not exist; it is not by itself a guarantee that
no transaction is still open.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.core.object_storage import ObjectStorage, StoredObject
from hms_backend.app.modules.certificates.models import Certificate

CERTIFICATE_KEY_PREFIX = "certificates/"
ORPHAN = "orphan"
SUPERSEDED = "superseded"
UNCLASSIFIED = "unclassified"
_QUERY_CHUNK = 500

_KEY = re.compile(
    r"^certificates/(?P<certificate_id>[^/]+)/v(?P<version>\d+)"
    r"(?:-r(?P<revision>\d+))?\.pdf$"
)


@dataclass(frozen=True)
class ArtifactFinding:
    """An unreferenced object, its classification and its certificate (if any)."""

    stored: StoredObject
    classification: str
    certificate_id: str | None


@dataclass(frozen=True)
class DeleteResult:
    deleted: list[str]
    skipped: list[tuple[str, str]]  # (key, reason)


def _parse(key: str) -> tuple[str, int, int] | None:
    """(certificate id, certificate version, revision) or None if not our scheme."""
    match = _KEY.match(key)
    if match is None:
        return None
    return (
        match.group("certificate_id"),
        int(match.group("version")),
        int(match.group("revision") or 0),
    )


def classify_key(key: str, *, certificate_exists: bool, current_key: str | None) -> str:
    """Classify an *unreferenced* ``key`` against the certificate it names.

    Pure so it can be re-run under the row lock with fresh data.
    """
    parsed = _parse(key)
    if parsed is None:
        return UNCLASSIFIED
    if not certificate_exists:
        return ORPHAN
    current = _parse(current_key) if current_key else None
    if current is None or current[:2] != parsed[:2]:
        return UNCLASSIFIED
    return ORPHAN if parsed[2] > current[2] else SUPERSEDED


async def find_unreferenced_artifacts(
    session: AsyncSession,
    storage: ObjectStorage,
    *,
    older_than: timedelta,
    prefix: str = CERTIFICATE_KEY_PREFIX,
    now: datetime | None = None,
) -> list[ArtifactFinding]:
    """Unreferenced objects under ``prefix`` older than ``older_than``, classified."""
    cutoff = (now or datetime.now(UTC)) - older_than
    candidates = [
        obj
        for obj in await asyncio.to_thread(storage.list_objects, prefix)
        if obj.last_modified <= cutoff
    ]
    referenced: set[str] = set()
    for start in range(0, len(candidates), _QUERY_CHUNK):
        keys = [obj.key for obj in candidates[start : start + _QUERY_CHUNK]]
        rows = await session.scalars(
            select(Certificate.pdf_object_key).where(
                Certificate.pdf_object_key.in_(keys)
            )
        )
        referenced.update(rows.all())

    findings: list[ArtifactFinding] = []
    for obj in candidates:
        if obj.key in referenced:
            continue
        parsed = _parse(obj.key)
        certificate_id = parsed[0] if parsed else None
        current_key: str | None = None
        exists = False
        if certificate_id is not None:
            current_key = await session.scalar(
                select(Certificate.pdf_object_key).where(
                    Certificate.id == certificate_id
                )
            )
            exists = current_key is not None
        findings.append(
            ArtifactFinding(
                stored=obj,
                classification=classify_key(
                    obj.key, certificate_exists=exists, current_key=current_key
                ),
                certificate_id=certificate_id,
            )
        )
    return findings


async def delete_orphans(
    session: AsyncSession,
    storage: ObjectStorage,
    findings: Sequence[ArtifactFinding],
) -> DeleteResult:
    """Delete the ``orphan`` findings, re-checking each one under the row lock.

    ``superseded`` and ``unclassified`` findings are never deleted. The scan that
    produced ``findings`` may be stale, so for every candidate that belongs to an
    existing certificate this takes the row lock regeneration takes
    (``SELECT ... FOR UPDATE``), re-classifies the key from the *current* row, and
    holds the lock until the delete has finished. A candidate that has meanwhile been
    adopted by a regeneration, or is no longer newer than the current revision, is
    skipped.
    """
    deleted: list[str] = []
    skipped: list[tuple[str, str]] = []
    for finding in findings:
        key = finding.stored.key
        if finding.classification != ORPHAN:
            skipped.append((key, f"not deletable: {finding.classification}"))
            continue
        try:
            current_key: str | None = None
            exists = False
            if finding.certificate_id is not None:
                current_key = await session.scalar(
                    select(Certificate.pdf_object_key)
                    .where(Certificate.id == finding.certificate_id)
                    .with_for_update()
                )
                exists = current_key is not None
            referenced = await session.scalar(
                select(func.count())
                .select_from(Certificate)
                .where(Certificate.pdf_object_key == key)
            )
            if referenced:
                skipped.append((key, "now referenced by a certificate"))
            elif (
                classify_key(key, certificate_exists=exists, current_key=current_key)
                != ORPHAN
            ):
                skipped.append((key, "no longer an orphan"))
            else:
                await asyncio.to_thread(storage.delete, key)
                deleted.append(key)
        except Exception as exc:  # noqa: BLE001 - one object must not stop the rest
            await session.rollback()
            skipped.append((key, f"delete failed: {type(exc).__name__}"))
        else:
            # Commit only after the delete: this releases the row lock, so a
            # regeneration waiting on it proceeds afterwards.
            await session.commit()
    return DeleteResult(deleted=deleted, skipped=skipped)
