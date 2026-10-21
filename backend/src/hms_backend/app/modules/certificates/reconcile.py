"""Find certificate PDFs in object storage that no certificate row references.

Issuance writes the PDF before the caller commits, so a process crash (or a failed
commit) after the write can leave an object nothing refers to. In-process
compensation cannot run in those cases; this does, out of band.

Safety rules:

* a candidate must be older than ``older_than``, so an object belonging to a
  transaction that is still open (written, not yet committed) is never touched;
* the reference check includes soft-deleted certificates, because certificates are
  never hard-deleted and their artifacts must be retained;
* deletion is a separate, explicit step; finding orphans never deletes anything.

An object superseded by a PDF regeneration is also unreferenced and is reported
too. It is deleted only if the operator chooses to apply the result.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.core.object_storage import ObjectStorage, StoredObject
from hms_backend.app.modules.certificates.models import Certificate

CERTIFICATE_KEY_PREFIX = "certificates/"
_QUERY_CHUNK = 500


async def find_unreferenced_artifacts(
    session: AsyncSession,
    storage: ObjectStorage,
    *,
    older_than: timedelta,
    prefix: str = CERTIFICATE_KEY_PREFIX,
    now: datetime | None = None,
) -> list[StoredObject]:
    """Objects under ``prefix`` older than ``older_than`` that no row references."""
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
    return [obj for obj in candidates if obj.key not in referenced]


async def delete_artifacts(
    storage: ObjectStorage, artifacts: Sequence[StoredObject]
) -> int:
    """Delete the given objects. Returns how many deletes succeeded."""
    deleted = 0
    for artifact in artifacts:
        await asyncio.to_thread(storage.delete, artifact.key)
        deleted += 1
    return deleted
