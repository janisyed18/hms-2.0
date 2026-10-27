"""The inspection lifecycle: every state change, in one place.

    DRAFT -> IN_PROGRESS -> SUBMITTED -> APPROVED
                 ^              |
                 |              v
                 +---------- REJECTED        (rework: an explicit step back)

Rejection never makes a record editable by itself; the person doing the work begins
rework, which is its own audited transition. The staff API and the offline inspector's
sync push both go through here so the guard, the audit event, the status change and
the notification cannot drift apart.

The offline path predates IN_PROGRESS: a deployed inspector submits straight from the
draft it created. ``start_and_submit`` keeps that working as an atomic start + submit
(same completeness checks, both transitions audited) until the inspector app has a
lifecycle of its own.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.core.config import settings
from hms_backend.app.core.repository import record_update
from hms_backend.app.models.base import utc_now
from hms_backend.app.modules.inspections.measurements import (
    PRESSURE_TEST_MISSING,
    missing_for_submission,
)
from hms_backend.app.modules.inspections.models import Inspection, InspectionStatus
from hms_backend.app.modules.notifications.enums import NotificationCategory
from hms_backend.app.modules.notifications.outbox import emit_event


def submission_gaps(inspection: Inspection) -> list[str]:
    """What the inspection's recorded form still lacks before it can be submitted."""
    pressure_test = inspection.pressure_test
    if pressure_test is None:
        # Nothing recorded is not the same as nothing missing. Older inspections that
        # carry a pressure test in the earlier format still submit; none at all cannot.
        return [PRESSURE_TEST_MISSING]
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


class InvalidTransitionError(Exception):
    """The inspection is not in a state that allows this step. The API answers 409."""


# action -> (states it may start from, state it ends in)
TRANSITIONS: dict[str, tuple[frozenset[InspectionStatus], InspectionStatus]] = {
    "start": (frozenset({InspectionStatus.DRAFT}), InspectionStatus.IN_PROGRESS),
    "submit": (frozenset({InspectionStatus.IN_PROGRESS}), InspectionStatus.SUBMITTED),
    "approve": (frozenset({InspectionStatus.SUBMITTED}), InspectionStatus.APPROVED),
    "reject": (frozenset({InspectionStatus.SUBMITTED}), InspectionStatus.REJECTED),
    "rework": (frozenset({InspectionStatus.REJECTED}), InspectionStatus.IN_PROGRESS),
}

_REFUSALS: dict[str, str] = {
    "start": "Only a draft inspection can be started",
    "submit": "Only an inspection in progress can be submitted",
    "approve": "Inspection must be submitted before approval",
    "reject": "Inspection must be submitted before rejection",
    "rework": "Only an inspection that needs changes can be reworked",
}


def require_transition(inspection: Inspection, action: str) -> InspectionStatus:
    """The state ``action`` leads to; InvalidTransitionError if not allowed now."""
    sources, target = TRANSITIONS[action]
    if inspection.status not in {state.value for state in sources}:
        raise InvalidTransitionError(_REFUSALS[action])
    return target


def is_editable(inspection: Inspection) -> bool:
    """Form content can change only while work is in progress."""
    return inspection.status == InspectionStatus.IN_PROGRESS.value


async def start(
    session: AsyncSession, inspection: Inspection, *, actor_id: str
) -> None:
    """DRAFT -> IN_PROGRESS. ``started_at`` is set here, once."""
    target = require_transition(inspection, "start")
    before = inspection.to_audit_dict()
    inspection.status = target.value
    if inspection.started_at is None:
        inspection.started_at = utc_now()
    await record_update(
        session,
        inspection,
        actor_id=actor_id,
        action="inspection.started",
        before=before,
    )


async def begin_rework(
    session: AsyncSession, inspection: Inspection, *, actor_id: str
) -> None:
    """REJECTED -> IN_PROGRESS, explicitly.

    The round's timestamps and the previous reviewer are cleared, so the record does
    not name someone who has not reviewed the next submission; the audit event keeps
    them (it records the row as it was), as does every earlier event. The rejection
    reason stays as the active rework guidance until the inspection is resubmitted.
    ``started_at`` is untouched.
    """
    target = require_transition(inspection, "rework")
    before = inspection.to_audit_dict()
    inspection.status = target.value
    inspection.submitted_at = None
    inspection.rejected_at = None
    inspection.reviewer_user_id = None
    await record_update(
        session,
        inspection,
        actor_id=actor_id,
        action="inspection.rework_started",
        before=before,
    )


async def mark_approved(
    session: AsyncSession,
    inspection: Inspection,
    *,
    actor_id: str,
    reviewer_user_id: str | None,
) -> None:
    """SUBMITTED -> APPROVED, with the approving reviewer recorded."""
    target = require_transition(inspection, "approve")
    before = inspection.to_audit_dict()
    inspection.status = target.value
    inspection.reviewer_user_id = reviewer_user_id
    inspection.approved_at = utc_now()
    await record_update(
        session,
        inspection,
        actor_id=actor_id,
        action="inspection.approved",
        before=before,
    )


async def mark_rejected(
    session: AsyncSession,
    inspection: Inspection,
    *,
    actor_id: str,
    reviewer_user_id: str,
    reason: str,
) -> None:
    """SUBMITTED -> REJECTED, with the reviewer's reason kept on the record."""
    target = require_transition(inspection, "reject")
    before = inspection.to_audit_dict()
    inspection.status = target.value
    inspection.reviewer_user_id = reviewer_user_id
    inspection.rejected_at = utc_now()
    inspection.rejection_reason = reason
    await record_update(
        session,
        inspection,
        actor_id=actor_id,
        action="inspection.rejected",
        before=before,
    )


async def start_and_submit(
    session: AsyncSession, inspection: Inspection, *, actor_id: str
) -> None:
    """The offline inspector's submit, which has no start: both steps, atomically.

    A draft is started (so ``started_at`` and the audit trail are real) and then
    submitted;
    an inspection already in progress is just submitted. Anything else is refused.
    """
    if inspection.status == InspectionStatus.DRAFT.value:
        await start(session, inspection, actor_id=actor_id)
    await mark_submitted(session, inspection, actor_id=actor_id)


async def mark_submitted(
    session: AsyncSession, inspection: Inspection, *, actor_id: str
) -> None:
    """IN_PROGRESS -> SUBMITTED, audited, and tell the reviewers."""
    target = require_transition(inspection, "submit")
    before = inspection.to_audit_dict()
    inspection.status = target.value
    inspection.submitted_at = utc_now()
    # The rework guidance has done its job; the audit trail keeps the reason.
    inspection.rejection_reason = None
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
