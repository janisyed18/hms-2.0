from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Select

from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.modules.inspections.models import (
    InspectionAppointment,
    InspectionAppointmentStatus,
    InspectionBooking,
    InspectionBookingAsset,
    InspectionBookingStatus,
)


def is_inspector_scoped(principal: Principal) -> bool:
    elevated = {Role.SUPER_ADMIN, Role.HMS_ADMIN, Role.REVIEWER, Role.ASSEMBLY}
    return Role.INSPECTOR in principal.roles and principal.roles.isdisjoint(elevated)


def assigned_bookings(principal: Principal) -> Select[tuple[str]]:
    return (
        select(InspectionBooking.id)
        .join(
            InspectionAppointment,
            InspectionAppointment.booking_id == InspectionBooking.id,
        )
        .where(
            InspectionBooking.inspector_user_id == principal.assignment_user_id,
            InspectionBooking.status == InspectionBookingStatus.APPROVED.value,
            InspectionBooking.deleted_at.is_(None),
            InspectionAppointment.status == InspectionAppointmentStatus.CONFIRMED.value,
            InspectionAppointment.deleted_at.is_(None),
        )
    )


def assigned_assets(principal: Principal) -> Select[tuple[str]]:
    return select(InspectionBookingAsset.asset_id).where(
        InspectionBookingAsset.booking_id.in_(assigned_bookings(principal)),
        InspectionBookingAsset.deleted_at.is_(None),
    )


async def lock_assigned_bookings(session: AsyncSession, principal: Principal) -> None:
    if is_inspector_scoped(principal):
        await session.scalars(
            select(InspectionBooking.id)
            .where(InspectionBooking.id.in_(assigned_bookings(principal)))
            .order_by(InspectionBooking.id)
            .with_for_update()
        )
