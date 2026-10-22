"""Transitions of an inspection that more than one entry point performs.

Submitting for review is done by the staff API and by the offline inspector's sync
push. Both go through here so the audit event, the status change, the reviewer
notification and the completeness check cannot drift apart.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.core.config import settings
from hms_backend.app.core.repository import record_update
from hms_backend.app.models.base import utc_now
from hms_backend.app.modules.inspections.measurements import missing_for_submission
from hms_backend.app.modules.inspections.models import Inspection, InspectionStatus
from hms_backend.app.modules.notifications.enums import NotificationCategory
from hms_backend.app.modules.notifications.outbox import emit_event


def submission_gaps(inspection: Inspection) -> list[str]:
    """What the inspection's recorded form still lacks before it can be submitted."""
    pressure_test = inspection.pressure_test
    if pressure_test is None:
        return []
    return missing_for_submission(
        pressure_test.measurements,
        inspection.result,
        hold_time_seconds=pressure_test.hold_time_seconds,
    )


def is_failed(inspection: Inspection) -> bool:
    """Whether the hose failed: a failed certificate result, or a legacy FAIL result.

    On the customer's form the instruction is Pass or Repair and the failure is the
    certificate result, so the result column alone no longer says it. Inspections
    saved before the form carry only the result.
    """
    pressure_test = inspection.pressure_test
    certificate_result = (
        (pressure_test.measurements or {}).get("certificate_result")
        if pressure_test is not None
        else None
    )
    if certificate_result is not None:
        return bool(certificate_result == "FAIL")
    return (inspection.result or "").upper() in {"FAIL", "FAILED"}


async def mark_submitted(
    session: AsyncSession, inspection: Inspection, *, actor_id: str
) -> None:
    """Move a draft to ``SUBMITTED``, audited, and tell the reviewers."""
    before = inspection.to_audit_dict()
    inspection.status = InspectionStatus.SUBMITTED.value
    inspection.submitted_at = utc_now()
    await record_update(
        session,
        inspection,
        actor_id=actor_id,
        action="inspection.submitted",
        before=before,
    )
    await emit_event(
        session,
        category=NotificationCategory.INSPECTION_SUBMITTED,
        aggregate_type="inspection",
        aggregate_id=inspection.id,
        payload={
            "inspection_id": inspection.id,
            "asset_id": inspection.asset.id,
            "asset_number": inspection.asset.asset_number,
            "customer_id": inspection.asset.customer_id,
            "reviewer_user_id": inspection.reviewer_user_id,
            "link": settings.public_base_url.rstrip("/"),
        },
    )
