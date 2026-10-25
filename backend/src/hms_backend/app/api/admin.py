from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy.sql import Select
from uuid6 import uuid7

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.api.schemas import (
    AuditEventListResponse,
    AuditEventRead,
    DeviceListResponse,
    DeviceRead,
    DeviceUpdate,
    TemporaryPasswordResult,
    UserCreate,
    UserCreateResult,
    UserListResponse,
    UserRead,
    UserUpdate,
)
from hms_backend.app.core.audit import (
    append_audit_event,
    normalise_for_json,
    redact_sensitive,
)
from hms_backend.app.core.config import settings
from hms_backend.app.core.passwords import (
    generate_temporary_password,
    hash_password,
)
from hms_backend.app.core.rbac import Permission, Principal, Role, require_permission
from hms_backend.app.core.repository import record_create, record_update, soft_delete
from hms_backend.app.models.foundation import AuditEvent, Device
from hms_backend.app.modules.identity.browser_auth import BrowserAuthService
from hms_backend.app.modules.identity.models import (
    AccountStatus,
    MfaRecoveryCode,
    User,
    UserCustomerAccess,
)
from hms_backend.app.modules.identity.user_admin import (
    PrivilegeError,
    ensure_can_change_role,
    ensure_can_manage_role,
    ensure_recent_auth,
    normalise_customer_ids,
)
from hms_backend.app.modules.notifications.enums import NotificationCategory
from hms_backend.app.modules.notifications.outbox import emit_event

router = APIRouter(prefix="/admin")

_auth_service = BrowserAuthService()

SessionDep = Annotated[AsyncSession, Depends(get_session)]
PrincipalDep = Annotated[Principal, Depends(get_current_principal)]
LimitParam = Annotated[int, Query(ge=1, le=100)]
OffsetParam = Annotated[int, Query(ge=0)]


def _require_admin(principal: Principal, permission: Permission) -> None:
    try:
        require_permission(principal, permission)
    except PermissionError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc


def _guard(action: Any, *args: Any, **kwargs: Any) -> Any:
    """Run a user_admin rule, turning a PrivilegeError into a 403."""
    try:
        return action(*args, **kwargs)
    except PrivilegeError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)
        ) from exc


def _require_recent_auth(principal: Principal) -> None:
    """Require a recent sign-in for privileged actions. Only enforced for
    token-based identities; dev-header principals (local only) carry no
    ``auth_time`` and are exempt."""
    if principal.auth_time is None:
        return
    try:
        ensure_recent_auth(
            principal.auth_time,
            now=datetime.now(UTC),
            max_age_seconds=settings.auth_browser_reauth_max_age_seconds,
        )
    except PrivilegeError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)
        ) from exc


def _security_snapshot(user: User) -> dict[str, object | None]:
    """Redacted audit view of a user's security state (never secret material)."""
    return {
        "account_status": user.account_status,
        "must_change_password": user.must_change_password,
        "mfa_enabled": user.mfa_enabled,
        "role": user.role,
        "locked_until": normalise_for_json(user.locked_until),
    }


def _apply_sort(
    statement: Select[Any],
    model: type[Any],
    sort: str | None,
    allowed_fields: frozenset[str],
    *,
    default: str,
) -> Select[Any]:
    requested_sort = sort or default
    descending = requested_sort.startswith("-")
    field_name = requested_sort[1:] if descending else requested_sort
    if field_name not in allowed_fields:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported sort field: {field_name}",
        )

    sort_column = getattr(model, field_name)
    return statement.order_by(sort_column.desc() if descending else sort_column.asc())


def _clean_optional(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _role_value(value: str) -> str:
    try:
        return Role(value).value
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported HMS role: {value}",
        ) from exc


async def _count(session: AsyncSession, statement: Select[Any]) -> int:
    return await session.scalar(
        select(func.count()).select_from(statement.order_by(None).subquery())
    ) or 0


@router.get("/users", response_model=UserListResponse)
async def list_users(
    session: SessionDep,
    principal: PrincipalDep,
    search: str | None = None,
    sort: str | None = None,
    limit: LimitParam = 50,
    offset: OffsetParam = 0,
    after: Annotated[str | None, Query(min_length=1, max_length=320)] = None,
) -> UserListResponse:
    _require_admin(principal, Permission.USER_ADMIN)
    # Keyset paging: `after` is the email of the last user already read. Email is
    # unique, so it is a total order on its own, and unlike an offset it stays correct
    # when users before the cursor (or the cursor user itself) are removed mid-walk.
    if after is not None and (offset != 0 or (sort or "email") != "email"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="after requires sort=email and offset=0",
        )

    statement = select(User).where(User.deleted_at.is_(None))
    if search:
        search_pattern = f"%{search.lower()}%"
        statement = statement.where(
            or_(
                func.lower(User.oidc_subject).like(search_pattern),
                func.lower(User.email).like(search_pattern),
                func.lower(User.first_name).like(search_pattern),
                func.lower(User.last_name).like(search_pattern),
                func.lower(User.role).like(search_pattern),
            )
        )
    total = await _count(session, statement)
    if after is not None:
        statement = statement.where(User.email > after)
    statement = _apply_sort(
        statement,
        User,
        sort,
        frozenset({"email", "oidc_subject", "role", "created_at", "updated_at"}),
        default="email",
    ).options(selectinload(User.customer_accesses)).limit(limit).offset(offset)
    users = (await session.scalars(statement)).all()
    resumable = (sort or "email") == "email" and len(users) == limit
    next_after = users[-1].email if resumable else None
    return UserListResponse(
        total=total,
        limit=limit,
        offset=offset,
        items=[_user_read(user) for user in users],
        # Only the unique email order can be resumed from; a full page may be the last
        # one, so the client then gets one short or empty page and stops.
        next_after=next_after,
    )


@router.post(
    "/users",
    response_model=UserCreateResult,
    status_code=status.HTTP_201_CREATED,
)
async def create_user(
    payload: UserCreate,
    session: SessionDep,
    principal: PrincipalDep,
) -> UserCreateResult:
    _require_admin(principal, Permission.USER_ADMIN)

    role = Role(_role_value(payload.role))
    _guard(ensure_can_manage_role, principal.roles, role)
    scoped = _guard(
        normalise_customer_ids, role, _payload_customer_ids(payload)
    )

    email = payload.email.strip().lower()
    # Local users get a server-generated subject; operators never invent one.
    oidc_subject = (payload.oidc_subject or "").strip() or f"local:{uuid7()}"
    existing = await session.scalar(
        select(User).where(
            or_(User.oidc_subject == oidc_subject, func.lower(User.email) == email)
        )
    )
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="User OIDC subject or email already exists",
        )

    temporary_password = generate_temporary_password()
    user = User(
        oidc_subject=oidc_subject,
        email=email,
        first_name=_clean_optional(payload.first_name),
        last_name=_clean_optional(payload.last_name),
        role=role.value,
        customer_id=scoped[0] if scoped else None,
        customer_accesses=[],
        password_hash=hash_password(temporary_password),
        must_change_password=True,
        account_status=AccountStatus.ACTIVE.value,
    )
    session.add(user)
    await record_create(
        session,
        user,
        actor_id=principal.user_id,
        action="user.created",
    )
    await _replace_customer_accesses(session, user, scoped, actor_id=principal.user_id)
    await emit_event(
        session,
        category=NotificationCategory.USER_INVITATION,
        aggregate_type="user",
        aggregate_id=user.id,
        payload={
            "user_id": user.id,
            "email": user.email,
            "link": f"{settings.public_base_url.rstrip('/')}/activate",
        },
    )
    await session.commit()
    # The plaintext temporary password is returned exactly once, here.
    return UserCreateResult(
        user=_user_read(user), temporary_password=temporary_password
    )


@router.patch("/users/{user_id}", response_model=UserRead)
async def update_user(
    user_id: str,
    payload: UserUpdate,
    session: SessionDep,
    principal: PrincipalDep,
) -> UserRead:
    _require_admin(principal, Permission.USER_ADMIN)

    user = await _active_user(session, user_id)
    current_role = Role(user.role)
    _guard(ensure_can_manage_role, principal.roles, current_role)
    before = user.to_audit_dict()
    updates = payload.model_fields_set
    security_change = False
    effective_role = current_role

    if "role" in updates and payload.role is not None:
        effective_role = Role(_role_value(payload.role))
        if effective_role is not current_role:
            _require_recent_auth(principal)
            _guard(
                ensure_can_change_role,
                principal.roles,
                current=current_role,
                new=effective_role,
            )
            user.role = effective_role.value
            security_change = True
    if "email" in updates and payload.email is not None:
        new_email = payload.email.strip().lower()
        if new_email != user.email:
            _require_recent_auth(principal)
            user.email = new_email
            security_change = True
    if "first_name" in updates:
        user.first_name = _clean_optional(payload.first_name)
    if "last_name" in updates:
        user.last_name = _clean_optional(payload.last_name)

    # Re-validate customer scope against the effective role (covers a role change
    # to/from Customer User even when customer_id is not in this request).
    effective_customer_ids = (
        _payload_customer_ids(payload)
        if {"customer_id", "customer_ids"} & updates
        else _active_customer_ids(user)
    )
    scoped = _guard(
        normalise_customer_ids,
        effective_role,
        effective_customer_ids,
    )
    user.customer_id = scoped[0] if scoped else None

    await record_update(
        session,
        user,
        actor_id=principal.user_id,
        action="user.updated",
        before=before,
    )
    await _replace_customer_accesses(session, user, scoped, actor_id=principal.user_id)
    if security_change:
        await _auth_service.revoke_all_sessions(session, user.id)
    await session.commit()
    return _user_read(user)


@router.post("/users/{user_id}/disable", response_model=UserRead)
async def disable_user(
    user_id: str, session: SessionDep, principal: PrincipalDep
) -> UserRead:
    _require_admin(principal, Permission.USER_ADMIN)
    user = await _active_user(session, user_id)
    _guard(ensure_can_manage_role, principal.roles, Role(user.role))
    _require_recent_auth(principal)
    before = _security_snapshot(user)
    user.account_status = AccountStatus.DISABLED.value
    await _auth_service.revoke_all_sessions(session, user.id)
    await append_audit_event(
        session,
        actor_id=principal.user_id,
        action="user.disabled",
        entity="user",
        entity_id=user.id,
        before=before,
        after=_security_snapshot(user),
    )
    await session.commit()
    return _user_read(user)


@router.post("/users/{user_id}/enable", response_model=UserRead)
async def enable_user(
    user_id: str, session: SessionDep, principal: PrincipalDep
) -> UserRead:
    _require_admin(principal, Permission.USER_ADMIN)
    user = await _active_user(session, user_id)
    _guard(ensure_can_manage_role, principal.roles, Role(user.role))
    before = _security_snapshot(user)
    user.account_status = AccountStatus.ACTIVE.value
    user.locked_until = None
    user.failed_password_attempts = 0
    user.failed_mfa_attempts = 0
    await append_audit_event(
        session,
        actor_id=principal.user_id,
        action="user.enabled",
        entity="user",
        entity_id=user.id,
        before=before,
        after=_security_snapshot(user),
    )
    await session.commit()
    return _user_read(user)


@router.post("/users/{user_id}/unlock", response_model=UserRead)
async def unlock_user(
    user_id: str, session: SessionDep, principal: PrincipalDep
) -> UserRead:
    _require_admin(principal, Permission.USER_ADMIN)
    user = await _active_user(session, user_id)
    _guard(ensure_can_manage_role, principal.roles, Role(user.role))
    before = _security_snapshot(user)
    user.locked_until = None
    user.failed_password_attempts = 0
    if user.account_status == AccountStatus.LOCKED.value:
        user.account_status = AccountStatus.ACTIVE.value
    await append_audit_event(
        session,
        actor_id=principal.user_id,
        action="user.unlocked",
        entity="user",
        entity_id=user.id,
        before=before,
        after=_security_snapshot(user),
    )
    await session.commit()
    return _user_read(user)


@router.post(
    "/users/{user_id}/password-reset", response_model=TemporaryPasswordResult
)
async def reset_user_password(
    user_id: str, session: SessionDep, principal: PrincipalDep
) -> TemporaryPasswordResult:
    _require_admin(principal, Permission.USER_ADMIN)
    user = await _active_user(session, user_id)
    _guard(ensure_can_manage_role, principal.roles, Role(user.role))
    _require_recent_auth(principal)
    temporary_password = generate_temporary_password()
    user.password_hash = hash_password(temporary_password)
    user.must_change_password = True
    await _auth_service.revoke_all_sessions(session, user.id)
    await append_audit_event(
        session,
        actor_id=principal.user_id,
        action="user.password_reset",
        entity="user",
        entity_id=user.id,
        before=None,
        after={"must_change_password": True},
    )
    await session.commit()
    return TemporaryPasswordResult(
        user_id=user.id, temporary_password=temporary_password
    )


@router.post("/users/{user_id}/mfa-reset", response_model=UserRead)
async def reset_user_mfa(
    user_id: str, session: SessionDep, principal: PrincipalDep
) -> UserRead:
    _require_admin(principal, Permission.USER_ADMIN)
    user = await _active_user(session, user_id)
    _guard(ensure_can_manage_role, principal.roles, Role(user.role))
    _require_recent_auth(principal)
    before = _security_snapshot(user)
    user.mfa_enabled = False
    user.mfa_secret_ciphertext = None
    user.mfa_secret_key_version = None
    user.mfa_last_accepted_step = None
    await session.execute(
        delete(MfaRecoveryCode).where(MfaRecoveryCode.user_id == user.id)
    )
    await _auth_service.revoke_all_sessions(session, user.id)
    await append_audit_event(
        session,
        actor_id=principal.user_id,
        action="user.mfa_reset",
        entity="user",
        entity_id=user.id,
        before=before,
        after=_security_snapshot(user),
    )
    await session.commit()
    return _user_read(user)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: str,
    session: SessionDep,
    principal: PrincipalDep,
) -> Response:
    _require_admin(principal, Permission.USER_ADMIN)

    user = await _active_user(session, user_id)
    await soft_delete(
        session,
        user,
        actor_id=principal.user_id,
        action="user.deleted",
    )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/devices", response_model=DeviceListResponse)
async def list_devices(
    session: SessionDep,
    principal: PrincipalDep,
    search: str | None = None,
    sort: str | None = None,
    limit: LimitParam = 50,
    offset: OffsetParam = 0,
) -> DeviceListResponse:
    _require_admin(principal, Permission.DEVICE_ADMIN)

    statement = select(Device)
    if search:
        search_pattern = f"%{search.lower()}%"
        statement = statement.where(
            or_(
                func.lower(Device.device_id).like(search_pattern),
                func.lower(Device.user_id).like(search_pattern),
                func.lower(Device.platform).like(search_pattern),
                func.lower(Device.app_version).like(search_pattern),
            )
        )
    total = await _count(session, statement)
    statement = _apply_sort(
        statement,
        Device,
        sort,
        frozenset({"device_id", "user_id", "platform", "last_sync_at"}),
        default="device_id",
    ).limit(limit).offset(offset)
    devices = (await session.scalars(statement)).all()
    return DeviceListResponse(
        total=total,
        limit=limit,
        offset=offset,
        items=[_device_read(device) for device in devices],
    )


@router.patch("/devices/{device_id}", response_model=DeviceRead)
async def update_device(
    device_id: str,
    payload: DeviceUpdate,
    session: SessionDep,
    principal: PrincipalDep,
) -> DeviceRead:
    _require_admin(principal, Permission.DEVICE_ADMIN)

    device = await session.get(Device, device_id)
    if device is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Device not found",
        )

    before = _device_audit_dict(device)
    updates = payload.model_fields_set
    if "offline_window_days" in updates and payload.offline_window_days is not None:
        if payload.offline_window_days < 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="offline_window_days must be greater than zero",
            )
        device.offline_window_days = payload.offline_window_days
    if "revoked" in updates and payload.revoked is not None:
        device.revoked = payload.revoked

    await append_audit_event(
        session,
        actor_id=principal.user_id,
        action="device.updated",
        entity="Device",
        entity_id=device.device_id,
        before=before,
        after=_device_audit_dict(device),
    )
    # Security event when a device is newly revoked (it wipes on next sync).
    if device.revoked and not before.get("revoked"):
        await emit_event(
            session,
            category=NotificationCategory.DEVICE_REVOKED,
            aggregate_type="device",
            aggregate_id=device.device_id,
            payload={
                "user_id": device.user_id,
                "device_label": f"{device.platform} ({device.device_id})",
                "link": f"{settings.public_base_url.rstrip('/')}",
            },
        )
    await session.commit()
    return _device_read(device)


@router.get("/audit-events", response_model=AuditEventListResponse)
async def list_audit_events(
    session: SessionDep,
    principal: PrincipalDep,
    entity: str | None = None,
    actor_id: str | None = None,
    action: str | None = None,
    search: str | None = None,
    sort: str | None = None,
    limit: LimitParam = 50,
    offset: OffsetParam = 0,
) -> AuditEventListResponse:
    _require_admin(principal, Permission.AUDIT_READ)

    statement = select(AuditEvent)
    if entity:
        statement = statement.where(AuditEvent.entity == entity)
    if actor_id:
        statement = statement.where(AuditEvent.actor_id == actor_id)
    if action:
        statement = statement.where(AuditEvent.action == action)
    if search:
        search_pattern = f"%{search.lower()}%"
        statement = statement.where(
            or_(
                func.lower(AuditEvent.actor_id).like(search_pattern),
                func.lower(AuditEvent.action).like(search_pattern),
                func.lower(AuditEvent.entity).like(search_pattern),
                func.lower(AuditEvent.entity_id).like(search_pattern),
            )
        )

    total = await _count(session, statement)
    statement = _apply_sort(
        statement,
        AuditEvent,
        sort,
        frozenset({"sequence", "timestamp", "actor_id", "action", "entity"}),
        default="-sequence",
    ).limit(limit).offset(offset)
    events = (await session.scalars(statement)).all()
    return AuditEventListResponse(
        total=total,
        limit=limit,
        offset=offset,
        items=[_audit_event_read(event) for event in events],
    )


async def _active_user(session: AsyncSession, user_id: str) -> User:
    user = await session.scalar(
        select(User)
        .options(selectinload(User.customer_accesses))
        .where(User.id == user_id, User.deleted_at.is_(None))
    )
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )
    return user


def _user_read(user: User) -> UserRead:
    return UserRead(
        id=user.id,
        oidc_subject=user.oidc_subject,
        email=user.email,
        first_name=user.first_name,
        last_name=user.last_name,
        role=user.role,
        customer_id=user.customer_id,
        customer_ids=_active_customer_ids(user),
        created_at=user.created_at,
        updated_at=user.updated_at,
    )


def _active_customer_ids(user: User) -> list[str]:
    customer_ids = [
        access.customer_id
        for access in user.customer_accesses
        if access.deleted_at is None
    ]
    if user.customer_id and user.customer_id not in customer_ids:
        customer_ids.insert(0, user.customer_id)
    return customer_ids


def _payload_customer_ids(payload: UserCreate | UserUpdate) -> list[str]:
    customer_ids = payload.customer_ids
    if customer_ids is None:
        return [payload.customer_id] if payload.customer_id else []
    if payload.customer_id and payload.customer_id not in customer_ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="customer_id must be included in customer_ids",
        )
    return customer_ids


async def _replace_customer_accesses(
    session: AsyncSession,
    user: User,
    customer_ids: list[str],
    *,
    actor_id: str,
) -> None:
    accesses = {access.customer_id: access for access in user.customer_accesses}
    active_accesses = {
        customer_id: access
        for customer_id, access in accesses.items()
        if access.deleted_at is None
    }
    desired = set(customer_ids)
    for customer_id, access in active_accesses.items():
        if customer_id not in desired:
            await soft_delete(
                session,
                access,
                actor_id=actor_id,
                action="user.customer_access_removed",
            )
    for customer_id in customer_ids:
        if customer_id in active_accesses:
            continue
        revived_access = accesses.get(customer_id)
        if revived_access is None:
            access = UserCustomerAccess(user_id=user.id, customer_id=customer_id)
            user.customer_accesses.append(access)
            await record_create(
                session,
                access,
                actor_id=actor_id,
                action="user.customer_access_granted",
            )
            continue
        before = revived_access.to_audit_dict()
        revived_access.deleted_at = None
        await record_update(
            session,
            revived_access,
            actor_id=actor_id,
            action="user.customer_access_granted",
            before=before,
        )


def _device_read(device: Device) -> DeviceRead:
    return DeviceRead(
        device_id=device.device_id,
        user_id=device.user_id,
        platform=device.platform,
        app_version=device.app_version,
        last_sync_at=device.last_sync_at,
        offline_window_days=device.offline_window_days,
        revoked=device.revoked,
    )


def _device_audit_dict(device: Device) -> dict[str, object | None]:
    return {
        "device_id": device.device_id,
        "user_id": device.user_id,
        "platform": device.platform,
        "app_version": device.app_version,
        "last_sync_at": normalise_for_json(device.last_sync_at),
        "offline_window_days": device.offline_window_days,
        "revoked": device.revoked,
    }


def _audit_event_read(event: AuditEvent) -> AuditEventRead:
    return AuditEventRead(
        sequence=event.sequence,
        actor_id=event.actor_id,
        action=event.action,
        entity=event.entity,
        entity_id=event.entity_id,
        # Stored rows are immutable (hash-chained); redact on the way out so rows
        # written before write-time redaction existed never expose credentials.
        before=redact_sensitive(event.before),
        after=redact_sensitive(event.after),
        timestamp=event.timestamp,
        hash=event.hash,
    )
