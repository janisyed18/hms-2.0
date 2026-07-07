"""Bulk certificate generation jobs.

Enqueue a batch of approved inspections for certificate generation and poll its
progress. Generation runs as a tracked Celery job; each certificate is produced
by the same engine + signing pipeline as an interactive issue.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Select
from starlette.concurrency import run_in_threadpool

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.api.schemas import (
    BulkCertificateGenerateRequest,
    CertificateBatchJobListResponse,
    CertificateBatchJobRead,
)
from hms_backend.app.core.config import settings
from hms_backend.app.core.rbac import (
    Permission,
    Principal,
    is_customer_scoped,
    require_permission,
)
from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.certificates.models import Certificate
from hms_backend.app.modules.certificates.tasks import generate_certificate_batch
from hms_backend.app.modules.inspections.models import Inspection, InspectionStatus
from hms_backend.app.modules.jobs.models import CertificateBatchJob, JobStatus

router = APIRouter(tags=["certificate-jobs"])

__all__ = ["generate_certificate_batch", "router"]

SessionDep = Annotated[AsyncSession, Depends(get_session)]
PrincipalDep = Annotated[Principal, Depends(get_current_principal)]
LimitParam = Annotated[int, Query(ge=1, le=100)]
OffsetParam = Annotated[int, Query(ge=0)]


def _require_certificate_approve(principal: Principal) -> None:
    try:
        require_permission(principal, Permission.CERTIFICATE_APPROVE)
    except PermissionError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc


def _scope_inspections(
    statement: Select[tuple[str]],
    principal: Principal,
) -> Select[tuple[str]]:
    if not is_customer_scoped(principal):
        return statement
    if not principal.customer_ids:
        return statement.where(Asset.customer_id.in_([]))
    return statement.where(Asset.customer_id.in_(principal.customer_ids))


async def _eligible_inspection_ids(
    session: AsyncSession,
    principal: Principal,
) -> list[str]:
    statement = (
        select(Inspection.id)
        .join(Asset, Asset.id == Inspection.asset_id)
        .outerjoin(Certificate, Certificate.inspection_id == Inspection.id)
        .where(
            Inspection.status == InspectionStatus.APPROVED.value,
            Inspection.deleted_at.is_(None),
            Certificate.id.is_(None),
        )
        .order_by(Inspection.id)
    )
    statement = _scope_inspections(statement, principal)
    return list((await session.scalars(statement)).all())


@router.post(
    "/certificates/bulk-generate",
    response_model=CertificateBatchJobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def bulk_generate_certificates(
    payload: BulkCertificateGenerateRequest,
    session: SessionDep,
    principal: PrincipalDep,
) -> CertificateBatchJobRead:
    _require_certificate_approve(principal)

    if payload.inspection_ids:
        # De-duplicate while preserving order.
        inspection_ids = list(dict.fromkeys(payload.inspection_ids))
    else:
        inspection_ids = await _eligible_inspection_ids(session, principal)

    if not inspection_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No inspections to generate certificates for",
        )
    if len(inspection_ids) > settings.bulk_certificate_max_items:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Too many inspections ({len(inspection_ids)}); "
                f"maximum is {settings.bulk_certificate_max_items}"
            ),
        )

    job = CertificateBatchJob(
        status=JobStatus.PENDING.value,
        requested_by_user_id=principal.user_id,
        total=len(inspection_ids),
        inspection_ids=inspection_ids,
        results=[],
    )
    session.add(job)
    await session.commit()

    # Dispatch off the event loop so eager execution (tests / brokerless local)
    # does not call asyncio.run inside the running loop.
    async_result = await run_in_threadpool(generate_certificate_batch.delay, job.id)

    job.task_id = getattr(async_result, "id", None)
    await session.commit()
    await session.refresh(job)
    return _job_read(job)


@router.get(
    "/jobs/certificate-batches/{job_id}",
    response_model=CertificateBatchJobRead,
)
async def get_batch_job(
    job_id: str,
    session: SessionDep,
    principal: PrincipalDep,
) -> CertificateBatchJobRead:
    _require_certificate_approve(principal)
    job = await session.get(CertificateBatchJob, job_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Batch job not found",
        )
    return _job_read(job)


@router.get(
    "/jobs/certificate-batches",
    response_model=CertificateBatchJobListResponse,
)
async def list_batch_jobs(
    session: SessionDep,
    principal: PrincipalDep,
    limit: LimitParam = 20,
    offset: OffsetParam = 0,
) -> CertificateBatchJobListResponse:
    _require_certificate_approve(principal)
    total = (
        await session.scalar(select(func.count()).select_from(CertificateBatchJob))
    ) or 0
    jobs = (
        await session.scalars(
            select(CertificateBatchJob)
            .order_by(CertificateBatchJob.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
    ).all()
    return CertificateBatchJobListResponse(
        total=total,
        limit=limit,
        offset=offset,
        items=[_job_read(job) for job in jobs],
    )


def _job_read(job: CertificateBatchJob) -> CertificateBatchJobRead:
    return CertificateBatchJobRead(
        id=job.id,
        status=job.status,
        requested_by_user_id=job.requested_by_user_id,
        task_id=job.task_id,
        total=job.total,
        succeeded=job.succeeded,
        failed=job.failed,
        results=job.results,
        error=job.error,
        created_at=job.created_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
    )
