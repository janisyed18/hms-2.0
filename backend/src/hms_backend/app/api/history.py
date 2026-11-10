"""Read-only access to the historical archive of deleted customers (Super Admin)."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.lifecycle import require_super_admin
from hms_backend.app.core.object_storage import ObjectNotFoundError, get_object_storage
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
            {"kind": name, "label": LABELS[name], "count": counts[name]}
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
            >= datetime.combine(from_date, time.min).astimezone()
        )
    if to_date:
        conditions.append(
            CustomerDeletionBatch.created_at
            < datetime.combine(to_date + timedelta(days=1), time.min).astimezone()
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
        data = get_object_storage().get(item.history_key)
    except ObjectNotFoundError as exc:
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
    storage = get_object_storage()
    evidence = (
        await session.scalars(
            select(HistoryEvidenceObject).where(
                HistoryEvidenceObject.batch_id == batch.id
            )
        )
    ).all()
    for item in evidence:
        try:
            if sha256_hex(storage.get(item.history_key)) != item.sha256:
                problems.append(f"{item.label}: archived file hash differs")
        except ObjectNotFoundError:
            problems.append(f"{item.label}: archived file is missing")
    return {
        "batch_id": batch.id,
        "verified": not problems,
        "records_checked": batch.total_records + 1,
        "evidence_checked": len(evidence),
        "problems": problems,
    }
