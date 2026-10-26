"""What an asset's service workflow currently is, and what this person may do next.

The persisted states are spread over the asset lifecycle, the retest schedule, bookings,
appointments, reschedule requests, inspections and certificates. This module is the one
place that reads them together, so that every screen (staff now; customer, inspector and
notifications later) shows the same answer instead of each inferring its own.

It is a pure function of already-loaded records. It does no I/O, so the whole decision
table can be tested without a database, and nothing it returns depends on row order:
every "latest" choice is by (timestamp, id).

The next action is navigational and permission-aware: the caller says what the principal
may do (`Capabilities`) and an action is returned only when they may. It is a semantic
target ("INSPECTION", "SCHEDULING"...), never a URL or an API command; each client
maps it to its own routes.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from enum import StrEnum

from hms_backend.app.modules.assets.models import Asset, AssetLifecycleStatus
from hms_backend.app.modules.certificates.models import Certificate, CertificateStatus
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionAppointmentChangeRequest,
    InspectionAppointmentStatus,
    InspectionBooking,
    InspectionBookingStatus,
    InspectionChangeRequestStatus,
    InspectionStatus,
)
from hms_backend.app.modules.inspections.workflow import is_failed
from hms_backend.app.modules.scheduling.models import (
    RetestSchedule,
    RetestScheduleStatus,
)


class WorkflowStatus(StrEnum):
    ASSET_DRAFT = "ASSET_DRAFT"
    CURRENT = "CURRENT"
    DUE = "DUE"
    OVERDUE = "OVERDUE"
    SUSPENDED = "SUSPENDED"
    SCHEDULE_REQUESTED = "SCHEDULE_REQUESTED"
    SCHEDULE_REJECTED = "SCHEDULE_REJECTED"
    SCHEDULED = "SCHEDULED"
    RESCHEDULE_REQUESTED = "RESCHEDULE_REQUESTED"
    RESCHEDULE_AWAITING_CONFIRMATION = "RESCHEDULE_AWAITING_CONFIRMATION"
    INSPECTION_DRAFT = "INSPECTION_DRAFT"
    AWAITING_REVIEW = "AWAITING_REVIEW"
    CHANGES_REQUIRED = "CHANGES_REQUIRED"
    FAILED = "FAILED"
    READY_FOR_CERTIFICATE = "READY_FOR_CERTIFICATE"
    CERTIFIED = "CERTIFIED"
    CANCELLED = "CANCELLED"
    NO_SHOW = "NO_SHOW"
    CONDEMNED = "CONDEMNED"
    RETIRED = "RETIRED"


class ActionCode(StrEnum):
    EDIT_ASSET = "EDIT_ASSET"
    BOOK_INSPECTION = "BOOK_INSPECTION"
    REVIEW_SCHEDULE_REQUEST = "REVIEW_SCHEDULE_REQUEST"
    REVIEW_RESCHEDULE = "REVIEW_RESCHEDULE"
    CONFIRM_RESCHEDULE = "CONFIRM_RESCHEDULE"
    CONTINUE_INSPECTION = "CONTINUE_INSPECTION"
    REVIEW_INSPECTION = "REVIEW_INSPECTION"
    ISSUE_CERTIFICATE = "ISSUE_CERTIFICATE"


class TargetType(StrEnum):
    ASSET = "ASSET"
    SCHEDULING = "SCHEDULING"
    INSPECTION = "INSPECTION"
    CERTIFICATES = "CERTIFICATES"


S = WorkflowStatus

LABELS: dict[WorkflowStatus, str] = {
    S.ASSET_DRAFT: "Asset setup incomplete",
    S.CURRENT: "Current",
    S.DUE: "Inspection due",
    S.OVERDUE: "Inspection overdue",
    S.SUSPENDED: "Inspection schedule suspended",
    S.SCHEDULE_REQUESTED: "Schedule requested",
    S.SCHEDULE_REJECTED: "Schedule request rejected",
    S.SCHEDULED: "Inspection scheduled",
    S.RESCHEDULE_REQUESTED: "Reschedule requested",
    S.RESCHEDULE_AWAITING_CONFIRMATION: "Reschedule awaiting confirmation",
    S.INSPECTION_DRAFT: "Inspection draft",
    S.AWAITING_REVIEW: "Inspection submitted — awaiting approval",
    S.CHANGES_REQUIRED: "Inspection changes required",
    S.FAILED: "Inspection failed",
    S.READY_FOR_CERTIFICATE: "Ready for certificate",
    S.CERTIFIED: "Certified",
    S.CANCELLED: "Inspection cancelled",
    S.NO_SHOW: "No show",
    S.CONDEMNED: "Asset condemned",
    S.RETIRED: "Asset retired",
}

DETAILS: dict[WorkflowStatus, str] = {
    S.ASSET_DRAFT: (
        "The asset record is a draft and cannot be inspected until it is completed."
    ),
    S.CURRENT: "No inspection is due and nothing is in progress.",
    S.DUE: "The next inspection is due and has not been booked.",
    S.OVERDUE: "The inspection is past its due date and has not been booked.",
    S.SUSPENDED: "Retest reminders and escalations are suspended for this asset.",
    S.SCHEDULE_REQUESTED: (
        "An inspection has been requested and is waiting for approval."
    ),
    S.SCHEDULE_REJECTED: (
        "The requested inspection was not approved, so none is booked."
    ),
    S.SCHEDULED: "An inspection visit is confirmed.",
    S.RESCHEDULE_REQUESTED: (
        "A new time has been requested and is waiting for approval."
    ),
    S.RESCHEDULE_AWAITING_CONFIRMATION: (
        "A new time has been proposed and is waiting for the customer to confirm."
    ),
    S.INSPECTION_DRAFT: "An inspection has been started and not yet submitted.",
    S.AWAITING_REVIEW: (
        "The inspection was submitted and is waiting for an authorised reviewer."
    ),
    S.CHANGES_REQUIRED: "The reviewer sent the inspection back for changes.",
    S.FAILED: "The approved inspection recorded a failure.",
    S.READY_FOR_CERTIFICATE: (
        "The inspection is approved and passed; a certificate has not been issued."
    ),
    S.CERTIFIED: "The latest inspection passed and its certificate is issued.",
    S.CANCELLED: "The scheduled inspection was cancelled.",
    S.NO_SHOW: "The inspection visit did not take place.",
    S.CONDEMNED: "The asset has been condemned and is out of service.",
    S.RETIRED: "The asset has been retired.",
}

# The states where something is wrong or missing, not work simply in progress.
ATTENTION: frozenset[WorkflowStatus] = frozenset(
    {
        S.ASSET_DRAFT,
        S.DUE,
        S.OVERDUE,
        S.SCHEDULE_REJECTED,
        S.CHANGES_REQUIRED,
        S.FAILED,
        S.CANCELLED,
        S.NO_SHOW,
    }
)

# Where nothing is booked and the asset still needs an inspection.
_REBOOK = frozenset({S.DUE, S.OVERDUE, S.NO_SHOW, S.CANCELLED, S.SCHEDULE_REJECTED})
_TERMINAL = frozenset({S.CONDEMNED, S.RETIRED, S.ASSET_DRAFT})


@dataclass(frozen=True)
class Capabilities:
    """What the principal may do, computed by the caller from permissions and scope."""

    edit_asset: bool = False
    book_inspection: bool = False
    review_scheduling: bool = False
    confirm_reschedule: bool = False
    write_inspection: bool = False
    approve: bool = False


@dataclass(frozen=True)
class NextAction:
    code: ActionCode
    label: str
    target_type: TargetType
    target_id: str | None = None
    # The inspection a certificate action is about, for clients that can route to it.
    inspection_id: str | None = None


@dataclass(frozen=True)
class Related:
    booking_id: str | None = None
    appointment_id: str | None = None
    inspection_id: str | None = None
    certificate_id: str | None = None


@dataclass(frozen=True)
class Context:
    scheduled_at: datetime | None = None
    due_at: date | None = None
    certificate_number: str | None = None


@dataclass(frozen=True)
class AssetWorkflow:
    status: WorkflowStatus
    label: str
    detail: str
    attention: bool
    related: Related
    context: Context
    next_action: NextAction | None


_EPOCH = datetime.min.replace(tzinfo=UTC)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _inspection_key(inspection: Inspection) -> tuple[datetime, str]:
    """Where the inspection's own cycle began; later review does not move it."""
    return (_aware(inspection.created_at) or _EPOCH, inspection.id)


def _booking_key(booking: InspectionBooking) -> tuple[datetime, str]:
    return (_aware(booking.created_at) or _EPOCH, booking.id)


def _change_key(change: InspectionAppointmentChangeRequest) -> tuple[datetime, str]:
    return (_aware(change.created_at) or _EPOCH, change.id)


def _live_certificates(
    inspection: Inspection, certificates: Iterable[Certificate]
) -> list[Certificate]:
    """Every certificate record the inspection has, whatever its state."""
    return [
        certificate
        for certificate in certificates
        if certificate.inspection_id == inspection.id and certificate.deleted_at is None
    ]


def _issued(certificates: Iterable[Certificate]) -> Certificate | None:
    issued = [
        certificate
        for certificate in certificates
        if certificate.status == CertificateStatus.ISSUED.value
    ]
    return max(
        issued,
        key=lambda certificate: (
            _aware(certificate.issued_at) or _EPOCH,
            certificate.certificate_version,
            certificate.id,
        ),
        default=None,
    )


def _pending_change(
    booking: InspectionBooking,
) -> InspectionAppointmentChangeRequest | None:
    pending = [
        change
        for change in booking.change_requests
        if change.deleted_at is None
        and change.status
        in {
            InspectionChangeRequestStatus.PENDING_ADMIN_APPROVAL.value,
            InspectionChangeRequestStatus.PENDING_CUSTOMER_CONFIRMATION.value,
        }
    ]
    return max(pending, key=_change_key, default=None)


def _lifecycle_status(asset: Asset, schedule: RetestSchedule | None) -> WorkflowStatus:
    """The state when nothing is in flight: suspended, overdue, due or current."""
    schedule_status = (
        schedule.status
        if schedule is not None and schedule.deleted_at is None
        else None
    )
    if schedule_status == RetestScheduleStatus.SUSPENDED.value:
        return S.SUSPENDED
    if (
        asset.lifecycle_status == AssetLifecycleStatus.OVERDUE.value
        or schedule_status == RetestScheduleStatus.OVERDUE.value
    ):
        return S.OVERDUE
    if (
        asset.lifecycle_status == AssetLifecycleStatus.DUE.value
        or schedule_status == RetestScheduleStatus.DUE.value
    ):
        return S.DUE
    return S.CURRENT


@dataclass(frozen=True)
class _Cycle:
    status: WorkflowStatus
    related: Related
    context: Context
    booking: InspectionBooking | None = None
    inspection: Inspection | None = None
    # A finished cycle with nothing left to show or do; the schedule speaks instead.
    settled: bool = False


def _inspection_cycle(
    inspection: Inspection, certificates: list[Certificate]
) -> _Cycle:
    related = Related(booking_id=inspection.booking_id, inspection_id=inspection.id)
    if inspection.status == InspectionStatus.DRAFT.value:
        status = S.INSPECTION_DRAFT
    elif inspection.status == InspectionStatus.SUBMITTED.value:
        status = S.AWAITING_REVIEW
    elif inspection.status == InspectionStatus.REJECTED.value:
        status = S.CHANGES_REQUIRED
    elif is_failed(inspection):
        status = S.FAILED
    else:
        records = _live_certificates(inspection, certificates)
        certificate = _issued(records)
        if certificate is not None:
            return _Cycle(
                S.CERTIFIED,
                Related(
                    booking_id=inspection.booking_id,
                    inspection_id=inspection.id,
                    certificate_id=certificate.id,
                ),
                Context(certificate_number=certificate.number),
                inspection=inspection,
            )
        if records:
            # A revoked, superseded or draft certificate still occupies the inspection
            # (one certificate per inspection), so it can never be "ready" for one.
            # The cycle is closed and the schedule says what the asset needs next.
            return _Cycle(
                S.CURRENT, related, Context(), inspection=inspection, settled=True
            )
        status = S.READY_FOR_CERTIFICATE
    return _Cycle(status, related, Context(), inspection=inspection)


def _booking_cycle(booking: InspectionBooking) -> _Cycle:
    appointment = booking.appointment
    related = Related(
        booking_id=booking.id,
        appointment_id=appointment.id if appointment is not None else None,
    )
    context = Context(scheduled_at=_aware(booking.scheduled_at))
    appointment_status = appointment.status if appointment is not None else None

    if booking.status == InspectionBookingStatus.PENDING_APPROVAL.value:
        status = S.SCHEDULE_REQUESTED
    elif booking.status == InspectionBookingStatus.REJECTED.value:
        status = S.SCHEDULE_REJECTED
    elif booking.status == InspectionBookingStatus.CANCELLED.value:
        status = S.CANCELLED
    elif appointment_status == InspectionAppointmentStatus.NO_SHOW.value:
        status = S.NO_SHOW
    elif appointment_status == InspectionAppointmentStatus.CANCELLED.value:
        status = S.CANCELLED
    else:
        status = S.SCHEDULED
        # A pending change of time outranks the ordinary scheduled state.
        change = _pending_change(booking)
        if change is not None:
            customer_turn = (
                change.status
                == InspectionChangeRequestStatus.PENDING_CUSTOMER_CONFIRMATION.value
            )
            status = (
                S.RESCHEDULE_AWAITING_CONFIRMATION
                if customer_turn
                else S.RESCHEDULE_REQUESTED
            )
    return _Cycle(status, related, context, booking=booking)


def _current_cycle(
    inspections: list[Inspection],
    bookings: list[InspectionBooking],
    certificates: list[Certificate],
) -> _Cycle | None:
    """The newest piece of work: the newest booking's cycle, or a later inspection.

    Cycles are ordered by where they began, never by later activity: an old inspection
    approved after a newer booking was made is still the older cycle. The newest booking
    owns its cycle, and the inspections made from it are that cycle's current
    state. Only an inspection with no booking, begun after the newest booking,
    supersedes it; one belonging to an older booking never does.
    """
    booking = max(bookings, key=_booking_key, default=None)
    if booking is None:
        inspection = max(inspections, key=_inspection_key, default=None)
        return (
            None if inspection is None else _inspection_cycle(inspection, certificates)
        )

    made_from_it = [item for item in inspections if item.booking_id == booking.id]
    begun_after = [
        item
        for item in inspections
        if item.booking_id is None and _inspection_key(item) >= _booking_key(booking)
    ]
    inspection = max(made_from_it + begun_after, key=_inspection_key, default=None)
    if inspection is not None:
        return _inspection_cycle(inspection, certificates)
    return _booking_cycle(booking)


def _next_action(
    status: WorkflowStatus,
    asset: Asset,
    cycle: _Cycle | None,
    can: Capabilities,
) -> NextAction | None:
    inspection_id = cycle.inspection.id if cycle and cycle.inspection else None
    booking_id = cycle.related.booking_id if cycle else None

    if status == S.ASSET_DRAFT and can.edit_asset:
        return NextAction(
            ActionCode.EDIT_ASSET, "Complete asset setup", TargetType.ASSET, asset.id
        )
    if status in _REBOOK and can.book_inspection:
        return NextAction(
            ActionCode.BOOK_INSPECTION, "Book inspection", TargetType.SCHEDULING
        )
    if status == S.SCHEDULE_REQUESTED and can.review_scheduling:
        return NextAction(
            ActionCode.REVIEW_SCHEDULE_REQUEST,
            "Review schedule request",
            TargetType.SCHEDULING,
            booking_id,
        )
    if status == S.RESCHEDULE_REQUESTED and can.review_scheduling:
        return NextAction(
            ActionCode.REVIEW_RESCHEDULE,
            "Review reschedule request",
            TargetType.SCHEDULING,
            booking_id,
        )
    if status == S.RESCHEDULE_AWAITING_CONFIRMATION and can.confirm_reschedule:
        return NextAction(
            ActionCode.CONFIRM_RESCHEDULE,
            "Confirm new time",
            TargetType.SCHEDULING,
            booking_id,
        )
    if status == S.INSPECTION_DRAFT and can.write_inspection:
        return NextAction(
            ActionCode.CONTINUE_INSPECTION,
            "Continue inspection",
            TargetType.INSPECTION,
            inspection_id,
        )
    if status == S.AWAITING_REVIEW and can.approve:
        return NextAction(
            ActionCode.REVIEW_INSPECTION,
            "Review inspection",
            TargetType.INSPECTION,
            inspection_id,
        )
    # CHANGES_REQUIRED has no action yet: a rejected inspection cannot be edited, so
    # offering to open it would lead nowhere. The lifecycle work that adds a rework
    # step adds it.
    if status == S.READY_FOR_CERTIFICATE and can.approve:
        return NextAction(
            ActionCode.ISSUE_CERTIFICATE,
            "Issue certificate",
            TargetType.CERTIFICATES,
            None,
            inspection_id=inspection_id,
        )
    return None


def resolve_asset_workflow(
    asset: Asset,
    *,
    retest_schedule: RetestSchedule | None,
    bookings: Iterable[InspectionBooking],
    inspections: Iterable[Inspection],
    certificates: Iterable[Certificate],
    capabilities: Capabilities,
) -> AssetWorkflow:
    """The asset's workflow state and, if the principal may act on it, the next step.

    Order of precedence: a terminal asset state, an unfinished asset record, the
    current cycle (the newest booking or inspection), and only then the retest
    schedule. A certificate from an earlier cycle never outranks a due or overdue
    schedule.
    """
    live_inspections = [item for item in inspections if item.deleted_at is None]
    live_bookings = [item for item in bookings if item.deleted_at is None]
    certificate_list = list(certificates)
    due_at = asset.next_retest_due_at
    if retest_schedule is not None and retest_schedule.deleted_at is None:
        due_at = retest_schedule.due_at

    cycle: _Cycle | None = None
    if asset.lifecycle_status == AssetLifecycleStatus.CONDEMNED.value:
        status = S.CONDEMNED
    elif asset.lifecycle_status == AssetLifecycleStatus.RETIRED.value:
        status = S.RETIRED
    elif asset.lifecycle_status == AssetLifecycleStatus.DRAFT.value:
        status = S.ASSET_DRAFT
    else:
        cycle = _current_cycle(live_inspections, live_bookings, certificate_list)
        lifecycle = _lifecycle_status(asset, retest_schedule)
        if cycle is None or cycle.settled:
            status = lifecycle
            cycle = None
        elif cycle.status == S.CERTIFIED and lifecycle != S.CURRENT:
            # That certificate closed an earlier cycle; the schedule says the next
            # one is due.
            status = lifecycle
            cycle = None
        else:
            status = cycle.status

    related = cycle.related if cycle is not None else Related()
    context = cycle.context if cycle is not None else Context()
    return AssetWorkflow(
        status=status,
        label=LABELS[status],
        detail=DETAILS[status],
        attention=status in ATTENTION,
        related=related,
        context=Context(
            scheduled_at=context.scheduled_at,
            due_at=None if status in _TERMINAL else due_at,
            certificate_number=context.certificate_number,
        ),
        next_action=_next_action(status, asset, cycle, capabilities),
    )
