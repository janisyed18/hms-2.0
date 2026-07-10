"""Notification preference centre, verification, unsubscribe, and admin log.

* Per-category channel preferences (N-04) and one-click unsubscribe (N-10).
* SMS phone verification via one-time code (N-04).
* In-app feed for the current user and an admin notification log (N-09).
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import Select, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.api.schemas import (
    MessageResponse,
    NotificationListResponse,
    NotificationPreferenceItem,
    NotificationPreferenceListResponse,
    NotificationPreferenceUpdate,
    NotificationRead,
    PhoneVerificationConfirm,
    PhoneVerificationRequest,
)
from hms_backend.app.core.config import settings
from hms_backend.app.core.rbac import Permission, Principal, require_permission
from hms_backend.app.modules.identity.models import User
from hms_backend.app.modules.notifications.enums import (
    NotificationCategory,
    NotificationChannel,
    RecipientType,
)
from hms_backend.app.modules.notifications.models import (
    Notification,
    NotificationPreference,
    PhoneVerification,
)
from hms_backend.app.modules.notifications.service import apply_delivery_receipt
from hms_backend.app.modules.notifications.webhooks import parse_receipts

router = APIRouter(tags=["notifications"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
PrincipalDep = Annotated[Principal, Depends(get_current_principal)]
LimitParam = Annotated[int, Query(ge=1, le=100)]
OffsetParam = Annotated[int, Query(ge=0)]

_USER = RecipientType.USER.value


def _code_hash(code: str) -> str:
    return hashlib.sha256(f"hms-otp:{code}".encode()).hexdigest()


def _valid_category(value: str) -> str:
    try:
        return NotificationCategory(value).value
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown notification category: {value}",
        ) from exc


def _valid_channel(value: str) -> str:
    try:
        return NotificationChannel(value).value
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown notification channel: {value}",
        ) from exc


async def _current_user(session: AsyncSession, principal: Principal) -> User:
    user = await session.scalar(
        select(User).where(
            or_(User.oidc_subject == principal.user_id, User.id == principal.user_id),
            User.deleted_at.is_(None),
        )
    )
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unknown HMS user identity",
        )
    return user


# --- Preference centre ----------------------------------------------------------


@router.get(
    "/notifications/preferences", response_model=NotificationPreferenceListResponse
)
async def list_preferences(
    session: SessionDep, principal: PrincipalDep
) -> NotificationPreferenceListResponse:
    user = await _current_user(session, principal)
    rows = (
        await session.scalars(
            select(NotificationPreference).where(
                NotificationPreference.party_type == _USER,
                NotificationPreference.party_id == user.id,
            )
        )
    ).all()
    return NotificationPreferenceListResponse(
        items=[
            NotificationPreferenceItem(
                category=row.category, channel=row.channel, opted_in=row.opted_in
            )
            for row in rows
        ]
    )


@router.put(
    "/notifications/preferences", response_model=NotificationPreferenceItem
)
async def update_preference(
    payload: NotificationPreferenceUpdate,
    session: SessionDep,
    principal: PrincipalDep,
) -> NotificationPreferenceItem:
    category = _valid_category(payload.category)
    channel = _valid_channel(payload.channel)
    user = await _current_user(session, principal)
    pref = await _upsert_pref(
        session, _USER, user.id, category, channel, payload.opted_in
    )
    await session.commit()
    return NotificationPreferenceItem(
        category=pref.category, channel=pref.channel, opted_in=pref.opted_in
    )


async def _upsert_pref(
    session: AsyncSession,
    party_type: str,
    party_id: str,
    category: str,
    channel: str,
    opted_in: bool,
) -> NotificationPreference:
    pref = await session.scalar(
        select(NotificationPreference).where(
            NotificationPreference.party_type == party_type,
            NotificationPreference.party_id == party_id,
            NotificationPreference.category == category,
            NotificationPreference.channel == channel,
        )
    )
    if pref is None:
        pref = NotificationPreference(
            party_type=party_type,
            party_id=party_id,
            category=category,
            channel=channel,
            opted_in=opted_in,
        )
        session.add(pref)
    else:
        pref.opted_in = opted_in
    return pref


@router.get("/notifications/unsubscribe", response_model=MessageResponse)
async def unsubscribe(
    session: SessionDep,
    party_type: str,
    party_id: str,
    category: str,
) -> MessageResponse:
    """Public one-click unsubscribe from a non-essential category (N-10)."""
    category = _valid_category(category)
    await _upsert_pref(
        session,
        party_type,
        party_id,
        category,
        NotificationChannel.EMAIL.value,
        opted_in=False,
    )
    await session.commit()
    return MessageResponse(
        message=(
            f"You have been unsubscribed from {category} email updates. "
            "Essential safety and account messages are still delivered."
        )
    )


# --- Phone verification for SMS (N-04) ------------------------------------------


@router.post("/notifications/phone/verify/request", response_model=MessageResponse)
async def request_phone_verification(
    payload: PhoneVerificationRequest,
    session: SessionDep,
    principal: PrincipalDep,
) -> MessageResponse:
    phone = payload.phone_e164.strip()
    if not phone.startswith("+") or not phone[1:].isdigit():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Phone must be in E.164 format, e.g. +61400000000",
        )
    user = await _current_user(session, principal)
    code = f"{secrets.randbelow(1_000_000):06d}"
    session.add(
        PhoneVerification(
            party_type=_USER,
            party_id=user.id,
            phone_e164=phone,
            code_hash=_code_hash(code),
            expires_at=datetime.now(UTC)
            + timedelta(seconds=settings.phone_verification_ttl_seconds),
        )
    )
    user.phone_e164 = phone
    user.phone_verified = False
    await session.commit()
    # In console mode the code is logged by the SMS adapter; return it in the
    # response only for non-production convenience.
    detail = "Verification code sent by SMS."
    if settings.notification_channel_mode != "live":
        detail += f" (dev code: {code})"
    return MessageResponse(message=detail)


@router.post("/notifications/phone/verify/confirm", response_model=MessageResponse)
async def confirm_phone_verification(
    payload: PhoneVerificationConfirm,
    session: SessionDep,
    principal: PrincipalDep,
) -> MessageResponse:
    now = datetime.now(UTC)
    user = await _current_user(session, principal)
    verification = await session.scalar(
        select(PhoneVerification)
        .where(
            PhoneVerification.party_type == _USER,
            PhoneVerification.party_id == user.id,
            PhoneVerification.verified_at.is_(None),
            PhoneVerification.expires_at > now,
        )
        .order_by(PhoneVerification.created_at.desc())
    )
    if verification is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No active verification; request a new code.",
        )
    verification.attempts += 1
    if verification.attempts > settings.phone_verification_max_attempts:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts; request a new code.",
        )
    if verification.code_hash != _code_hash(payload.code.strip()):
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Incorrect code."
        )

    verification.verified_at = now
    user.phone_e164 = verification.phone_e164
    user.phone_verified = True
    await session.commit()
    return MessageResponse(message="Phone number verified. SMS can now be enabled.")


# --- Feeds ----------------------------------------------------------------------


@router.get("/notifications/me", response_model=NotificationListResponse)
async def my_notifications(
    session: SessionDep,
    principal: PrincipalDep,
    limit: LimitParam = 20,
    offset: OffsetParam = 0,
) -> NotificationListResponse:
    user = await _current_user(session, principal)
    base = select(Notification).where(
        Notification.recipient_type == _USER,
        Notification.recipient_id == user.id,
        Notification.deleted_at.is_(None),
    )
    return await _paginate(session, base, limit, offset)


@router.get("/admin/notifications", response_model=NotificationListResponse)
async def admin_notifications(
    session: SessionDep,
    principal: PrincipalDep,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    category: str | None = None,
    customer_id: str | None = None,
    recipient_id: str | None = None,
    limit: LimitParam = 50,
    offset: OffsetParam = 0,
) -> NotificationListResponse:
    try:
        require_permission(principal, Permission.USER_ADMIN)
    except PermissionError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)
        ) from exc

    base = select(Notification).where(Notification.deleted_at.is_(None))
    if status_filter:
        base = base.where(Notification.status == status_filter)
    if category:
        base = base.where(Notification.category == category)
    if customer_id:
        base = base.where(Notification.customer_id == customer_id)
    if recipient_id:
        base = base.where(Notification.recipient_id == recipient_id)
    return await _paginate(session, base, limit, offset)


async def _paginate(
    session: AsyncSession,
    base: Select[tuple[Notification]],
    limit: int,
    offset: int,
) -> NotificationListResponse:
    total = (
        await session.scalar(
            select(func.count()).select_from(base.order_by(None).subquery())
        )
    ) or 0
    rows = (
        await session.scalars(
            base.order_by(Notification.created_at.desc()).offset(offset).limit(limit)
        )
    ).all()
    return NotificationListResponse(
        total=total,
        limit=limit,
        offset=offset,
        items=[_read(n) for n in rows],
    )


# --- Provider delivery webhooks (N-06) ------------------------------------------


def _check_webhook_secret(request: Request, token: str | None) -> None:
    secret = settings.notification_webhook_secret
    if not secret:
        return  # open in dev
    provided = token or request.headers.get("X-HMS-Webhook-Secret")
    if provided != secret:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Invalid webhook secret"
        )


@router.post("/notifications/webhooks/{provider}")
async def delivery_webhook(
    provider: str,
    request: Request,
    session: SessionDep,
    token: str | None = None,
) -> dict[str, int]:
    """Update delivery status from a provider callback (Twilio / SES-SNS / generic).

    Matches notifications by ``provider_message_id``. Always returns 2xx so
    providers do not retry indefinitely.
    """
    _check_webhook_secret(request, token)
    receipts = parse_receipts(provider.lower(), await request.body())
    updated = 0
    for provider_message_id, receipt_status in receipts:
        if await apply_delivery_receipt(
            session,
            provider_message_id=provider_message_id,
            status=receipt_status,
        ):
            updated += 1
    await session.commit()
    return {"updated": updated}


def _read(n: Notification) -> NotificationRead:
    return NotificationRead(
        id=n.id,
        event_ref=n.event_ref,
        category=n.category,
        tier=n.tier,
        channel=n.channel,
        recipient_type=n.recipient_type,
        recipient_id=n.recipient_id,
        recipient_address=n.recipient_address,
        subject=n.subject,
        body=n.body,
        status=n.status,
        attempts=n.attempts,
        provider_message_id=n.provider_message_id,
        error=n.error,
        customer_id=n.customer_id,
        asset_id=n.asset_id,
        created_at=n.created_at,
        sent_at=n.sent_at,
    )
