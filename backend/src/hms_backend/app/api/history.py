"""Read-only access to the historical archive of deleted customers (Super Admin)."""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime, time, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.lifecycle import require_super_admin
from hms_backend.app.core.object_storage import (
    HistoryStorageError,
    HistoryStorageUnavailable,
    ObjectNotFoundError,
    describe_evidence,
    get_evidence,
    get_history_storage,
)
from hms_backend.app.core.rbac import Principal
from hms_backend.app.modules.history.models import (
    CustomerDeletionBatch,
    HistoryEvidenceObject,
    HistoryRecord,
    HistoryRelationship,
)
from hms_backend.app.modules.history.service import (
    LABELS,
    OWNED_TABLES,
    sha256_hex,
    verify_batch_in_session,
)

logger = logging.getLogger(__name__)

router = APIRouter()

SessionDep = Annotated[AsyncSession, Depends(get_session)]
PrincipalDep = Annotated[Principal, Depends(get_current_principal)]
LimitParam = Annotated[int, Query(ge=1, le=200)]
OffsetParam = Annotated[int, Query(ge=0)]

_LABEL_FIELDS = ("name", "number", "asset_number", "tag", "code", "caption", "id")


def batch_summary(
    batch: CustomerDeletionBatch, *, replayed: bool = False
) -> dict[str, Any]:
    counts = batch.record_counts or {}
    earlier = batch.previously_deleted_counts or {}
    return {
        "id": batch.id,
        "deletion_number": batch.deletion_number,
        "status": batch.status,
        "customer_id": batch.customer_id,
        "customer_code": batch.customer_code,
        "customer_name": batch.customer_name,
        "actor_id": batch.actor_id,
        "actor_name": batch.actor_name,
        "reason": batch.reason,
        "deleted_at": batch.created_at,
        "total_records": batch.total_records,
        "record_counts": [
            {
                "kind": name,
                "label": LABELS[name],
                "count": counts[name],
                "previously_deleted": earlier.get(name, 0),
            }
            for name in OWNED_TABLES
            if name in counts and name != "customers"
        ],
        "evidence_files": batch.evidence_files,
        "evidence_bytes": batch.evidence_bytes,
        "manifest_sha256": batch.manifest_sha256,
        "retention_until": batch.retention_until,
        "retention_basis": batch.retention_basis,
        "failure_detail": batch.failure_detail,
        "replayed": replayed,
    }


async def _batch_or_404(session: AsyncSession, batch_id: str) -> CustomerDeletionBatch:
    batch = await session.get(CustomerDeletionBatch, batch_id)
    if batch is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Deletion record not found")
    return batch


@router.get("/customer-deletions")
async def list_customer_deletions(
    session: SessionDep,
    principal: PrincipalDep,
    q: Annotated[str | None, Query(max_length=120)] = None,
    from_date: date | None = None,
    to_date: date | None = None,
    status_filter: Annotated[
        str, Query(alias="status", pattern="^(COMPLETED|FAILED)$")
    ] = ("COMPLETED"),
    limit: LimitParam = 25,
    offset: OffsetParam = 0,
) -> dict[str, Any]:
    require_super_admin(principal, "view deleted customers")
    conditions = [CustomerDeletionBatch.status == status_filter]
    if q and q.strip():
        pattern = f"%{q.strip().lower()}%"
        conditions.append(
            or_(
                func.lower(CustomerDeletionBatch.customer_name).like(pattern),
                func.lower(CustomerDeletionBatch.customer_code).like(pattern),
                func.lower(CustomerDeletionBatch.deletion_number).like(pattern),
            )
        )
    if from_date:
        conditions.append(
            CustomerDeletionBatch.created_at
            >= datetime.combine(from_date, time.min, tzinfo=UTC)
        )
    if to_date:
        conditions.append(
            CustomerDeletionBatch.created_at
            < datetime.combine(to_date + timedelta(days=1), time.min, tzinfo=UTC)
        )
    total = await session.scalar(
        select(func.count()).select_from(CustomerDeletionBatch).where(*conditions)
    )
    rows = (
        await session.scalars(
            select(CustomerDeletionBatch)
            .where(*conditions)
            .order_by(CustomerDeletionBatch.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
    ).all()
    return {
        "items": [batch_summary(row) for row in rows],
        "total": int(total or 0),
        "limit": limit,
        "offset": offset,
    }


@router.get("/customer-deletions/{batch_id}")
async def get_customer_deletion(
    batch_id: str, session: SessionDep, principal: PrincipalDep
) -> dict[str, Any]:
    require_super_admin(principal, "view deleted customers")
    batch = await _batch_or_404(session, batch_id)
    evidence = (
        await session.scalars(
            select(HistoryEvidenceObject)
            .where(HistoryEvidenceObject.batch_id == batch.id)
            .order_by(HistoryEvidenceObject.kind, HistoryEvidenceObject.label)
        )
    ).all()
    return {
        **batch_summary(batch),
        "evidence": [
            {
                "id": item.id,
                "kind": item.kind,
                "label": item.label,
                "record_type": item.record_type,
                "original_id": item.original_id,
                "content_type": item.content_type,
                "size_bytes": item.size_bytes,
                "sha256": item.sha256,
            }
            for item in evidence
        ],
    }


@router.get("/customer-deletions/{batch_id}/records")
async def list_customer_deletion_records(
    batch_id: str,
    session: SessionDep,
    principal: PrincipalDep,
    record_type: Annotated[str | None, Query(max_length=80)] = None,
    limit: LimitParam = 50,
    offset: OffsetParam = 0,
) -> dict[str, Any]:
    require_super_admin(principal, "view deleted customers")
    batch = await _batch_or_404(session, batch_id)
    conditions = [HistoryRecord.batch_id == batch.id]
    if record_type:
        conditions.append(HistoryRecord.record_type == record_type)
    total = await session.scalar(
        select(func.count()).select_from(HistoryRecord).where(*conditions)
    )
    rows = (
        await session.scalars(
            select(HistoryRecord)
            .where(*conditions)
            .order_by(HistoryRecord.ordinal)
            .limit(limit)
            .offset(offset)
        )
    ).all()
    return {
        "items": [
            {
                "id": row.id,
                "record_type": row.record_type,
                "type_label": LABELS.get(row.record_type, row.record_type),
                "original_id": row.original_id,
                "label": next(
                    (
                        str(row.payload[field])
                        for field in _LABEL_FIELDS
                        if row.payload.get(field)
                    ),
                    row.original_id,
                ),
                "previously_deleted": row.payload.get("deleted_at") is not None,
                "deleted_at_origin": row.payload.get("deleted_at"),
                "original_version": row.original_version,
                "schema_version": row.schema_version,
                "payload": row.payload,
                "payload_sha256": row.payload_sha256,
            }
            for row in rows
        ],
        "total": int(total or 0),
        "limit": limit,
        "offset": offset,
    }


@router.get("/customer-deletions/{batch_id}/relationships")
async def list_customer_deletion_relationships(
    batch_id: str,
    session: SessionDep,
    principal: PrincipalDep,
    limit: LimitParam = 200,
    offset: OffsetParam = 0,
) -> dict[str, Any]:
    require_super_admin(principal, "view deleted customers")
    batch = await _batch_or_404(session, batch_id)
    rows = (
        await session.scalars(
            select(HistoryRelationship)
            .where(HistoryRelationship.batch_id == batch.id)
            .order_by(HistoryRelationship.child_type, HistoryRelationship.child_id)
            .limit(limit)
            .offset(offset)
        )
    ).all()
    return {
        "items": [
            {
                "child_type": row.child_type,
                "child_id": row.child_id,
                "fk_column": row.fk_column,
                "parent_type": row.parent_type,
                "parent_id": row.parent_id,
                "parent_retained": row.parent_retained,
            }
            for row in rows
        ]
    }


@router.get("/customer-deletions/{batch_id}/evidence/{evidence_id}/download")
async def download_customer_deletion_evidence(
    batch_id: str,
    evidence_id: str,
    session: SessionDep,
    principal: PrincipalDep,
) -> Response:
    require_super_admin(principal, "view deleted customers")
    item = await session.get(HistoryEvidenceObject, evidence_id)
    if item is None or item.batch_id != batch_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Evidence not found")
    try:
        data = get_evidence(
            get_history_storage(), item.history_key, item.history_version_id
        )
    except HistoryStorageUnavailable as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Archived files are unavailable: history storage is not configured.",
        ) from exc
    except (ObjectNotFoundError, HistoryStorageError) as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "The archived file is not available."
        ) from exc
    if sha256_hex(data) != item.sha256:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "The archived file failed its integrity check and was not served.",
        )
    extension = ".pdf" if item.content_type == "application/pdf" else ""
    safe = "".join(c for c in item.label if c.isalnum() or c in "-_.") or "evidence"
    return Response(
        content=data,
        media_type=item.content_type,
        headers={
            "Content-Disposition": f'attachment; filename="{safe}{extension}"',
            "Cache-Control": "no-store",
            "X-Content-SHA256": item.sha256,
        },
    )


@router.get("/customer-deletions/{batch_id}/integrity")
async def check_customer_deletion_integrity(
    batch_id: str, session: SessionDep, principal: PrincipalDep
) -> dict[str, Any]:
    """Re-hash the stored snapshots and archived files and compare to the manifest."""
    require_super_admin(principal, "view deleted customers")
    batch = await _batch_or_404(session, batch_id)
    problems: list[str] = []
    try:
        await verify_batch_in_session(session, batch)
    except Exception as exc:
        problems.append(str(exc))
    try:
        storage = get_history_storage()
    except HistoryStorageUnavailable as exc:
        problems.append(str(exc))
        return {
            "batch_id": batch.id,
            "verified": False,
            "records_checked": batch.total_records + 1,
            "evidence_checked": 0,
            "problems": problems,
        }
    evidence = (
        await session.scalars(
            select(HistoryEvidenceObject).where(
                HistoryEvidenceObject.batch_id == batch.id
            )
        )
    ).all()
    for item in evidence:
        try:
            data = get_evidence(storage, item.history_key, item.history_version_id)
            if sha256_hex(data) != item.sha256:
                problems.append(f"{item.label}: archived file hash differs")
            now = describe_evidence(storage, item.history_key, item.history_version_id)
        except ObjectNotFoundError:
            problems.append(f"{item.label}: archived file version is missing")
            continue
        except HistoryStorageError as exc:
            problems.append(f"{item.label}: {exc}")
            continue
        except Exception as exc:  # S3 permission or timeout: report, never succeed
            logger.warning(
                "history integrity read failed", extra={"error": type(exc).__name__}
            )
            problems.append(
                f"{item.label}: the archived file could not be read "
                f"({type(exc).__name__})"
            )
            continue
        recorded = item.retain_until
        if recorded is not None and recorded.tzinfo is None:
            recorded = recorded.replace(tzinfo=UTC)  # SQLite test databases
        if now is not None and (
            now.retention_mode is None
            or now.retain_until is None
            or (recorded is not None and now.retain_until < recorded)
        ):
            problems.append(f"{item.label}: retention is no longer applied")
    return {
        "batch_id": batch.id,
        "verified": not problems,
        "records_checked": batch.total_records + 1,
        "evidence_checked": len(evidence),
        "problems": problems,
    }
