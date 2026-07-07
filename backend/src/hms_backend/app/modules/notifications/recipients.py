"""Recipient resolution (spec §5).

Recipients are derived from the event category + payload and role mapping, never
hard-coded addresses. Customer-facing events go to the customer's notification
contacts plus the BAT account owner (modelled here as HMS admins); inspection
events go to the assigned reviewer/inspector.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.core.rbac import Role
from hms_backend.app.modules.customers.models import CustomerContact
from hms_backend.app.modules.identity.models import User
from hms_backend.app.modules.notifications.enums import (
    NotificationCategory,
    RecipientType,
)

_Cat = NotificationCategory

# Categories whose recipients include the customer's notification contacts.
_CUSTOMER_FACING = {
    _Cat.RETEST_ADVANCE,
    _Cat.RETEST_DUE,
    _Cat.RETEST_OVERDUE,
    _Cat.SERVICE_BOOKED,
    _Cat.ASSET_APPROACHING_CONDEMNATION,
    _Cat.ASSET_CONDEMNED,
    _Cat.INSPECTION_FAILED,
    _Cat.CERTIFICATE_ISSUED,
    _Cat.CERTIFICATE_REVOKED,
}
# Categories that also notify the BAT account owner (HMS admins).
_ACCOUNT_OWNER = _CUSTOMER_FACING | {_Cat.ASSET_RETIRED}


@dataclass(frozen=True)
class ResolvedRecipient:
    recipient_type: RecipientType
    recipient_id: str
    email: str | None
    phone_e164: str | None
    email_verified: bool
    phone_verified: bool
    customer_id: str | None = None

    @property
    def party_type(self) -> str:
        return self.recipient_type.value


def _from_user(user: User) -> ResolvedRecipient:
    return ResolvedRecipient(
        recipient_type=RecipientType.USER,
        recipient_id=user.id,
        email=user.email,
        phone_e164=user.phone_e164,
        email_verified=user.email_verified,
        phone_verified=user.phone_verified,
        customer_id=user.customer_id,
    )


def _from_contact(contact: CustomerContact) -> ResolvedRecipient:
    return ResolvedRecipient(
        recipient_type=RecipientType.CUSTOMER_CONTACT,
        recipient_id=contact.id,
        email=contact.email,
        phone_e164=contact.phone_e164,
        email_verified=contact.email_verified,
        phone_verified=contact.phone_verified,
        customer_id=contact.customer_id,
    )


async def _users_by_role(session: AsyncSession, role: Role) -> list[User]:
    rows = await session.scalars(
        select(User).where(User.role == role.value, User.deleted_at.is_(None))
    )
    return list(rows.all())


async def _user_by_id(session: AsyncSession, user_id: str) -> User | None:
    if not user_id:
        return None
    user: User | None = await session.scalar(
        select(User).where(
            or_(User.id == user_id, User.oidc_subject == user_id),
            User.deleted_at.is_(None),
        )
    )
    return user


async def _customer_contacts(
    session: AsyncSession, customer_id: str, *, retest_only: bool
) -> list[CustomerContact]:
    stmt = select(CustomerContact).where(
        CustomerContact.customer_id == customer_id,
        CustomerContact.deleted_at.is_(None),
    )
    if retest_only:
        stmt = stmt.where(CustomerContact.receives_retest_reminders.is_(True))
    rows = await session.scalars(stmt)
    return list(rows.all())


async def resolve_recipients(
    session: AsyncSession,
    category: NotificationCategory,
    payload: dict[str, Any],
) -> list[ResolvedRecipient]:
    """Return the de-duplicated recipient set for an event."""
    recipients: dict[tuple[str, str], ResolvedRecipient] = {}

    def add(rec: ResolvedRecipient) -> None:
        recipients[(rec.recipient_type.value, rec.recipient_id)] = rec

    customer_id = payload.get("customer_id")

    if category in _CUSTOMER_FACING and customer_id:
        retest_only = category in {
            _Cat.RETEST_ADVANCE,
            _Cat.RETEST_DUE,
            _Cat.RETEST_OVERDUE,
        }
        for contact in await _customer_contacts(
            session, customer_id, retest_only=retest_only
        ):
            add(_from_contact(contact))

    if category in _ACCOUNT_OWNER:
        for user in await _users_by_role(session, Role.HMS_ADMIN):
            add(_from_user(user))

    # Inspection routing.
    if category is _Cat.INSPECTION_SUBMITTED:
        reviewer_id = payload.get("reviewer_user_id")
        reviewer = await _user_by_id(session, reviewer_id) if reviewer_id else None
        if reviewer is not None:
            add(_from_user(reviewer))
        else:
            for user in await _users_by_role(session, Role.REVIEWER):
                add(_from_user(user))
    elif category in {_Cat.INSPECTION_APPROVED, _Cat.INSPECTION_REJECTED}:
        inspector = await _user_by_id(session, payload.get("inspector_user_id", ""))
        if inspector is not None:
            add(_from_user(inspector))
    elif category is _Cat.INSPECTION_FAILED:
        reviewer = await _user_by_id(session, payload.get("reviewer_user_id", ""))
        if reviewer is not None:
            add(_from_user(reviewer))

    return list(recipients.values())
