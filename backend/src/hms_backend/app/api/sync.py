from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Annotated, Any, Protocol, cast

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.api.sync_schemas import (
    SyncBootstrapResponse,
    SyncChangesResponse,
    SyncDeviceRead,
    SyncOperationResult,
    SyncOperationWrite,
    SyncPushRequest,
    SyncPushResponse,
    SyncRecordRead,
)
from hms_backend.app.core.audit import normalise_for_json
from hms_backend.app.core.config import settings
from hms_backend.app.core.rbac import (
    Permission,
    Principal,
    is_customer_scoped,
    require_permission,
)
from hms_backend.app.core.repository import record_create, record_update
from hms_backend.app.models.foundation import Device, IdempotencyKey, SyncChange
from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.certificates.models import Certificate
from hms_backend.app.modules.customers.models import (
    Customer,
    CustomerContact,
    CustomerLocation,
)
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionStatus,
    PressureTestResult,
)
from hms_backend.app.modules.notifications.enums import NotificationCategory
from hms_backend.app.modules.notifications.outbox import emit_event
from hms_backend.app.modules.products.models import Product, ProductPressureRating
from hms_backend.app.modules.reference.models import (
    AttachMethod,
    Coupling,
    CouplingAddOn,
    Material,
    NominalBore,
    Standard,
)
from hms_backend.app.modules.scheduling.models import RetestSchedule

router = APIRouter()

SessionDep = Annotated[AsyncSession, Depends(get_session)]
PrincipalDep = Annotated[Principal, Depends(get_current_principal)]
DeviceIdHeader = Annotated[str | None, Header(alias="X-HMS-Device-Id")]
DevicePlatformHeader = Annotated[str | None, Header(alias="X-HMS-Device-Platform")]
AppVersionHeader = Annotated[str | None, Header(alias="X-HMS-App-Version")]
LimitParam = Annotated[int, Query(ge=1, le=500)]


class SyncableRow(Protocol):
    id: str
    version: int
    deleted_at: datetime | None

    def to_audit_dict(self) -> dict[str, object | None]:
        ...


SYNC_MODELS: dict[str, type[Any]] = {
    "AttachMethod": AttachMethod,
    "Coupling": Coupling,
    "CouplingAddOn": CouplingAddOn,
    "Material": Material,
    "NominalBore": NominalBore,
    "Standard": Standard,
    "Product": Product,
    "ProductPressureRating": ProductPressureRating,
    "Customer": Customer,
    "CustomerLocation": CustomerLocation,
    "CustomerContact": CustomerContact,
    "Asset": Asset,
    "RetestSchedule": RetestSchedule,
    "Inspection": Inspection,
    "PressureTestResult": PressureTestResult,
    "Certificate": Certificate,
}

BOOTSTRAP_ENTITY_ORDER = [
    "AttachMethod",
    "Coupling",
    "CouplingAddOn",
    "Material",
    "NominalBore",
    "Standard",
    "Product",
    "ProductPressureRating",
    "Customer",
    "CustomerLocation",
    "CustomerContact",
    "Asset",
    "RetestSchedule",
    "Inspection",
    "PressureTestResult",
    "Certificate",
]

UNSCOPED_ENTITIES = {
    "AttachMethod",
    "Coupling",
    "CouplingAddOn",
    "Material",
    "NominalBore",
    "Standard",
    "Product",
    "ProductPressureRating",
}


@router.get("/sync/bootstrap", response_model=SyncBootstrapResponse)
async def sync_bootstrap(
    session: SessionDep,
    principal: PrincipalDep,
    device_id: DeviceIdHeader = None,
    platform: DevicePlatformHeader = None,
    app_version: AppVersionHeader = None,
) -> SyncBootstrapResponse:
    _require_sync_read(principal)
    device = await _upsert_sync_device(
        session,
        principal,
        device_id=device_id,
        platform=platform,
        app_version=app_version,
    )
    cursor = await _max_sync_seq(session)
    records = await _bootstrap_records(session, principal)
    await session.commit()
    return SyncBootstrapResponse(
        device=_device_read(device),
        cursor=cursor,
        records=records,
    )


@router.get("/sync/changes", response_model=SyncChangesResponse)
async def sync_changes(
    session: SessionDep,
    principal: PrincipalDep,
    since: Annotated[int, Query(ge=0)] = 0,
    limit: LimitParam = 100,
    device_id: DeviceIdHeader = None,
    platform: DevicePlatformHeader = None,
    app_version: AppVersionHeader = None,
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
    changes = await _visible_change_records(session, principal, scanned)
    cursor = scanned[-1].seq if scanned else await _max_sync_seq(session)
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
) -> SyncPushResponse:
    _require_sync_push(principal)
    await _upsert_sync_device(
        session,
        principal,
        device_id=device_id,
        platform=platform,
        app_version=app_version,
    )
    results: list[SyncOperationResult] = []
    for operation in payload.operations:
        results.append(await _apply_idempotent_operation(session, principal, operation))
    await session.commit()
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
    device = await session.get(Device, device_id)
    if device is None:
        device = Device(
            device_id=device_id,
            user_id=principal.user_id,
            platform=platform,
            app_version=app_version,
            offline_window_days=7,
            revoked=False,
        )
        session.add(device)
        # New device registration is a security event to the device owner.
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
    if device.revoked:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Sync device has been revoked",
        )
    device.user_id = principal.user_id
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


async def _bootstrap_records(
    session: AsyncSession,
    principal: Principal,
) -> list[SyncRecordRead]:
    records: list[SyncRecordRead] = []
    for entity_name in BOOTSTRAP_ENTITY_ORDER:
        model = SYNC_MODELS[entity_name]
        rows = (
            await session.scalars(
                select(model)
                .where(model.deleted_at.is_(None))
                .order_by(model.id)
            )
        ).all()
        for row in rows:
            sync_row = cast(SyncableRow, row)
            if await _row_visible(session, principal, entity_name, sync_row.id):
                records.append(
                    SyncRecordRead(
                        entity=entity_name,
                        entity_id=sync_row.id,
                        op="upsert",
                        version=sync_row.version,
                        payload=_row_payload(sync_row),
                    )
                )
    return records


async def _visible_change_records(
    session: AsyncSession,
    principal: Principal,
    changes: Sequence[SyncChange],
) -> list[SyncRecordRead]:
    records: list[SyncRecordRead] = []
    for change in changes:
        if change.entity not in SYNC_MODELS:
            continue
        if not await _row_visible(session, principal, change.entity, change.entity_id):
            continue
        row = await _get_sync_row(session, change.entity, change.entity_id)
        is_delete = (
            row is None
            or row.deleted_at is not None
            or change.op == "delete"
        )
        records.append(
            SyncRecordRead(
                seq=change.seq,
                entity=change.entity,
                entity_id=change.entity_id,
                op="delete" if is_delete else "upsert",
                version=change.version,
                changed_at=change.changed_at,
                payload=None if is_delete else _row_payload(cast(SyncableRow, row)),
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
    return cast(dict[str, Any], normalise_for_json(row.to_audit_dict()))


async def _row_visible(
    session: AsyncSession,
    principal: Principal,
    entity_name: str,
    entity_id: str,
) -> bool:
    if entity_name in UNSCOPED_ENTITIES:
        return True
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


async def _apply_idempotent_operation(
    session: AsyncSession,
    principal: Principal,
    operation: SyncOperationWrite,
) -> SyncOperationResult:
    existing_key = await session.get(IdempotencyKey, operation.idempotency_key)
    if existing_key is not None and existing_key.result_json is not None:
        return SyncOperationResult.model_validate(existing_key.result_json)

    result = await _apply_sync_operation(session, principal, operation)
    session.add(
        IdempotencyKey(
            key=operation.idempotency_key,
            result_json=result.model_dump(mode="json"),
        )
    )
    await session.flush()
    return result


async def _apply_sync_operation(
    session: AsyncSession,
    principal: Principal,
    operation: SyncOperationWrite,
) -> SyncOperationResult:
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

    inspection = Inspection(
        id=operation.entity_id,
        asset=asset,
        inspection_type=inspection_type,
        status=InspectionStatus.DRAFT.value,
        result=_optional_string_payload(operation, "result"),
        inspector_user_id=principal.user_id,
    )
    session.add(inspection)
    await record_create(
        session,
        inspection,
        actor_id=principal.user_id,
        action="inspection.created",
    )
    pressure_payload = operation.payload.get("pressure_test")
    if isinstance(pressure_payload, dict):
        await _create_pressure_test_from_sync(
            session,
            inspection=inspection,
            payload=pressure_payload,
            actor_id=principal.user_id,
        )
    return _applied(operation, inspection)


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
    if inspection.status != InspectionStatus.DRAFT.value:
        return _rejected(
            operation,
            "Only draft inspection pressure tests can be updated by sync push",
        )
    if inspection.pressure_test is not None:
        return _rejected(
            operation,
            "Inspection already has a pressure test result",
        )

    pressure_test = PressureTestResult(
        id=operation.entity_id,
        inspection=inspection,
        applied_pressure_kpa=_int_payload(operation.payload, "applied_pressure_kpa"),
        hold_time_seconds=_int_payload(operation.payload, "hold_time_seconds"),
        passed=_bool_payload(operation.payload, "passed"),
        measurements=_dict_payload(operation.payload, "measurements"),
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
    if pressure_test.inspection.status != InspectionStatus.DRAFT.value:
        return _rejected(
            operation,
            "Only draft inspection pressure tests can be updated by sync push",
        )

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
    if "measurements" in operation.payload:
        pressure_test.measurements = _dict_payload(
            operation.payload,
            "measurements",
        )
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
    if operation.base_version != inspection.version:
        return _conflict(operation, inspection)
    if inspection.status != InspectionStatus.DRAFT.value:
        return _rejected(
            operation,
            "Only draft inspections can be updated by sync push",
        )

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
    return _applied(operation, inspection)


async def _visible_asset_or_none(
    session: AsyncSession,
    principal: Principal,
    asset_id: str,
) -> Asset | None:
    asset = await session.get(Asset, asset_id)
    if asset is None or asset.deleted_at is not None:
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
        measurements=_dict_payload(payload, "measurements"),
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
    pressure_test.measurements = _dict_payload(payload, "measurements")
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


def _rejected(operation: SyncOperationWrite, reason: str) -> SyncOperationResult:
    return SyncOperationResult(
        op_id=operation.op_id,
        idempotency_key=operation.idempotency_key,
        entity=operation.entity,
        entity_id=operation.entity_id,
        status="rejected",
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
