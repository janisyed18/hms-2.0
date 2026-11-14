"""Permission-scoped activity counts per time bucket.

Every series is counted from a record that carries the exact event timestamp. Nothing is
inferred from a record that cannot say when the event happened:

assets_added            Asset.created_at
inspections_submitted   Inspection.submitted_at
inspections_approved    Inspection.approved_at
inspections_rejected    Inspection.rejected_at
certificates_issued     Certificate.issued_at (not DRAFT)
retests_escalated       audit event ``retest_schedule.escalated``. RetestSchedule only
                        stores the *latest* escalation time, so counting that column
                        would lose earlier escalations; the audit trail has each one.
                        Only the count leaves this module, never the audit rows.

Retest *completion* is deliberately absent: completing a retest moves ``due_at`` forward
and leaves no timestamp, so it cannot be counted accurately.

Counts use one query per series: each bucket is a conditional SUM over the same indexed
range scan, and the bucket count is capped, so cost does not grow with record volume in
the response and the result is never truncated.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlalchemy import and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Select
from sqlalchemy.sql.elements import ColumnElement

from hms_backend.app.models.foundation import AuditEvent
from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.certificates.models import Certificate, CertificateStatus
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.inspections.models import Inspection
from hms_backend.app.modules.reporting.periods import Bucket
from hms_backend.app.modules.reporting.service import Scope
from hms_backend.app.modules.scheduling.models import RetestSchedule

ESCALATION_ACTION = "retest_schedule.escalated"

SERIES = (
    "assets_added",
    "inspections_submitted",
    "inspections_approved",
    "inspections_rejected",
    "certificates_issued",
    "retests_escalated",
)


def _live_assets(statement: Select[Any]) -> Select[Any]:
    return statement.where(Asset.deleted_at.is_(None), Customer.deleted_at.is_(None))


def _sources() -> dict[str, tuple[Any, Select[Any]]]:
    def from_assets() -> Select[Any]:
        return (
            select().select_from(Asset).join(Customer, Customer.id == Asset.customer_id)
        )

    def from_inspections() -> Select[Any]:
        return (
            select()
            .select_from(Inspection)
            .join(Asset, Asset.id == Inspection.asset_id)
            .join(Customer, Customer.id == Asset.customer_id)
            .where(Inspection.deleted_at.is_(None))
        )

    certificates = (
        select()
        .select_from(Certificate)
        .join(Asset, Asset.id == Certificate.asset_id)
        .join(Customer, Customer.id == Asset.customer_id)
        .where(
            Certificate.deleted_at.is_(None),
            Certificate.status != CertificateStatus.DRAFT.value,
        )
    )
    escalations = (
        select()
        .select_from(AuditEvent)
        .join(RetestSchedule, RetestSchedule.id == AuditEvent.entity_id)
        .join(Asset, Asset.id == RetestSchedule.asset_id)
        .join(Customer, Customer.id == Asset.customer_id)
        .where(
            AuditEvent.entity == RetestSchedule.__name__,
            AuditEvent.action == ESCALATION_ACTION,
        )
    )
    return {
        "assets_added": (Asset.created_at, from_assets()),
        "inspections_submitted": (Inspection.submitted_at, from_inspections()),
        "inspections_approved": (Inspection.approved_at, from_inspections()),
        "inspections_rejected": (Inspection.rejected_at, from_inspections()),
        "certificates_issued": (Certificate.issued_at, certificates),
        "retests_escalated": (AuditEvent.timestamp, escalations),
    }


def _bucket_expression(timestamp: Any, bucket: Bucket) -> ColumnElement[int]:
    return func.coalesce(
        func.sum(
            case((and_(timestamp >= bucket.start, timestamp < bucket.end), 1), else_=0)
        ),
        0,
    )


async def activity_counts(
    session: AsyncSession,
    scope: Scope,
    buckets: Sequence[Bucket],
) -> dict[str, list[int]]:
    """Counts per series per bucket, in bucket order."""
    first, last = buckets[0].start, buckets[-1].end
    result: dict[str, list[int]] = {}
    for name, (timestamp, statement) in _sources().items():
        query = _live_assets(statement).where(timestamp >= first, timestamp < last)
        columns = [_bucket_expression(timestamp, bucket) for bucket in buckets]
        row = (await session.execute(scope(query.add_columns(*columns)))).one()
        result[name] = [int(value) for value in row]
    return result
