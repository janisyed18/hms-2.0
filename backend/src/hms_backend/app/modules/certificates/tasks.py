"""Celery tasks for certificate generation.

The bulk task processes each inspection in its own transaction so one failure
never rolls back the others, and records a per-item outcome on the batch job. It
reuses :func:`generate_and_store_certificate`, so a bulk-generated certificate is
byte-for-byte identical to an interactively issued one.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from hms_backend.app.core.celery_app import celery_app
from hms_backend.app.core.config import settings
from hms_backend.app.modules.certificates.issuance import (
    generate_and_store_certificate,
)
from hms_backend.app.modules.inspections.models import Inspection
from hms_backend.app.modules.jobs.models import CertificateBatchJob, JobStatus

logger = logging.getLogger("hms_backend.certificates.tasks")


async def _run_batch(
    job_id: str,
    session_factory: async_sessionmaker[AsyncSession] | None = None,
) -> dict[str, Any]:
    engine = None
    if session_factory is None:
        engine = create_async_engine(settings.database_url)
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with session_factory() as session:
            job = await session.get(CertificateBatchJob, job_id)
            if job is None:
                logger.warning("batch job %s not found", job_id)
                return {"status": "missing"}
            job.status = JobStatus.RUNNING.value
            job.started_at = datetime.now(UTC)
            await session.commit()
            inspection_ids = list(job.inspection_ids)
            actor_id = job.requested_by_user_id

        results: list[dict[str, Any]] = []
        succeeded = 0
        failed = 0
        for inspection_id in inspection_ids:
            outcome = await _process_one(session_factory, inspection_id, actor_id)
            results.append(outcome)
            if outcome["status"] == "issued":
                succeeded += 1
            else:
                failed += 1

        async with session_factory() as session:
            job = await session.get(CertificateBatchJob, job_id)
            if job is not None:
                job.succeeded = succeeded
                job.failed = failed
                job.results = results
                job.finished_at = datetime.now(UTC)
                job.status = _final_status(succeeded, failed)
                await session.commit()
        return {"succeeded": succeeded, "failed": failed}
    finally:
        if engine is not None:
            await engine.dispose()


async def _process_one(
    session_factory: async_sessionmaker[AsyncSession],
    inspection_id: str,
    actor_id: str,
) -> dict[str, Any]:
    async with session_factory() as session:
        try:
            inspection = await session.get(Inspection, inspection_id)
            if inspection is None:
                return {
                    "inspection_id": inspection_id,
                    "status": "failed",
                    "error": "inspection not found",
                }
            certificate = await generate_and_store_certificate(
                session, inspection, actor_id=actor_id
            )
            await session.commit()
            return {
                "inspection_id": inspection_id,
                "status": "issued",
                "certificate_id": certificate.id,
                "certificate_number": certificate.number,
            }
        except Exception as exc:  # noqa: BLE001 - one item must not fail the batch
            await session.rollback()
            logger.warning(
                "bulk certificate failed for inspection %s: %s", inspection_id, exc
            )
            return {
                "inspection_id": inspection_id,
                "status": "failed",
                "error": str(exc),
            }


def _final_status(succeeded: int, failed: int) -> str:
    if failed == 0:
        return JobStatus.COMPLETED.value
    if succeeded == 0:
        return JobStatus.FAILED.value
    return JobStatus.COMPLETED_WITH_ERRORS.value


@celery_app.task(bind=True, name="certificates.generate_batch")  # type: ignore[untyped-decorator]
def generate_certificate_batch(self: object, job_id: str) -> dict[str, Any]:
    return asyncio.run(_run_batch(job_id))
