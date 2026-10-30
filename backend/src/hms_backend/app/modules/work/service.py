"""The bounded, backend-owned My Work projection.

The asset workflow resolver remains the authority for state and next action. This module
only batches visible records, invokes that resolver, and presents its semantic result.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import false, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy.sql import Select

from hms_backend.app.core.inspector_access import (
    assigned_assets,
    assigned_bookings,
    is_inspector_scoped,
)
from hms_backend.app.core.rbac import (
    Permission,
    Principal,
    has_permission,
    is_customer_scoped,
)
from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.assets.workflow import (
    AssetWorkflow,
    Capabilities,
    WorkflowStatus,
    resolve_asset_workflow,
)
from hms_backend.app.modules.certificates.models import Certificate
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionBooking,
    InspectionBookingAsset,
)

MAX_SOURCE_ASSETS = 500


@dataclass(frozen=True)
class WorkAction:
    code: str
    label: str
    target_type: str
    target_id: str | None
    inspection_id: str | None


@dataclass(frozen=True)
class WorkItem:
    id: str
    kind: str
    state: str
    priority: str
    title: str
    summary: str
    customer_id: str
    customer_name: str
    asset_id: str
    asset_number: str
    asset_name: str | None
    inspection_id: str | None
    booking_id: str | None
    certificate_id: str | None
    due_at: datetime | None
    updated_at: datetime
    next_action: WorkAction


@dataclass(frozen=True)
class MyWork:
    items: list[WorkItem]
    total: int
    urgent: int
    due_soon: int
    normal: int
    source_limit: int
    source_limited: bool


def _capabilities(principal: Principal) -> Capabilities:
    customer_scoped = is_customer_scoped(principal)
    can_book = has_permission(principal, Permission.INSPECTION_BOOK)
    return Capabilities(
        edit_asset=has_permission(principal, Permission.ASSET_WRITE),
        book_inspection=can_book,
        review_scheduling=can_book and not customer_scoped,
        confirm_reschedule=can_book and customer_scoped,
        write_inspection=has_permission(principal, Permission.INSPECTION_WRITE),
        approve=has_permission(principal, Permission.CERTIFICATE_APPROVE),
    )


def _asset_scope(
    statement: Select[tuple[Asset]], principal: Principal
) -> Select[tuple[Asset]]:
    # Kept here rather than calling an HTTP endpoint per asset: one scoped query is
    # both the permission boundary and the batching boundary for the projection.
    if is_inspector_scoped(principal):
        return statement.where(Asset.id.in_(assigned_assets(principal)))
    if is_customer_scoped(principal):
        if not principal.customer_ids:
            return statement.where(false())
        return statement.where(Asset.customer_id.in_(principal.customer_ids))
    return statement


def _title(status: WorkflowStatus) -> str:
    return {
        WorkflowStatus.INSPECTION_DRAFT: "Ready to start",
        WorkflowStatus.IN_PROGRESS: "In progress",
        WorkflowStatus.CHANGES_REQUIRED: "Changes required",
        WorkflowStatus.AWAITING_REVIEW: "Awaiting review",
    }.get(status, status.value.replace("_", " ").title())


def _priority(status: WorkflowStatus) -> str:
    if status in {
        WorkflowStatus.OVERDUE,
        WorkflowStatus.CHANGES_REQUIRED,
        WorkflowStatus.RESCHEDULE_REQUESTED,
    }:
        return "URGENT"
    if status in {
        WorkflowStatus.DUE,
        WorkflowStatus.AWAITING_REVIEW,
        WorkflowStatus.SCHEDULE_REQUESTED,
        WorkflowStatus.RESCHEDULE_AWAITING_CONFIRMATION,
    }:
        return "DUE_SOON"
    return "NORMAL"


def _due_at(workflow: AssetWorkflow) -> datetime | None:
    if workflow.context.due_at is None:
        return workflow.context.scheduled_at
    return datetime.combine(workflow.context.due_at, datetime.min.time(), tzinfo=UTC)


def _latest_activity(*timestamps: datetime | None) -> datetime:
    values = [
        timestamp if timestamp.tzinfo is not None else timestamp.replace(tzinfo=UTC)
        for timestamp in timestamps
        if timestamp is not None
    ]
    return max(values)


def _inspection_activity(inspection: Inspection) -> datetime:
    return _latest_activity(
        inspection.created_at,
        inspection.updated_at,
        inspection.started_at,
        inspection.submitted_at,
        inspection.approved_at,
        inspection.rejected_at,
    )


def _booking_activity(
    booking: InspectionBooking,
    workflow: AssetWorkflow,
) -> datetime:
    timestamps = [booking.created_at, booking.updated_at, booking.reviewed_at]
    if workflow.status in {
        WorkflowStatus.RESCHEDULE_REQUESTED,
        WorkflowStatus.RESCHEDULE_AWAITING_CONFIRMATION,
    }:
        timestamps.extend(
            timestamp
            for change in booking.change_requests
            if change.deleted_at is None
            for timestamp in (change.created_at, change.updated_at, change.reviewed_at)
        )
    return _latest_activity(*timestamps)


def _work_activity(
    asset: Asset,
    workflow: AssetWorkflow,
    inspections_by_id: dict[str, Inspection],
    bookings_by_id: dict[str, InspectionBooking],
) -> datetime:
    action = workflow.next_action
    if action is not None and action.target_type.value in {
        "INSPECTION",
        "CERTIFICATES",
    }:
        inspection_id = action.inspection_id or workflow.related.inspection_id
        inspection = (
            inspections_by_id.get(inspection_id)
            if inspection_id is not None
            else None
        )
        if inspection is not None:
            return _inspection_activity(inspection)
    if action is not None and action.target_type.value == "SCHEDULING":
        booking_id = action.target_id or workflow.related.booking_id
        if booking_id is not None and (booking := bookings_by_id.get(booking_id)):
            return _booking_activity(booking, workflow)
    schedule = asset.retest_schedule
    return _latest_activity(
        asset.created_at,
        asset.updated_at,
        schedule.created_at if schedule is not None else None,
        schedule.updated_at if schedule is not None else None,
    )


def _item(
    asset: Asset,
    workflow: AssetWorkflow,
    inspections_by_id: dict[str, Inspection],
    bookings_by_id: dict[str, InspectionBooking],
) -> WorkItem | None:
    action = workflow.next_action
    if action is None:
        return None
    target_id = action.target_id or action.inspection_id or asset.id
    return WorkItem(
        id=f"{action.code.value}:{action.target_type.value}:{target_id}",
        kind=action.target_type.value,
        state=workflow.status.value,
        priority=_priority(workflow.status),
        title=_title(workflow.status),
        summary=workflow.detail,
        customer_id=asset.customer_id,
        customer_name=asset.customer.name,
        asset_id=asset.id,
        asset_number=asset.asset_number,
        asset_name=asset.asset_name,
        inspection_id=workflow.related.inspection_id,
        booking_id=workflow.related.booking_id,
        certificate_id=workflow.related.certificate_id,
        due_at=_due_at(workflow),
        updated_at=_work_activity(asset, workflow, inspections_by_id, bookings_by_id),
        next_action=WorkAction(
            code=action.code.value,
            label=action.label,
            target_type=action.target_type.value,
            target_id=action.target_id,
            inspection_id=action.inspection_id,
        ),
    )


def _sort_key(item: WorkItem) -> tuple[int, datetime, float, str]:
    priority = {"URGENT": 0, "DUE_SOON": 1, "NORMAL": 2}[item.priority]
    return (
        priority,
        item.due_at or datetime.max.replace(tzinfo=UTC),
        -item.updated_at.timestamp(),
        item.id,
    )


async def get_my_work(
    session: AsyncSession,
    principal: Principal,
    *,
    limit: int,
) -> MyWork:
    """Return current visible actions without reinterpreting them in a client."""
    asset_statement = (
        select(Asset)
        .where(Asset.deleted_at.is_(None))
        .options(selectinload(Asset.customer), selectinload(Asset.retest_schedule))
        .order_by(Asset.id)
        .limit(MAX_SOURCE_ASSETS + 1)
    )
    assets = (await session.scalars(_asset_scope(asset_statement, principal))).all()
    source_limited = len(assets) > MAX_SOURCE_ASSETS
    assets = assets[:MAX_SOURCE_ASSETS]
    if not assets:
        return MyWork([], 0, 0, 0, 0, MAX_SOURCE_ASSETS, source_limited)

    asset_ids = [asset.id for asset in assets]
    bookings_statement = (
        select(InspectionBooking)
        .join(
            InspectionBookingAsset,
            InspectionBookingAsset.booking_id == InspectionBooking.id,
        )
        .where(
            InspectionBookingAsset.asset_id.in_(asset_ids),
            InspectionBookingAsset.deleted_at.is_(None),
            InspectionBooking.deleted_at.is_(None),
        )
        .options(
            selectinload(InspectionBooking.appointment),
            selectinload(InspectionBooking.change_requests),
        )
    )
    inspections_statement = (
        select(Inspection)
        .where(Inspection.asset_id.in_(asset_ids), Inspection.deleted_at.is_(None))
        .options(selectinload(Inspection.pressure_test))
    )
    certificates_statement = select(Certificate).where(
        Certificate.asset_id.in_(asset_ids), Certificate.deleted_at.is_(None)
    )
    if is_inspector_scoped(principal):
        visible_bookings = assigned_bookings(principal)
        bookings_statement = bookings_statement.where(
            InspectionBooking.id.in_(visible_bookings)
        )
        inspections_statement = inspections_statement.where(
            Inspection.booking_id.in_(visible_bookings)
        )
        certificates_statement = certificates_statement.join(
            Inspection, Certificate.inspection_id == Inspection.id
        ).where(Inspection.booking_id.in_(visible_bookings))

    bookings = (await session.scalars(bookings_statement)).unique().all()
    inspections = (await session.scalars(inspections_statement)).all()
    certificates = (await session.scalars(certificates_statement)).all()
    bookings_by_asset: dict[str, list[InspectionBooking]] = defaultdict(list)
    for booking in bookings:
        for link in booking.assets:
            if link.asset_id in asset_ids and link.deleted_at is None:
                bookings_by_asset[link.asset_id].append(booking)
    inspections_by_asset: dict[str, list[Inspection]] = defaultdict(list)
    for inspection in inspections:
        inspections_by_asset[inspection.asset_id].append(inspection)
    certificates_by_asset: dict[str, list[Certificate]] = defaultdict(list)
    for certificate in certificates:
        certificates_by_asset[certificate.asset_id].append(certificate)
    inspections_by_id = {inspection.id: inspection for inspection in inspections}
    bookings_by_id = {booking.id: booking for booking in bookings}

    deduped: dict[str, WorkItem] = {}
    capabilities = _capabilities(principal)
    for asset in assets:
        workflow = resolve_asset_workflow(
            asset,
            retest_schedule=asset.retest_schedule,
            bookings=bookings_by_asset[asset.id],
            inspections=inspections_by_asset[asset.id],
            certificates=certificates_by_asset[asset.id],
            capabilities=capabilities,
        )
        item = _item(asset, workflow, inspections_by_id, bookings_by_id)
        if item is not None:
            deduped.setdefault(item.id, item)

    all_items = sorted(deduped.values(), key=_sort_key)
    return MyWork(
        items=all_items[:limit],
        total=len(all_items),
        urgent=sum(item.priority == "URGENT" for item in all_items),
        due_soon=sum(item.priority == "DUE_SOON" for item in all_items),
        normal=sum(item.priority == "NORMAL" for item in all_items),
        source_limit=MAX_SOURCE_ASSETS,
        source_limited=source_limited,
    )
