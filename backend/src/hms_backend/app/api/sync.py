from __future__ import annotations

import json
import time
from collections.abc import Sequence
from datetime import UTC, datetime
from hashlib import sha256
from typing import Annotated, Any, Protocol, cast

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.api.sync_bootstrap import (
    CURRENT_SYNC_PROTOCOL_VERSION,
    DEFAULT_PAGE_SIZE,
    LEGACY_BOOTSTRAP_MAX_ROWS,
    LIFECYCLE_PROTOCOL_VERSION,
    MAX_PAGE_SIZE,
    PAGING_PROTOCOL_VERSION,
    SYNC_MODELS,
    UNSCOPED_ENTITIES,
    PageToken,
    PageTokenError,
    PagingUnavailableError,
    decode_page_token,
    encode_page_token,
    read_page,
    scope_fingerprint,
    work_context_select,
)
from hms_backend.app.api.sync_schemas import (
    SyncBootstrapResponse,
    SyncChangesResponse,
    SyncDeviceRead,
    SyncOperationResult,
    SyncOperationWrite,
    SyncPushRequest,
    SyncPushResponse,
    SyncRecordRead,
    SyncWorkContext,
)
from hms_backend.app.core.audit import normalise_for_json
from hms_backend.app.core.config import settings
from hms_backend.app.core.inspector_access import (
    assigned_assets,
    assigned_bookings,
    is_inspector_scoped,
    lock_assigned_bookings,
)
from hms_backend.app.core.rbac import (
    Permission,
    Principal,
    is_customer_scoped,
    require_permission,
)
from hms_backend.app.core.repository import record_create, record_update
from hms_backend.app.models.foundation import Device, IdempotencyKey, SyncChange
from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.assets.pressure import rated_pressures
from hms_backend.app.modules.certificates.models import Certificate
from hms_backend.app.modules.customers.models import (
    Customer,
    CustomerContact,
    CustomerLocation,
)
from hms_backend.app.modules.inspections.measurements import (
    PRESSURE_TEST_MISSING,
    MeasurementsError,
    missing_for_submission,
    normalize_measurements,
    validate_inspection_result,
)
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionAppointment,
    InspectionBooking,
    InspectionStatus,
    PressureTestResult,
)
from hms_backend.app.modules.inspections.workflow import (
    InvalidTransitionError,
    begin_rework,
    mark_submitted,
    plan_actions,
    start,
    start_and_submit,
)
from hms_backend.app.modules.notifications.enums import NotificationCategory
from hms_backend.app.modules.notifications.outbox import emit_event
from hms_backend.app.modules.scheduling.models import RetestSchedule

router = APIRouter()

# What the offline inspector may still edit: its draft, or the same record once the
# staff app has started it (the inspector knows only "draft").
_SYNC_EDITABLE = frozenset(
    {InspectionStatus.DRAFT.value, InspectionStatus.IN_PROGRESS.value}
)

SessionDep = Annotated[AsyncSession, Depends(get_session)]
PrincipalDep = Annotated[Principal, Depends(get_current_principal)]
DeviceIdHeader = Annotated[str | None, Header(alias="X-HMS-Device-Id")]
DevicePlatformHeader = Annotated[str | None, Header(alias="X-HMS-Device-Platform")]
AppVersionHeader = Annotated[str | None, Header(alias="X-HMS-App-Version")]
SyncProtocolHeader = Annotated[str | None, Header(alias="X-HMS-Sync-Protocol")]
LimitParam = Annotated[int, Query(ge=1, le=500)]


class SyncableRow(Protocol):
    id: str
    version: int
    deleted_at: datetime | None

    def to_audit_dict(self) -> dict[str, object | None]: ...


@router.get("/sync/bootstrap", response_model=SyncBootstrapResponse)
async def sync_bootstrap(
    session: SessionDep,
    principal: PrincipalDep,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = DEFAULT_PAGE_SIZE,
    page_token: Annotated[str | None, Query(max_length=2048)] = None,
    device_id: DeviceIdHeader = None,
    platform: DevicePlatformHeader = None,
    app_version: AppVersionHeader = None,
    sync_protocol: SyncProtocolHeader = None,
) -> SyncBootstrapResponse:
    _require_sync_read(principal)
    device = await _upsert_sync_device(
        session,
        principal,
        device_id=device_id,
        platform=platform,
        app_version=app_version,
    )
    negotiated = _negotiated_protocol(sync_protocol)
    if negotiated < PAGING_PROTOCOL_VERSION:
        response = await _legacy_bootstrap(session, principal, device)
        await session.commit()
        return response

    assert device_id is not None  # _upsert_sync_device rejects a missing header
    try:
        token = (
            None
            if page_token is None
            else decode_page_token(
                page_token,
                user_id=principal.persisted_user_id,
                device_id=device_id,
            )
        )
        if token is None:
            # The watermark and the scope fingerprint are read before any page data,
            # so a change after them is either in the pages or in the change feed.
            snapshot = await _max_sync_seq(session)
            fingerprint = await scope_fingerprint(session, principal)
            section, after = 0, None
        else:
            snapshot, fingerprint = token.snapshot, token.fingerprint
            section, after = token.section, token.key
        page = await read_page(
            session, principal, section=section, after=after, budget=limit
        )
        next_token = None
        scope_changed = False
        if page.next_position is None:
            scope_changed = fingerprint != await scope_fingerprint(session, principal)
        else:
            next_token = encode_page_token(
                PageToken(
                    snapshot=snapshot,
                    section=page.next_position[0],
                    key=page.next_position[1],
                    user_id=principal.persisted_user_id,
                    device_id=device_id,
                    fingerprint=fingerprint,
                    issued_at=int(time.time()),
                )
            )
    except PageTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "SYNC_PAGE_TOKEN_INVALID", "message": str(exc)},
        ) from exc
    except PagingUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Sync paging is not configured",
        ) from exc
    response = SyncBootstrapResponse(
        device=_device_read(device),
        cursor=snapshot,
        has_more=next_token is not None,
        records=[
            _bootstrap_record(name, row, native=_is_native(negotiated))
            for name, row in page.rows
        ],
        work_contexts=_context_models(page.contexts),
        protocol_version=negotiated,
        next_page_token=next_token,
        page_size=limit,
        scope_changed=scope_changed,
    )
    await session.commit()
    return response


def _negotiated_protocol(header: str | None) -> int:
    """The protocol this exchange runs at: what the client asked for, capped at ours.

    Below paging (no header, or 1) is the legacy single response. A newer client than
    this server is served at the newest version this server speaks, and the response
    says which, so the client can refuse to run on less than it needs.
    """
    requested = _client_protocol(header)
    if requested < PAGING_PROTOCOL_VERSION:
        return 1
    return min(requested, CURRENT_SYNC_PROTOCOL_VERSION)


def _is_native(protocol: int) -> bool:
    """Whether this exchange carries the real inspection lifecycle (protocol 3+)."""
    return protocol >= LIFECYCLE_PROTOCOL_VERSION


def _client_protocol(header: str | None) -> int:
    if header is None:
        return 1
    try:
        return int(header)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="X-HMS-Sync-Protocol must be a whole number",
        ) from exc


async def _legacy_bootstrap(
    session: AsyncSession, principal: Principal, device: Device
) -> SyncBootstrapResponse:
    """The single-response shape for a client that predates paging (temporary).

    Uses the same scoped keyset queries as the paged protocol and reads at most
    ``LEGACY_BOOTSTRAP_MAX_ROWS`` items. A bigger visible dataset is refused outright:
    a truncated success would silently hand the client an incomplete offline copy.
    """
    cursor = await _max_sync_seq(session)
    page = await read_page(
        session, principal, section=0, after=None, budget=LEGACY_BOOTSTRAP_MAX_ROWS
    )
    if page.next_position is not None:
        raise HTTPException(
            status_code=status.HTTP_426_UPGRADE_REQUIRED,
            detail={
                "code": "SYNC_CLIENT_UPGRADE_REQUIRED",
                "message": (
                    "Your assigned work is too large for this version of the app. "
                    "Update the app to continue."
                ),
                "required_protocol": PAGING_PROTOCOL_VERSION,
            },
            headers={"Upgrade": f"hms-sync/{PAGING_PROTOCOL_VERSION}"},
        )
    return SyncBootstrapResponse(
        device=_device_read(device),
        cursor=cursor,
        records=[_bootstrap_record(name, row) for name, row in page.rows],
        work_contexts=_context_models(page.contexts),
    )


def _bootstrap_record(
    entity_name: str, row: Any, *, native: bool = False
) -> SyncRecordRead:
    sync_row = cast(SyncableRow, row)
    return SyncRecordRead(
        entity=entity_name,
        entity_id=sync_row.id,
        op="upsert",
        version=sync_row.version,
        payload=_present_payload(entity_name, _row_payload(sync_row), native),
    )


def _context_models(
    rows: Sequence[tuple[str, str, str, str, str]],
) -> list[SyncWorkContext]:
    return [
        SyncWorkContext(
            appointment_id=a, booking_id=b, revision_id=r, assignment_id=i, asset_id=s
        )
        for a, b, r, i, s in rows
    ]


@router.get("/sync/changes", response_model=SyncChangesResponse)
async def sync_changes(
    session: SessionDep,
    principal: PrincipalDep,
    since: Annotated[int, Query(ge=0)] = 0,
    limit: LimitParam = 100,
    device_id: DeviceIdHeader = None,
    platform: DevicePlatformHeader = None,
    app_version: AppVersionHeader = None,
    sync_protocol: SyncProtocolHeader = None,
) -> SyncChangesResponse:
    _require_sync_read(principal)
    await _upsert_sync_device(
        session,
        principal,
        device_id=device_id,
        platform=platform,
        app_version=app_version,
    )
    fetched = (
        await session.scalars(
            select(SyncChange)
            .where(SyncChange.seq > since)
            .order_by(SyncChange.seq)
            .limit(limit + 1)
        )
    ).all()
    scanned = fetched[:limit]
    native = _is_native(_negotiated_protocol(sync_protocol))
    changes = await _visible_change_records(
        session, principal, scanned, native=native
    )
    # Advance only over what this response actually scanned. An empty page consumed
    # nothing, so it must not jump to a later snapshot's maximum: a change committed
    # after the SELECT above would be skipped and never delivered.
    cursor = scanned[-1].seq if scanned else since
    await session.commit()
    return SyncChangesResponse(
        cursor=cursor,
        has_more=len(fetched) > limit,
        changes=changes,
    )


@router.post("/sync/push", response_model=SyncPushResponse)
@router.post("/sync/operations", response_model=SyncPushResponse)
async def sync_push(
    payload: SyncPushRequest,
    session: SessionDep,
    principal: PrincipalDep,
    device_id: DeviceIdHeader = None,
    platform: DevicePlatformHeader = None,
    app_version: AppVersionHeader = None,
    sync_protocol: SyncProtocolHeader = None,
) -> SyncPushResponse:
    _require_sync_push(principal)
    device = await _upsert_sync_device(
        session,
        principal,
        device_id=device_id,
        platform=platform,
        app_version=app_version,
    )
    await lock_assigned_bookings(session, principal)
    results: list[SyncOperationResult] = []
    protocol = _negotiated_protocol(sync_protocol)
    for operation in payload.operations:
        results.append(
            _present_result(
                await _apply_idempotent_operation(
                    session, principal, operation, device.device_id, protocol
                ),
                _is_native(protocol),
            )
        )
    await session.commit()
    # Informational only: the newest committed sequence at response time, not a
    # watermark of what the caller has received. Never feed it back as ``since``.
    return SyncPushResponse(cursor=await _max_sync_seq(session), results=results)


def _require_sync_read(principal: Principal) -> None:
    try:
        require_permission(principal, Permission.ASSET_READ)
    except PermissionError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc


def _require_sync_push(principal: Principal) -> None:
    try:
        require_permission(principal, Permission.INSPECTION_WRITE)
    except PermissionError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc


async def _lock_device(session: AsyncSession, device_id: str) -> Device | None:
    """Load the device with a row lock (``SELECT ... FOR UPDATE``).

    Holding the lock until this transaction ends means a concurrent revoke or metadata
    update waits for it, and a request that starts after a revoke commits sees the
    revoked state instead of a stale copy.
    """
    return (
        await session.scalars(
            select(Device)
            .where(Device.device_id == device_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).one_or_none()


async def _upsert_sync_device(
    session: AsyncSession,
    principal: Principal,
    *,
    device_id: str | None,
    platform: str | None,
    app_version: str | None,
) -> Device:
    if not device_id or not platform or not app_version:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Sync device headers are required",
        )
    owner_id = principal.persisted_user_id
    device = await _lock_device(session, device_id)
    created = False
    if device is None:
        candidate = Device(
            device_id=device_id,
            user_id=owner_id,
            platform=platform,
            app_version=app_version,
            offline_window_days=7,
            revoked=False,
        )
        try:
            # A savepoint, so losing a registration race rolls back only this insert.
            async with session.begin_nested():
                session.add(candidate)
                await session.flush()
        except IntegrityError:
            # Another request registered the same device first: adopt its row (the
            # locking read waits for that transaction to commit).
            device = await _lock_device(session, device_id)
            if device is None:
                raise
        else:
            device = candidate
            created = True
    if device.user_id != owner_id:
        # A device id is bound to the user who registered it. Silently re-pointing it
        # would hand one user's device record, and its revocation state, to another.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Sync device is registered to another user",
        )
    if device.revoked:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Sync device has been revoked",
        )
    if created:
        # New device registration is a security event to the device owner. Only the
        # request that actually created the row emits it.
        await emit_event(
            session,
            category=NotificationCategory.DEVICE_REGISTERED,
            aggregate_type="device",
            aggregate_id=device_id,
            payload={
                "user_id": principal.user_id,
                "device_label": f"{platform} ({device_id})",
                "link": settings.public_base_url.rstrip("/"),
            },
        )
    device.platform = platform
    device.app_version = app_version
    device.last_sync_at = datetime.now(UTC)
    await session.flush()
    return device


def _device_read(device: Device) -> SyncDeviceRead:
    return SyncDeviceRead(
        device_id=device.device_id,
        platform=device.platform,
        app_version=device.app_version,
        offline_window_days=device.offline_window_days,
        revoked=device.revoked,
    )


async def _max_sync_seq(session: AsyncSession) -> int:
    return await session.scalar(select(func.max(SyncChange.seq))) or 0


async def _visible_change_records(
    session: AsyncSession,
    principal: Principal,
    changes: Sequence[SyncChange],
    *,
    native: bool = False,
) -> list[SyncRecordRead]:
    records: list[SyncRecordRead] = []
    for change in changes:
        if change.entity not in SYNC_MODELS:
            continue
        if not await _row_visible(session, principal, change.entity, change.entity_id):
            continue
        row = await _get_sync_row(session, change.entity, change.entity_id)
        is_delete = row is None or row.deleted_at is not None or change.op == "delete"
        records.append(
            SyncRecordRead(
                seq=change.seq,
                entity=change.entity,
                entity_id=change.entity_id,
                op="delete" if is_delete else "upsert",
                version=change.version,
                changed_at=change.changed_at,
                payload=(
                    None
                    if is_delete
                    else _present_payload(
                        change.entity, _row_payload(cast(SyncableRow, row)), native
                    )
                ),
            )
        )
    return records


async def _get_sync_row(
    session: AsyncSession,
    entity_name: str,
    entity_id: str,
) -> SyncableRow | None:
    model = SYNC_MODELS[entity_name]
    row = await session.get(model, entity_id)
    return cast(SyncableRow | None, row)


def _row_payload(row: SyncableRow) -> dict[str, Any]:
    payload = cast(dict[str, Any], normalise_for_json(row.to_audit_dict()))
    if isinstance(row, Asset):
        # The offline inspector prefills the pressure form from the product rating, but
        # the bore lives on the asset's ends, which are not synced. The server resolves
        # it once, here.
        rated = rated_pressures(row)
        payload["pressure_rating"] = (
            None
            if rated is None
            else {
                "nominal_bore_id": rated[0],
                "working_pressure_kpa": rated[1],
                "test_pressure_kpa": rated[2],
            }
        )
    return payload


def _present_payload(
    entity: str, payload: dict[str, Any] | None, native: bool
) -> dict[str, Any] | None:
    """What this client may see of a record.

    Protocol 3 sees the real inspection status. Earlier clients know only DRAFT and
    SUBMITTED and lock anything else, so an inspection in progress is, to them, the
    editable draft. Every surface (bootstrap, changes, push results, replayed results)
    goes through here, so the projection cannot be missed on one of them.
    """
    if (
        not native
        and entity == "Inspection"
        and payload is not None
        and payload.get("status") == InspectionStatus.IN_PROGRESS.value
    ):
        return {**payload, "status": InspectionStatus.DRAFT.value}
    return payload


def _present_result(result: SyncOperationResult, native: bool) -> SyncOperationResult:
    if native or result.payload is None:
        return result
    return result.model_copy(
        update={"payload": _present_payload(result.entity, result.payload, native)}
    )


async def _row_visible(
    session: AsyncSession,
    principal: Principal,
    entity_name: str,
    entity_id: str,
) -> bool:
    if entity_name in UNSCOPED_ENTITIES:
        return True
    if is_inspector_scoped(principal):
        if entity_name == "Asset":
            return entity_id in set(
                (await session.scalars(assigned_assets(principal))).all()
            )
        if entity_name == "Customer":
            return bool(
                await session.scalar(
                    select(InspectionBooking.id)
                    .where(
                        InspectionBooking.id.in_(assigned_bookings(principal)),
                        InspectionBooking.customer_id == entity_id,
                    )
                    .limit(1)
                )
            )
        if entity_name == "CustomerLocation":
            return bool(
                await session.scalar(
                    select(InspectionBooking.id)
                    .where(
                        InspectionBooking.id.in_(assigned_bookings(principal)),
                        InspectionBooking.location_id == entity_id,
                    )
                    .limit(1)
                )
            )
        if entity_name == "RetestSchedule":
            return bool(
                await session.scalar(
                    select(RetestSchedule.id)
                    .where(
                        RetestSchedule.id == entity_id,
                        RetestSchedule.asset_id.in_(assigned_assets(principal)),
                    )
                    .limit(1)
                )
            )
        if entity_name == "Inspection":
            return bool(
                await session.scalar(
                    select(Inspection.id)
                    .where(
                        Inspection.id == entity_id,
                        Inspection.booking_id.in_(assigned_bookings(principal)),
                        Inspection.asset_id.in_(assigned_assets(principal)),
                    )
                    .limit(1)
                )
            )
        if entity_name == "PressureTestResult":
            inspection_id = await session.scalar(
                select(PressureTestResult.inspection_id).where(
                    PressureTestResult.id == entity_id,
                )
            )
            return inspection_id is not None and await _row_visible(
                session, principal, "Inspection", inspection_id
            )
        return False
    customer_id = await _customer_id_for_entity(session, entity_name, entity_id)
    if customer_id is None:
        return False
    if not is_customer_scoped(principal):
        return True
    return customer_id in principal.customer_ids


async def _customer_id_for_entity(
    session: AsyncSession,
    entity_name: str,
    entity_id: str,
) -> str | None:
    if entity_name == "Customer":
        customer = await session.get(Customer, entity_id)
        return customer.id if customer is not None else None
    if entity_name == "CustomerLocation":
        location = await session.get(CustomerLocation, entity_id)
        return location.customer_id if location is not None else None
    if entity_name == "CustomerContact":
        contact = await session.get(CustomerContact, entity_id)
        return contact.customer_id if contact is not None else None
    if entity_name == "Asset":
        asset = await session.get(Asset, entity_id)
        return asset.customer_id if asset is not None else None
    if entity_name == "RetestSchedule":
        schedule = await session.get(RetestSchedule, entity_id)
        return schedule.customer_id if schedule is not None else None
    if entity_name == "Inspection":
        return cast(
            str | None,
            await session.scalar(
                select(Asset.customer_id)
                .join(Inspection, Inspection.asset_id == Asset.id)
                .where(Inspection.id == entity_id)
            ),
        )
    if entity_name == "PressureTestResult":
        return cast(
            str | None,
            await session.scalar(
                select(Asset.customer_id)
                .join(Inspection, Inspection.asset_id == Asset.id)
                .join(
                    PressureTestResult,
                    PressureTestResult.inspection_id == Inspection.id,
                )
                .where(PressureTestResult.id == entity_id)
            ),
        )
    if entity_name == "Certificate":
        return cast(
            str | None,
            await session.scalar(
                select(Asset.customer_id)
                .join(Certificate, Certificate.asset_id == Asset.id)
                .where(Certificate.id == entity_id)
            ),
        )
    return None


async def _inspector_work_contexts(
    session: AsyncSession, principal: Principal
) -> list[SyncWorkContext]:
    if not is_inspector_scoped(principal):
        return []
    rows = (await session.execute(work_context_select(principal))).all()
    return _context_models([(a, b, r, i, s) for a, b, r, i, s in rows])


async def _apply_idempotent_operation(
    session: AsyncSession,
    principal: Principal,
    operation: SyncOperationWrite,
    device_id: str,
    protocol: int,
) -> SyncOperationResult:
    key = operation.idempotency_key
    fingerprint = ""
    if is_inspector_scoped(principal):
        context = operation.work_context
        if context is None:
            return _rejected(
                operation, "A work context is required", "WORK_CONTEXT_STALE"
            )
        allowed = await _inspector_work_contexts(session, principal)
        if context not in allowed:
            return _rejected(
                operation, "Work context is no longer valid", "WORK_CONTEXT_STALE"
            )
        if operation.entity == "Asset" and operation.entity_id != context.asset_id:
            return _rejected(
                operation, "Asset is outside the assignment", "ASSET_SCOPE_CHANGED"
            )
        if operation.entity == "Inspection" and operation.op == "create":
            if _string_payload(operation, "asset_id") != context.asset_id:
                return _rejected(
                    operation, "Asset is outside the assignment", "ASSET_SCOPE_CHANGED"
                )
        if operation.entity == "Inspection" and operation.op != "create":
            inspection = await session.get(Inspection, operation.entity_id)
            appointment = await session.get(
                InspectionAppointment, context.appointment_id
            )
            if (
                inspection is None
                or appointment is None
                or (
                    inspection.booking_id != appointment.booking_id
                    or inspection.asset_id != context.asset_id
                )
            ):
                return _rejected(
                    operation,
                    "Inspection is outside the assignment",
                    "WORK_CONTEXT_STALE",
                )
        if operation.entity == "PressureTestResult":
            pressure = await session.get(PressureTestResult, operation.entity_id)
            inspection_id = (
                _string_payload(operation, "inspection_id")
                if operation.op == "create"
                else pressure.inspection_id
                if pressure
                else None
            )
            inspection = (
                await session.get(Inspection, inspection_id) if inspection_id else None
            )
            appointment = await session.get(
                InspectionAppointment, context.appointment_id
            )
            if (
                inspection is None
                or appointment is None
                or (
                    inspection.booking_id != appointment.booking_id
                    or inspection.asset_id != context.asset_id
                )
            ):
                return _rejected(
                    operation,
                    "Inspection is outside the assignment",
                    "WORK_CONTEXT_STALE",
                )
        fingerprint = sha256(
            json.dumps(
                {
                    "user_id": principal.user_id,
                    "device_id": device_id,
                    "entity": operation.entity,
                    "entity_id": operation.entity_id,
                    "operation": operation.op,
                    "base_version": operation.base_version,
                    "work_context": context.model_dump(mode="json"),
                    "payload": operation.payload,
                    **(
                        {"lifecycle_actions": operation.lifecycle_actions}
                        if operation.lifecycle_actions is not None
                        else {}
                    ),
                },
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=True,
            ).encode()
        ).hexdigest()
        if operation.entity == "Asset":
            visible = await _row_visible(
                session, principal, "Asset", operation.entity_id
            )
        elif operation.entity == "Inspection" and operation.op == "create":
            asset_id = _string_payload(operation, "asset_id")
            visible = asset_id is not None and await _row_visible(
                session, principal, "Asset", asset_id
            )
        elif operation.entity == "PressureTestResult" and operation.op == "create":
            inspection_id = _string_payload(operation, "inspection_id")
            visible = inspection_id is not None and await _row_visible(
                session, principal, "Inspection", inspection_id
            )
        else:
            visible = await _row_visible(
                session, principal, operation.entity, operation.entity_id
            )
        if not visible:
            return _rejected(operation, "Record is not visible for sync push")
        key = (
            "inspector:"
            + sha256(
                (principal.user_id + "\0" + operation.idempotency_key).encode()
            ).hexdigest()
        )
    existing_key = await session.get(IdempotencyKey, key)
    if existing_key is not None and existing_key.result_json is not None:
        saved = existing_key.result_json
        if is_inspector_scoped(principal):
            if saved.get("fingerprint") != fingerprint:
                return _rejected(
                    operation, "Idempotency key was reused", "IDEMPOTENCY_KEY_REUSED"
                )
            saved = cast(dict[str, object], saved.get("result"))
        cached = SyncOperationResult.model_validate(saved)
        if is_inspector_scoped(principal):
            if (
                cached.entity != operation.entity
                or cached.entity_id != operation.entity_id
            ):
                return _rejected(operation, "Idempotency key belongs to another record")
            if cached.payload is not None and not await _row_visible(
                session, principal, cached.entity, cached.entity_id
            ):
                return _rejected(operation, "Record is not visible for sync push")
        return cached

    result = await _apply_sync_operation(session, principal, operation, protocol)
    session.add(
        IdempotencyKey(
            key=key,
            result_json=(
                {"fingerprint": fingerprint, "result": result.model_dump(mode="json")}
                if is_inspector_scoped(principal)
                else result.model_dump(mode="json")
            ),
        )
    )
    await session.flush()
    return result


async def _apply_sync_operation(
    session: AsyncSession,
    principal: Principal,
    operation: SyncOperationWrite,
    protocol: int,
) -> SyncOperationResult:
    if operation.lifecycle_actions is not None:
        if not _is_native(protocol):
            return _rejected(
                operation,
                "Lifecycle actions need sync protocol 3",
                "LIFECYCLE_PROTOCOL_REQUIRED",
            )
        if operation.entity != "Inspection" or operation.op == "delete":
            return _rejected(
                operation, "Lifecycle actions apply only to an Inspection"
            )
    if operation.entity == "Asset":
        return await _update_asset_from_sync(session, principal, operation)
    if operation.entity == "PressureTestResult":
        return await _apply_pressure_test_from_sync(session, principal, operation)
    if operation.entity != "Inspection":
        return _rejected(
            operation,
            "Only Asset, Inspection, and PressureTestResult sync push are supported",
        )
    if operation.op == "delete":
        return _rejected(operation, "Inspection delete is not supported by sync push")
    if operation.op == "create":
        return await _create_inspection_from_sync(session, principal, operation)
    return await _update_inspection_from_sync(session, principal, operation)


async def _update_asset_from_sync(
    session: AsyncSession,
    principal: Principal,
    operation: SyncOperationWrite,
) -> SyncOperationResult:
    if operation.op != "update":
        return _rejected(operation, "Only Asset update is supported by sync push")

    supported_fields = {"customer_serial_no", "tag"}
    unsupported_fields = set(operation.payload) - supported_fields
    if unsupported_fields:
        field_list = ", ".join(sorted(unsupported_fields))
        return _rejected(operation, f"Unsupported Asset sync field: {field_list}")

    asset = await _visible_asset_or_none(session, principal, operation.entity_id)
    if asset is None:
        return _rejected(operation, "Asset is not visible for sync push")
    if operation.base_version != asset.version:
        return _conflict(operation, asset)
    if not operation.payload:
        return _rejected(
            operation,
            "Asset update requires at least one supported field",
        )

    before = asset.to_audit_dict()
    if "customer_serial_no" in operation.payload:
        asset.customer_serial_no = _optional_string_payload(
            operation,
            "customer_serial_no",
        )
    if "tag" in operation.payload:
        asset.tag = _optional_string_payload(operation, "tag")
    await record_update(
        session,
        asset,
        actor_id=principal.user_id,
        action="asset.updated",
        before=before,
    )
    return _applied(operation, asset)


async def _create_inspection_from_sync(
    session: AsyncSession,
    principal: Principal,
    operation: SyncOperationWrite,
) -> SyncOperationResult:
    existing = await session.get(Inspection, operation.entity_id)
    if existing is not None:
        return _rejected(operation, "Inspection already exists")

    asset_id = _string_payload(operation, "asset_id")
    inspection_type = _string_payload(operation, "inspection_type")
    if asset_id is None or inspection_type is None:
        return _rejected(
            operation,
            "Inspection create requires asset_id and inspection_type",
        )
    asset = await _visible_asset_or_none(session, principal, asset_id)
    if asset is None:
        return _rejected(operation, "Asset is not visible for sync push")

    booking_id = None
    if is_inspector_scoped(principal):
        assert operation.work_context is not None
        appointment = await session.get(
            InspectionAppointment, operation.work_context.appointment_id
        )
        assert appointment is not None
        booking_id = appointment.booking_id
        existing_assigned_inspection = await session.scalar(
            select(Inspection.id)
            .where(
                Inspection.booking_id == booking_id,
                Inspection.asset_id == asset_id,
                Inspection.deleted_at.is_(None),
            )
            .limit(1)
        )
        if existing_assigned_inspection is not None:
            return _rejected(operation, "The assignment already has an inspection")
    plan: tuple[list[str], bool] | None = None
    if operation.lifecycle_actions is not None:
        planned = _native_plan(operation, InspectionStatus.DRAFT.value)
        if isinstance(planned, str):
            return _rejected(operation, planned)
        plan = planned
    invalid = _check_inspection_payload(
        operation, None, native_submit=plan[1] if plan is not None else None
    )
    if invalid is not None:
        return _rejected(operation, invalid)
    inspection = Inspection(
        id=operation.entity_id,
        asset=asset,
        booking_id=booking_id,
        inspection_type=inspection_type,
        status=InspectionStatus.DRAFT.value,
        result=_optional_string_payload(operation, "result"),
        inspector_user_id=principal.persisted_user_id,
    )
    session.add(inspection)
    await record_create(
        session,
        inspection,
        actor_id=principal.user_id,
        action="inspection.created",
    )
    if plan is not None:
        # Native lifecycle, in the order the inspector performed it: the transitions
        # that make the record editable, then the work, then the submit.
        await _run_transitions(session, inspection, plan[0], principal.user_id)
    pressure_payload = operation.payload.get("pressure_test")
    if isinstance(pressure_payload, dict):
        await _create_pressure_test_from_sync(
            session,
            inspection=inspection,
            payload=pressure_payload,
            actor_id=principal.user_id,
        )
    if plan is not None:
        if plan[1]:
            await mark_submitted(session, inspection, actor_id=principal.user_id)
    elif operation.payload.get("status") == "SUBMITTED":
        refused = await _submit_from_sync(session, operation, inspection, principal)
        if refused is not None:
            return refused
    return _applied(operation, inspection)


async def _submit_from_sync(
    session: AsyncSession,
    operation: SyncOperationWrite,
    inspection: Inspection,
    principal: Principal,
) -> SyncOperationResult | None:
    """The offline inspector's submit: a start and a submit in one step.

    Compatibility bridge: the deployed inspector has no "start", so a draft it submits
    is started here first (``started_at`` and both audit events are real). The
    completeness check is the same as online and has already run on the payload.
    """
    try:
        await start_and_submit(session, inspection, actor_id=principal.user_id)
    except InvalidTransitionError as error:
        return _rejected(operation, str(error))
    return None


async def _apply_pressure_test_from_sync(
    session: AsyncSession,
    principal: Principal,
    operation: SyncOperationWrite,
) -> SyncOperationResult:
    if operation.op == "delete":
        return _rejected(
            operation,
            "PressureTestResult delete is not supported by sync push",
        )
    if operation.op == "create":
        return await _create_pressure_test_entity_from_sync(
            session,
            principal,
            operation,
        )
    return await _update_pressure_test_entity_from_sync(
        session,
        principal,
        operation,
    )


async def _create_pressure_test_entity_from_sync(
    session: AsyncSession,
    principal: Principal,
    operation: SyncOperationWrite,
) -> SyncOperationResult:
    existing = await session.get(PressureTestResult, operation.entity_id)
    if existing is not None:
        return _rejected(operation, "PressureTestResult already exists")

    inspection_id = _string_payload(operation, "inspection_id")
    if inspection_id is None:
        return _rejected(
            operation,
            "PressureTestResult create requires inspection_id",
        )
    inspection = await _visible_inspection_or_none(
        session,
        principal,
        inspection_id,
    )
    if inspection is None:
        return _rejected(operation, "Inspection is not visible for sync push")
    if inspection.status not in _SYNC_EDITABLE:
        return _rejected(
            operation,
            "Only draft inspection pressure tests can be updated by sync push",
        )
    if inspection.pressure_test is not None:
        return _rejected(
            operation,
            "Inspection already has a pressure test result",
        )

    try:
        measurements = _measurements_payload(operation.payload)
        _require_matching_duration(
            measurements, _int_payload(operation.payload, "hold_time_seconds")
        )
    except MeasurementsError as exc:
        return _rejected(operation, str(exc))
    pressure_test = PressureTestResult(
        id=operation.entity_id,
        inspection=inspection,
        applied_pressure_kpa=_int_payload(operation.payload, "applied_pressure_kpa"),
        hold_time_seconds=_int_payload(operation.payload, "hold_time_seconds"),
        passed=_bool_payload(operation.payload, "passed"),
        measurements=measurements,
    )
    session.add(pressure_test)
    await record_create(
        session,
        pressure_test,
        actor_id=principal.user_id,
        action="pressure_test_result.created",
    )
    return _applied(operation, pressure_test)


async def _update_pressure_test_entity_from_sync(
    session: AsyncSession,
    principal: Principal,
    operation: SyncOperationWrite,
) -> SyncOperationResult:
    pressure_test = await _visible_pressure_test_or_none(
        session,
        principal,
        operation.entity_id,
    )
    if pressure_test is None:
        return _rejected(
            operation,
            "PressureTestResult is not visible for sync push",
        )
    if operation.base_version != pressure_test.version:
        return _conflict(operation, pressure_test)
    if pressure_test.inspection.status not in _SYNC_EDITABLE:
        return _rejected(
            operation,
            "Only draft inspection pressure tests can be updated by sync push",
        )

    try:
        measurements = (
            _measurements_payload(operation.payload)
            if "measurements" in operation.payload
            or "required_pressure_kpa" in operation.payload
            else pressure_test.measurements
        )
        hold_seconds = (
            _int_payload(operation.payload, "hold_time_seconds")
            if "hold_time_seconds" in operation.payload
            else pressure_test.hold_time_seconds
        )
        _require_matching_duration(measurements, hold_seconds)
    except MeasurementsError as exc:
        return _rejected(operation, str(exc))

    before = pressure_test.to_audit_dict()
    if "applied_pressure_kpa" in operation.payload:
        pressure_test.applied_pressure_kpa = _int_payload(
            operation.payload,
            "applied_pressure_kpa",
        )
    if "hold_time_seconds" in operation.payload:
        pressure_test.hold_time_seconds = _int_payload(
            operation.payload,
            "hold_time_seconds",
        )
    if "passed" in operation.payload:
        pressure_test.passed = _bool_payload(operation.payload, "passed")
    if (
        "measurements" in operation.payload
        or "required_pressure_kpa" in operation.payload
    ):
        pressure_test.measurements = measurements
    await record_update(
        session,
        pressure_test,
        actor_id=principal.user_id,
        action="pressure_test_result.updated",
        before=before,
    )
    return _applied(operation, pressure_test)


async def _update_inspection_from_sync(
    session: AsyncSession,
    principal: Principal,
    operation: SyncOperationWrite,
) -> SyncOperationResult:
    inspection = await _visible_inspection_or_none(
        session,
        principal,
        operation.entity_id,
    )
    if inspection is None:
        return _rejected(operation, "Inspection is not visible for sync push")
    if operation.lifecycle_actions is not None:
        # Transitions race with the staff app's, which lock the row: take the same lock
        # and read the row as it is now, so two submits (or a submit and a review)
        # cannot both act on the state one of them has just changed.
        inspection = await session.scalar(
            select(Inspection)
            .where(Inspection.id == inspection.id)
            .with_for_update(of=Inspection)
            .execution_options(populate_existing=True)
        )
        if inspection is None:
            return _rejected(operation, "Inspection is not visible for sync push")
    if operation.base_version != inspection.version:
        return _conflict(operation, inspection)
    if operation.lifecycle_actions is not None:
        return await _update_inspection_native(
            session, principal, operation, inspection
        )
    if inspection.status not in _SYNC_EDITABLE:
        return _rejected(
            operation,
            "Only draft inspections can be updated by sync push",
        )

    invalid = _check_inspection_payload(operation, inspection)
    if invalid is not None:
        return _rejected(operation, invalid)

    before = inspection.to_audit_dict()
    if "result" in operation.payload:
        inspection.result = _optional_string_payload(operation, "result")
    await record_update(
        session,
        inspection,
        actor_id=principal.user_id,
        action="inspection.updated",
        before=before,
    )
    pressure_payload = operation.payload.get("pressure_test")
    if isinstance(pressure_payload, dict):
        await _upsert_pressure_test_from_sync(
            session,
            inspection=inspection,
            payload=pressure_payload,
            actor_id=principal.user_id,
        )
    if operation.payload.get("status") == "SUBMITTED":
        refused = await _submit_from_sync(session, operation, inspection, principal)
        if refused is not None:
            return refused
    return _applied(operation, inspection)


async def _update_inspection_native(
    session: AsyncSession,
    principal: Principal,
    operation: SyncOperationWrite,
    inspection: Inspection,
) -> SyncOperationResult:
    """A protocol-3 update: the version was checked, nothing has been written yet.

    The whole sequence (legal transitions, editable at the time of writing, complete at
    submit) is settled first; only then do the transitions, the form data and the
    submit run, in that order, so a refusal never leaves half an operation behind.
    """
    planned = _native_plan(operation, inspection.status)
    if isinstance(planned, str):
        return _rejected(operation, planned)
    before_data, submit = planned
    invalid = _check_inspection_payload(operation, inspection, native_submit=submit)
    if invalid is not None:
        return _rejected(operation, invalid)

    await _run_transitions(session, inspection, before_data, principal.user_id)
    if "result" in operation.payload:
        before = inspection.to_audit_dict()
        inspection.result = _optional_string_payload(operation, "result")
        await record_update(
            session,
            inspection,
            actor_id=principal.user_id,
            action="inspection.updated",
            before=before,
        )
    pressure_payload = operation.payload.get("pressure_test")
    if isinstance(pressure_payload, dict):
        await _upsert_pressure_test_from_sync(
            session,
            inspection=inspection,
            payload=pressure_payload,
            actor_id=principal.user_id,
        )
    if submit:
        await mark_submitted(session, inspection, actor_id=principal.user_id)
    return _applied(operation, inspection)


async def _visible_asset_or_none(
    session: AsyncSession,
    principal: Principal,
    asset_id: str,
) -> Asset | None:
    asset = await session.get(Asset, asset_id)
    if asset is None or asset.deleted_at is not None:
        return None
    if is_inspector_scoped(principal) and not await _row_visible(
        session, principal, "Asset", asset_id
    ):
        return None
    if (
        is_customer_scoped(principal)
        and asset.customer_id not in principal.customer_ids
    ):
        return None
    return asset


async def _visible_inspection_or_none(
    session: AsyncSession,
    principal: Principal,
    inspection_id: str,
) -> Inspection | None:
    inspection = await session.get(Inspection, inspection_id)
    if inspection is None or inspection.deleted_at is not None:
        return None
    if is_inspector_scoped(principal) and not await _row_visible(
        session, principal, "Inspection", inspection_id
    ):
        return None
    asset = await session.get(Asset, inspection.asset_id)
    if asset is None or asset.deleted_at is not None:
        return None
    if (
        is_customer_scoped(principal)
        and asset.customer_id not in principal.customer_ids
    ):
        return None
    return inspection


async def _visible_pressure_test_or_none(
    session: AsyncSession,
    principal: Principal,
    pressure_test_id: str,
) -> PressureTestResult | None:
    pressure_test = await session.get(PressureTestResult, pressure_test_id)
    if pressure_test is None or pressure_test.deleted_at is not None:
        return None
    inspection = await _visible_inspection_or_none(
        session,
        principal,
        pressure_test.inspection_id,
    )
    if inspection is None:
        return None
    pressure_test.inspection = inspection
    return pressure_test


async def _create_pressure_test_from_sync(
    session: AsyncSession,
    *,
    inspection: Inspection,
    payload: dict[str, Any],
    actor_id: str,
) -> None:
    pressure_test = PressureTestResult(
        inspection=inspection,
        applied_pressure_kpa=_int_payload(payload, "applied_pressure_kpa"),
        hold_time_seconds=_int_payload(payload, "hold_time_seconds"),
        passed=_bool_payload(payload, "passed"),
        measurements=_measurements_payload(payload),
    )
    session.add(pressure_test)
    await record_create(
        session,
        pressure_test,
        actor_id=actor_id,
        action="pressure_test_result.created",
    )


async def _upsert_pressure_test_from_sync(
    session: AsyncSession,
    *,
    inspection: Inspection,
    payload: dict[str, Any],
    actor_id: str,
) -> None:
    pressure_test = inspection.pressure_test
    if pressure_test is None:
        await _create_pressure_test_from_sync(
            session,
            inspection=inspection,
            payload=payload,
            actor_id=actor_id,
        )
        return

    before = pressure_test.to_audit_dict()
    pressure_test.applied_pressure_kpa = _int_payload(payload, "applied_pressure_kpa")
    pressure_test.hold_time_seconds = _int_payload(payload, "hold_time_seconds")
    pressure_test.passed = _bool_payload(payload, "passed")
    pressure_test.measurements = _measurements_payload(payload)
    await record_update(
        session,
        pressure_test,
        actor_id=actor_id,
        action="pressure_test_result.updated",
        before=before,
    )


def _applied(
    operation: SyncOperationWrite,
    row: SyncableRow,
) -> SyncOperationResult:
    return SyncOperationResult(
        op_id=operation.op_id,
        idempotency_key=operation.idempotency_key,
        entity=operation.entity,
        entity_id=operation.entity_id,
        status="applied",
        version=row.version,
        current_version=row.version,
        payload=_row_payload(row),
    )


def _conflict(
    operation: SyncOperationWrite,
    row: SyncableRow,
) -> SyncOperationResult:
    return SyncOperationResult(
        op_id=operation.op_id,
        idempotency_key=operation.idempotency_key,
        entity=operation.entity,
        entity_id=operation.entity_id,
        status="conflict",
        version=None,
        current_version=row.version,
        payload=_row_payload(row),
        error="Version conflict",
    )


def _rejected(
    operation: SyncOperationWrite, reason: str, code: str | None = None
) -> SyncOperationResult:
    return SyncOperationResult(
        op_id=operation.op_id,
        idempotency_key=operation.idempotency_key,
        entity=operation.entity,
        entity_id=operation.entity_id,
        status="rejected",
        error_code=code,
        error=reason,
    )


def _string_payload(operation: SyncOperationWrite, key: str) -> str | None:
    value = operation.payload.get(key)
    return value if isinstance(value, str) and value else None


def _optional_string_payload(operation: SyncOperationWrite, key: str) -> str | None:
    value = operation.payload.get(key)
    return value if isinstance(value, str) and value else None


def _int_payload(payload: dict[str, Any], key: str) -> int:
    value = payload.get(key)
    if not isinstance(value, int):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"pressure_test.{key} must be an integer",
        )
    return value


def _bool_payload(payload: dict[str, Any], key: str) -> bool:
    value = payload.get(key)
    if not isinstance(value, bool):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"pressure_test.{key} must be a boolean",
        )
    return value


def _dict_payload(payload: dict[str, Any], key: str) -> dict[str, Any] | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"pressure_test.{key} must be an object",
        )
    return value


def _measurements_payload(payload: dict[str, Any]) -> dict[str, Any] | None:
    """The pressure test's measurements, validated against the form schema.

    Operations queued by an older inspector app carry the working pressure as
    ``required_pressure_kpa`` beside the measurements; it is folded in so a queued
    draft is not lost when the app is upgraded.
    """
    raw = _dict_payload(payload, "measurements")
    if "required_pressure_kpa" in payload:
        raw = {"required_pressure_kpa": payload["required_pressure_kpa"], **(raw or {})}
    return normalize_measurements(raw)


_NOT_EDITABLE_YET = {
    InspectionStatus.DRAFT.value: "Start the inspection before recording work",
    InspectionStatus.REJECTED.value: "Begin rework before changing this inspection",
    InspectionStatus.SUBMITTED.value: "This inspection can no longer be edited",
    InspectionStatus.APPROVED.value: "This inspection can no longer be edited",
}


def _native_plan(
    operation: SyncOperationWrite, status: str
) -> tuple[list[str], bool] | str:
    """A protocol-3 operation's steps, checked in full before anything is written.

    Returns the transitions to run before the form data and whether to submit after
    it, or the reason the whole operation is refused. Form data may only be written
    while the inspection is in progress once the leading transitions have run.
    """
    actions: list[str] = list(operation.lifecycle_actions or [])
    if "status" in operation.payload:
        return "status is not accepted with lifecycle actions"
    if "submit" in actions[:-1]:
        return "Submit must be the last lifecycle action"
    try:
        statuses = plan_actions(status, actions)
    except InvalidTransitionError as error:
        return str(error)
    submit = bool(actions) and actions[-1] == "submit"
    before_data = actions[:-1] if submit else actions
    write_status = statuses[len(before_data) - 1] if before_data else status
    has_content = "result" in operation.payload or isinstance(
        operation.payload.get("pressure_test"), dict
    )
    if has_content and write_status != InspectionStatus.IN_PROGRESS.value:
        return _NOT_EDITABLE_YET.get(write_status, "This inspection cannot be edited")
    return before_data, submit


async def _run_transitions(
    session: AsyncSession, inspection: Inspection, actions: list[str], actor_id: str
) -> None:
    for action in actions:
        if action == "start":
            await start(session, inspection, actor_id=actor_id)
        else:
            await begin_rework(session, inspection, actor_id=actor_id)


def _check_inspection_payload(
    operation: SyncOperationWrite,
    existing: Inspection | None,
    *,
    native_submit: bool | None = None,
) -> str | None:
    """Why an inspection operation cannot be applied, found before any write.

    ``native_submit`` is set for a protocol-3 operation, which says whether it submits
    in its lifecycle actions; otherwise ``payload.status`` says (the earlier shape).
    """
    payload = operation.payload
    requested = payload.get("status")
    if native_submit is None and requested not in (None, "DRAFT", "SUBMITTED"):
        return "status can only be DRAFT or SUBMITTED"
    submitting = (
        native_submit if native_submit is not None else requested == "SUBMITTED"
    )
    try:
        result = existing.result if existing is not None else None
        if "result" in payload:
            result = validate_inspection_result(
                _optional_string_payload(operation, "result")
            )
        stored = existing.pressure_test if existing is not None else None
        measurements = stored.measurements if stored is not None else None
        hold_seconds = stored.hold_time_seconds if stored is not None else 0
        pressure = payload.get("pressure_test")
        if isinstance(pressure, dict):
            measurements = _measurements_payload(pressure)
            hold = pressure.get("hold_time_seconds")
            if isinstance(hold, int) and not isinstance(hold, bool):
                hold_seconds = hold
            minutes = (measurements or {}).get("test_duration_minutes")
            if minutes is not None and hold_seconds != minutes * 60:
                raise MeasurementsError(
                    "test_duration_minutes must match hold_time_seconds"
                )
        if submitting:
            if stored is None and not isinstance(pressure, dict):
                return "Inspection is incomplete: " + PRESSURE_TEST_MISSING
            gaps = missing_for_submission(
                measurements, result, hold_time_seconds=hold_seconds
            )
            if gaps:
                return "Inspection is incomplete: " + ", ".join(gaps)
    except MeasurementsError as exc:
        return str(exc)
    return None


def _require_matching_duration(
    measurements: dict[str, Any] | None, hold_seconds: int
) -> None:
    minutes = (measurements or {}).get("test_duration_minutes")
    if minutes is not None and hold_seconds != minutes * 60:
        raise MeasurementsError("test_duration_minutes must match hold_time_seconds")
