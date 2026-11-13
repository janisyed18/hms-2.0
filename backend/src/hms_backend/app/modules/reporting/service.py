"""Metric definitions shared by Dashboard, Analytics and the escalation action.

Everything here is a *current snapshot* evaluated at one ``Reference`` (as-of instant
and organisation calendar date). Nothing in this module takes a reporting period: the
period selects activity (see ``activity.py``), never what is currently overdue.

Eligible fleet
    Visible assets that are not soft-deleted, belong to a live customer and are not
    DRAFT, CONDEMNED or RETIRED. ``Asset.lifecycle_status`` is otherwise left alone: its
    DUE/OVERDUE values are not maintained, so retest status comes from
    ``RetestSchedule.due_at``.

Retest status (mutually exclusive, exhaustive over the eligible fleet)
    unscheduled  no live retest schedule
    suspended    schedule SUSPENDED
    overdue      due_at <  today
    due_soon     today <= due_at <= today + 7
    on_track     due_at >  today + 7
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import and_, case, distinct, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Select
from sqlalchemy.sql.elements import ColumnElement

from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.certificates.models import Certificate, CertificateStatus
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.inspections.models import Inspection, InspectionStatus
from hms_backend.app.modules.reporting.periods import Reference
from hms_backend.app.modules.scheduling.models import (
    RetestSchedule,
    RetestScheduleStatus,
)

Scope = Callable[[Select[Any]], Select[Any]]

INELIGIBLE_LIFECYCLES = frozenset({"DRAFT", "CONDEMNED", "RETIRED"})


# --- shared predicates --------------------------------------------------------


def fleet_conditions() -> list[ColumnElement[bool]]:
    """Requires Asset and Customer in the FROM clause."""
    return [
        Asset.deleted_at.is_(None),
        Customer.deleted_at.is_(None),
        Asset.lifecycle_status.not_in(INELIGIBLE_LIFECYCLES),
    ]


def overdue_conditions(ref: Reference) -> list[ColumnElement[bool]]:
    """Requires RetestSchedule, Asset and Customer in the FROM clause."""
    return [
        RetestSchedule.deleted_at.is_(None),
        RetestSchedule.status != RetestScheduleStatus.SUSPENDED.value,
        RetestSchedule.due_at < ref.today,
        *fleet_conditions(),
    ]


def due_soon_conditions(ref: Reference) -> list[ColumnElement[bool]]:
    return [
        RetestSchedule.deleted_at.is_(None),
        RetestSchedule.status != RetestScheduleStatus.SUSPENDED.value,
        RetestSchedule.due_at >= ref.today,
        RetestSchedule.due_at <= ref.due_soon_end,
        *fleet_conditions(),
    ]


def _escalated_today(ref: Reference) -> ColumnElement[bool]:
    return and_(
        RetestSchedule.escalated_at >= ref.day_start,
        RetestSchedule.escalated_at < ref.day_end,
    )


def escalation_conditions(ref: Reference) -> list[ColumnElement[bool]]:
    """Schedules a manual escalation would notify: overdue, not escalated today."""
    return [
        *overdue_conditions(ref),
        or_(RetestSchedule.escalated_at.is_(None), ~_escalated_today(ref)),
    ]


def schedule_select(*columns: Any) -> Select[Any]:
    return (
        select(*columns)
        .select_from(RetestSchedule)
        .join(Asset, Asset.id == RetestSchedule.asset_id)
        .join(Customer, Customer.id == Asset.customer_id)
    )


async def _scalar_int(session: AsyncSession, statement: Select[Any]) -> int:
    return int(await session.scalar(statement) or 0)


# --- retest queue counts ------------------------------------------------------


@dataclass(frozen=True)
class RetestCounts:
    overdue_schedules: int
    overdue_assets: int
    overdue_escalated: int
    due_soon_assets: int
    escalation_eligible: int
    escalated_today: int


async def retest_counts(
    session: AsyncSession, scope: Scope, ref: Reference
) -> RetestCounts:
    overdue = overdue_conditions(ref)
    overdue_row = (
        await session.execute(
            scope(
                schedule_select(
                    func.count(RetestSchedule.id),
                    func.count(distinct(RetestSchedule.asset_id)),
                    func.coalesce(
                        func.sum(
                            case((RetestSchedule.escalated_at.is_not(None), 1), else_=0)
                        ),
                        0,
                    ),
                    func.coalesce(
                        func.sum(
                            case(
                                (
                                    or_(
                                        RetestSchedule.escalated_at.is_(None),
                                        ~_escalated_today(ref),
                                    ),
                                    1,
                                ),
                                else_=0,
                            )
                        ),
                        0,
                    ),
                    func.coalesce(
                        func.sum(case((_escalated_today(ref), 1), else_=0)), 0
                    ),
                ).where(*overdue)
            )
        )
    ).one()
    due_soon_assets = await _scalar_int(
        session,
        scope(
            schedule_select(func.count(distinct(RetestSchedule.asset_id))).where(
                *due_soon_conditions(ref)
            )
        ),
    )
    return RetestCounts(
        overdue_schedules=int(overdue_row[0]),
        overdue_assets=int(overdue_row[1]),
        overdue_escalated=int(overdue_row[2]),
        escalation_eligible=int(overdue_row[3]),
        escalated_today=int(overdue_row[4]),
        due_soon_assets=due_soon_assets,
    )


# --- fleet status -------------------------------------------------------------


@dataclass(frozen=True)
class FleetStatus:
    on_track: int = 0
    due_soon: int = 0
    overdue: int = 0
    suspended: int = 0
    unscheduled: int = 0

    @property
    def total(self) -> int:
        return (
            self.on_track
            + self.due_soon
            + self.overdue
            + self.suspended
            + self.unscheduled
        )

    @property
    def on_track_percent(self) -> int | None:
        """Retest on-track rate. None (not 0) when there is no fleet to measure."""
        return round(self.on_track / self.total * 100) if self.total else None


def _fleet_base(*columns: Any) -> Select[Any]:
    """Eligible fleet, left-joined to each asset's single live retest schedule."""
    return (
        select(*columns)
        .select_from(Asset)
        .join(Customer, Customer.id == Asset.customer_id)
        .outerjoin(
            RetestSchedule,
            and_(
                RetestSchedule.asset_id == Asset.id,
                RetestSchedule.deleted_at.is_(None),
            ),
        )
        .where(*fleet_conditions())
    )


async def fleet_status(
    session: AsyncSession, scope: Scope, ref: Reference
) -> FleetStatus:
    category = case(
        (RetestSchedule.id.is_(None), "unscheduled"),
        (RetestSchedule.status == RetestScheduleStatus.SUSPENDED.value, "suspended"),
        (RetestSchedule.due_at < ref.today, "overdue"),
        (RetestSchedule.due_at <= ref.due_soon_end, "due_soon"),
        else_="on_track",
    )
    rows = await session.execute(
        scope(_fleet_base(category, func.count(Asset.id))).group_by(category)
    )
    counts = {name: int(count) for name, count in rows.all()}
    return FleetStatus(**counts)


# --- certificate coverage -----------------------------------------------------


@dataclass(frozen=True)
class CertificateCoverage:
    eligible_assets: int
    covered_assets: int
    unverified_assets: int
    expired_assets: int
    missing_assets: int
    expiring_assets: int
    issued: int
    expiring_soon: int
    expired: int
    issued_in_period: int | None

    @property
    def coverage_percent(self) -> int:
        if not self.eligible_assets:
            return 0
        return round(self.covered_assets / self.eligible_assets * 100)


def _issued_certificate_select(*columns: Any) -> Select[Any]:
    return (
        select(*columns)
        .select_from(Certificate)
        .join(Inspection, Inspection.id == Certificate.inspection_id)
        .where(
            Certificate.deleted_at.is_(None),
            Inspection.deleted_at.is_(None),
            Certificate.status == CertificateStatus.ISSUED.value,
        )
    )


async def certificate_coverage(
    session: AsyncSession,
    scope: Scope,
    ref: Reference,
    period: tuple[datetime, datetime] | None,
) -> CertificateCoverage:
    """Asset-level coverage plus separate certificate-level counts.

    An asset is *covered* when it has an ISSUED certificate whose ``valid_until`` is on
    or after today (the expiry day itself still counts). A certificate with no
    ``valid_until`` has unknown validity: it is never counted as covered or expired,
    and an asset whose only usable certificates are undated is *unverified*. The
    issuance date is irrelevant.
    """
    per_asset = (
        _issued_certificate_select(
            Certificate.asset_id.label("asset_id"),
            func.max(Certificate.valid_until).label("max_valid"),
            func.sum(case((Certificate.valid_until.is_(None), 1), else_=0)).label(
                "undated"
            ),
        )
        .group_by(Certificate.asset_id)
        .subquery()
    )
    category = case(
        (per_asset.c.asset_id.is_(None), "missing"),
        (per_asset.c.max_valid >= ref.today, "covered"),
        (per_asset.c.undated > 0, "unverified"),
        else_="expired",
    )
    expiring = and_(
        per_asset.c.max_valid >= ref.today,
        per_asset.c.max_valid <= ref.certificate_expiry_end,
    )
    rows = await session.execute(
        scope(
            select(
                category,
                func.count(Asset.id),
                func.coalesce(func.sum(case((expiring, 1), else_=0)), 0),
            )
            .select_from(Asset)
            .join(Customer, Customer.id == Asset.customer_id)
            .outerjoin(per_asset, per_asset.c.asset_id == Asset.id)
            .where(*fleet_conditions())
        ).group_by(category)
    )
    by_category = {name: (int(n), int(exp)) for name, n, exp in rows.all()}

    def count(name: str) -> int:
        return by_category.get(name, (0, 0))[0]

    cert_row = (
        await session.execute(
            scope(
                _issued_certificate_select(
                    func.count(Certificate.id),
                    func.coalesce(
                        func.sum(
                            case(
                                (
                                    and_(
                                        Certificate.valid_until >= ref.today,
                                        Certificate.valid_until
                                        <= ref.certificate_expiry_end,
                                    ),
                                    1,
                                ),
                                else_=0,
                            )
                        ),
                        0,
                    ),
                    func.coalesce(
                        func.sum(
                            case((Certificate.valid_until < ref.today, 1), else_=0)
                        ),
                        0,
                    ),
                )
                .join(Asset, Asset.id == Certificate.asset_id)
                .join(Customer, Customer.id == Asset.customer_id)
                .where(Asset.deleted_at.is_(None))
            )
        )
    ).one()

    issued_in_period: int | None = None
    if period is not None:
        issued_in_period = await _scalar_int(
            session,
            scope(
                select(func.count(Certificate.id))
                .select_from(Certificate)
                .join(Inspection, Inspection.id == Certificate.inspection_id)
                .join(Asset, Asset.id == Certificate.asset_id)
                .where(
                    Certificate.deleted_at.is_(None),
                    Inspection.deleted_at.is_(None),
                    Asset.deleted_at.is_(None),
                    Certificate.status != CertificateStatus.DRAFT.value,
                    Certificate.issued_at >= period[0],
                    Certificate.issued_at < period[1],
                )
            ),
        )

    return CertificateCoverage(
        eligible_assets=sum(n for n, _ in by_category.values()),
        covered_assets=count("covered"),
        unverified_assets=count("unverified"),
        expired_assets=count("expired"),
        missing_assets=count("missing"),
        expiring_assets=by_category.get("covered", (0, 0))[1],
        issued=int(cert_row[0]),
        expiring_soon=int(cert_row[1]),
        expired=int(cert_row[2]),
        issued_in_period=issued_in_period,
    )


# --- customer risk and inspection outcomes ------------------------------------


@dataclass(frozen=True)
class CustomerRisk:
    customer_id: str
    customer_name: str
    overdue: int
    due_soon: int


async def customer_risk(
    session: AsyncSession, scope: Scope, ref: Reference, *, limit: int = 6
) -> list[CustomerRisk]:
    overdue = func.coalesce(
        func.sum(case((RetestSchedule.due_at < ref.today, 1), else_=0)), 0
    )
    due_soon = func.coalesce(
        func.sum(case((RetestSchedule.due_at >= ref.today, 1), else_=0)), 0
    )
    rows = await session.execute(
        scope(
            schedule_select(Customer.id, Customer.name, overdue, due_soon).where(
                RetestSchedule.deleted_at.is_(None),
                RetestSchedule.status != RetestScheduleStatus.SUSPENDED.value,
                RetestSchedule.due_at <= ref.due_soon_end,
                *fleet_conditions(),
            )
        )
        .group_by(Customer.id, Customer.name)
        .order_by(overdue.desc(), due_soon.desc(), Customer.name)
        .limit(limit)
    )
    return [CustomerRisk(r[0], r[1], int(r[2]), int(r[3])) for r in rows.all()]


@dataclass(frozen=True)
class InspectionOutcome:
    inspection_type: str
    submitted: int = 0
    approved: int = 0
    rejected: int = 0


async def inspection_outcomes(
    session: AsyncSession,
    scope: Scope,
    period: tuple[datetime, datetime] | None,
) -> tuple[list[InspectionOutcome], int]:
    """Outcomes by type, plus the current review queue (never period-limited).

    With a period, an inspection is placed by the timestamp of its current status,
    so it is counted once, in the period it reached that status.
    """
    event_at = func.coalesce(
        case(
            (
                Inspection.status == InspectionStatus.IN_PROGRESS.value,
                Inspection.started_at,
            ),
            (
                Inspection.status == InspectionStatus.SUBMITTED.value,
                Inspection.submitted_at,
            ),
            (
                Inspection.status == InspectionStatus.APPROVED.value,
                Inspection.approved_at,
            ),
            (
                Inspection.status == InspectionStatus.REJECTED.value,
                Inspection.rejected_at,
            ),
            else_=None,
        ),
        Inspection.created_at,
    )

    def base(*columns: Any) -> Select[Any]:
        return (
            select(*columns)
            .select_from(Inspection)
            .join(Asset, Asset.id == Inspection.asset_id)
            .join(Customer, Customer.id == Asset.customer_id)
            .where(
                Inspection.deleted_at.is_(None),
                Asset.deleted_at.is_(None),
                Customer.deleted_at.is_(None),
            )
        )

    statement = base(Inspection.inspection_type, Inspection.status, func.count()).where(
        Inspection.status.in_(
            [
                InspectionStatus.SUBMITTED.value,
                InspectionStatus.APPROVED.value,
                InspectionStatus.REJECTED.value,
            ]
        )
    )
    if period is not None:
        statement = statement.where(event_at >= period[0], event_at < period[1])
    rows = await session.execute(
        scope(statement).group_by(Inspection.inspection_type, Inspection.status)
    )
    outcomes: dict[str, dict[str, int]] = {}
    for inspection_type, status, count in rows.all():
        outcomes.setdefault(inspection_type, {})[status] = int(count)
    queue = await _scalar_int(
        session,
        scope(
            base(func.count()).where(
                Inspection.status == InspectionStatus.SUBMITTED.value
            )
        ),
    )
    return (
        [
            InspectionOutcome(
                inspection_type=name,
                submitted=counts.get(InspectionStatus.SUBMITTED.value, 0),
                approved=counts.get(InspectionStatus.APPROVED.value, 0),
                rejected=counts.get(InspectionStatus.REJECTED.value, 0),
            )
            for name, counts in sorted(outcomes.items())
        ],
        queue,
    )
