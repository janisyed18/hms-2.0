"""Delete a customer from active HMS with a verified historical archive.

Order of operations (see docs/design/customer-deletion-history.md):

1. lock the customer row, check version, typed name and the impact fingerprint;
2. read a complete snapshot of every exclusively owned record;
3. copy certificate PDFs and photos to protected history storage and read them back;
4. in ONE database transaction: write the batch, snapshots, relationships and evidence
   rows, read them back and re-hash them, and only then logically remove the
   operational rows (``deleted_at``), stage tombstones and write the audit events.

Any failure before the commit rolls the transaction back, removes the history objects
copied by this attempt, records a FAILED batch and raises. Nothing is reported as
success unless the commit happened.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import Table, and_, func, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import lazyload
from sqlalchemy.sql.elements import ColumnElement
from uuid6 import uuid7

from hms_backend.app.core.audit import (
    acquire_ledger_lock,
    append_audit_event,
    normalise_for_json,
)
from hms_backend.app.core.config import settings
from hms_backend.app.core.object_storage import (
    HistoryStorageError,
    ObjectNotFoundError,
    ObjectStorage,
    get_evidence,
    history_storage_problems,
    put_evidence,
)
from hms_backend.app.core.rbac import Principal
from hms_backend.app.core.sync_ledger import stage_sync_change
from hms_backend.app.models.base import Base
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.history.models import (
    SNAPSHOT_SCHEMA_VERSION,
    CustomerDeletionBatch,
    DeletionStatus,
    HistoryEvidenceObject,
    HistoryRecord,
    HistoryRelationship,
)
from hms_backend.app.modules.identity.models import User

logger = logging.getLogger(__name__)

HISTORY_PREFIX = "history/customer-deletions"
_CHUNK = 500

# table -> the ways a row is exclusively owned: (foreign key column, owning table).
# A row is owned when ANY of its links points at an owned row. Customers is the root.
OWNERSHIP: dict[str, tuple[tuple[str, str], ...]] = {
    "customer_locations": (("customer_id", "customers"),),
    "customer_contacts": (("customer_id", "customers"),),
    "customer_location_contacts": (("location_id", "customer_locations"),),
    "assets": (("customer_id", "customers"),),
    "asset_end_configurations": (("asset_id", "assets"),),
    "retest_schedules": (("customer_id", "customers"),),
    "inspection_bookings": (("customer_id", "customers"),),
    "inspection_booking_assets": (
        ("booking_id", "inspection_bookings"),
        ("asset_id", "assets"),
    ),
    "inspection_appointments": (("customer_id", "customers"),),
    "inspection_appointment_revisions": (
        ("appointment_id", "inspection_appointments"),
    ),
    "inspection_resource_allocations": (
        ("revision_id", "inspection_appointment_revisions"),
    ),
    "inspection_appointment_change_requests": (
        ("appointment_id", "inspection_appointments"),
        ("booking_id", "inspection_bookings"),
    ),
    "inspections": (
        ("booking_id", "inspection_bookings"),
        ("asset_id", "assets"),
    ),
    "inspection_answers": (("inspection_id", "inspections"),),
    "inspection_photos": (("inspection_id", "inspections"),),
    "pressure_test_results": (("inspection_id", "inspections"),),
    "certificates": (
        ("inspection_id", "inspections"),
        ("asset_id", "assets"),
    ),
    # An association, not a person: the user account itself is shared and kept.
    "user_customer_accesses": (("customer_id", "customers"),),
}
ROOT = "customers"
OWNED_TABLES: tuple[str, ...] = (ROOT, *OWNERSHIP)

# Tables that point at owned rows but are deliberately NOT removed. Anything else that
# points at an owned row blocks deletion, so a new table cannot be silently orphaned.
RETAINED_REFERENCERS = frozenset(
    {
        # Portal/staff accounts are shared; only the access association is removed.
        "users",
        # Short-lived availability quotes carry no business history of their own.
        "inspection_availability_quotes",
        # The archive itself.
        "history_customer_deletions",
        "history_records",
        "history_relationships",
        "history_evidence_objects",
    }
)

LABELS: dict[str, str] = {
    "customers": "Customer",
    "customer_locations": "Locations",
    "customer_contacts": "Contacts",
    "customer_location_contacts": "Location contacts",
    "assets": "Assets",
    "asset_end_configurations": "Asset configurations",
    "retest_schedules": "Retest schedules",
    "inspection_bookings": "Inspection bookings",
    "inspection_booking_assets": "Booked assets",
    "inspection_appointments": "Appointments",
    "inspection_appointment_revisions": "Appointment revisions",
    "inspection_resource_allocations": "Resource allocations",
    "inspection_appointment_change_requests": "Appointment change requests",
    "inspections": "Completed inspections",
    "inspection_answers": "Inspection answers",
    "inspection_photos": "Inspection photos",
    "pressure_test_results": "Pressure test results",
    "certificates": "Issued certificates",
    "user_customer_accesses": "Customer user assignments",
}

EVIDENCE_COLUMNS = {
    "certificates": ("pdf_object_key", "CERTIFICATE_PDF", "application/pdf"),
    "inspection_photos": ("object_key", "INSPECTION_PHOTO", "application/octet-stream"),
}


class ArchiveError(RuntimeError):
    """The historical archive could not be created or did not verify."""


@dataclass
class EvidenceItem:
    kind: str
    record_type: str
    original_id: str
    label: str
    source_key: str
    content_type: str
    declared_sha256: str | None
    history_key: str = ""
    size_bytes: int = 0
    sha256: str = ""
    history_version_id: str | None = None
    retention_mode: str | None = None
    retain_until: datetime | None = None


@dataclass
class Snapshot:
    rows: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    evidence: list[EvidenceItem] = field(default_factory=list)

    @property
    def counts(self) -> dict[str, int]:
        return {table: len(rows) for table, rows in self.rows.items() if rows}

    @property
    def previously_deleted_counts(self) -> dict[str, int]:
        found = {
            table: sum(1 for row in rows if row.get("deleted_at") is not None)
            for table, rows in self.rows.items()
        }
        return {table: n for table, n in found.items() if n}


@dataclass(frozen=True)
class DeletionOutcome:
    batch: CustomerDeletionBatch
    replayed: bool


def canonical_json(value: Any) -> str:
    return json.dumps(normalise_for_json(value), sort_keys=True, separators=(",", ":"))


def sha256_hex(data: bytes | str) -> str:
    raw = data.encode("utf-8") if isinstance(data, str) else data
    return hashlib.sha256(raw).hexdigest()


def _table(name: str) -> Table:
    return Base.metadata.tables[name]


def _active(table: Table) -> ColumnElement[bool]:
    return table.c.deleted_at.is_(None) if "deleted_at" in table.c else true()


def owned_clause(
    table_name: str, customer_id: str, *, include_deleted: bool = True
) -> ColumnElement[bool]:
    """Rows of ``table_name`` that the customer exclusively owns.

    By default this includes rows soft-deleted earlier, and ownership is followed
    through a parent that was soft-deleted earlier, so the archive keeps what was
    already removed as well as what is active. ``include_deleted=False`` gives the
    active rows only.
    """
    table = _table(table_name)
    live = true() if include_deleted else _active(table)
    if table_name == ROOT:
        return and_(table.c.id == customer_id, live)
    links = []
    for column, parent_name in OWNERSHIP[table_name]:
        parent = _table(parent_name)
        links.append(
            table.c[column].in_(
                select(parent.c.id).where(
                    owned_clause(
                        parent_name, customer_id, include_deleted=include_deleted
                    )
                )
            )
        )
    return and_(or_(*links), live)


async def impact_counts(
    session: AsyncSession, customer_id: str, *, previously_deleted: bool = False
) -> dict[str, int]:
    """Owned rows per table: everything archived, or only what was already deleted."""
    counts: dict[str, int] = {}
    for name in OWNED_TABLES:
        table = _table(name)
        statement = (
            select(func.count())
            .select_from(table)
            .where(owned_clause(name, customer_id))
        )
        if previously_deleted:
            if "deleted_at" not in table.c:
                continue
            statement = statement.where(table.c.deleted_at.is_not(None))
        found = await session.scalar(statement)
        if found:
            counts[name] = int(found)
    return counts


async def lock_owned_rows(session: AsyncSession, customer_id: str) -> None:
    """Row-lock every owned row until the transaction ends.

    A concurrent edit of a child record then waits instead of changing data between
    the fingerprint check and the commit. A new child needs a share lock on a parent
    this transaction holds, so it waits too. Locks are taken in a fixed order.
    """
    for name in OWNED_TABLES:
        table = _table(name)
        await session.execute(
            select(table.c.id)
            .where(owned_clause(name, customer_id))
            .order_by(table.c.id)
            .with_for_update()
        )


async def evidence_file_count(session: AsyncSession, customer_id: str) -> int:
    total = 0
    for name, (column, _kind, _type) in EVIDENCE_COLUMNS.items():
        table = _table(name)
        total += int(
            await session.scalar(
                select(func.count())
                .select_from(table)
                .where(owned_clause(name, customer_id), table.c[column].is_not(None))
            )
            or 0
        )
    return total


async def impact_digest(session: AsyncSession, customer_id: str) -> str:
    """A hash over the identity and full content of every owned row.

    Counts alone miss an edit to an existing child record, so the preview a Super
    Admin reviewed is only valid while every owned row is byte-for-byte the same.
    """
    digest = hashlib.sha256()
    for name in OWNED_TABLES:
        table = _table(name)
        result = await session.execute(
            select(table).where(owned_clause(name, customer_id)).order_by(table.c.id)
        )
        digest.update(name.encode("utf-8"))
        for row in result.mappings().all():
            content = {column.name: row[column.name] for column in table.c}
            digest.update(canonical_json(content).encode("utf-8"))
    return digest.hexdigest()


def impact_fingerprint(customer: Customer, content_digest: str) -> str:
    return sha256_hex(
        canonical_json(
            {
                "customer_id": customer.id,
                "version": customer.version,
                "content": content_digest,
            }
        )
    )


async def external_references(
    session: AsyncSession, customer_id: str
) -> list[dict[str, Any]]:
    """Live rows outside the owned set that still point at owned rows."""
    blockers: list[dict[str, Any]] = []
    for table in Base.metadata.sorted_tables:
        if table.name in RETAINED_REFERENCERS:
            continue
        for foreign_key in table.foreign_keys:
            target = foreign_key.column.table.name
            if target not in OWNED_TABLES:
                continue
            statement = (
                select(func.count())
                .select_from(table)
                .where(
                    foreign_key.parent.in_(
                        select(foreign_key.column).where(
                            owned_clause(target, customer_id)
                        )
                    )
                )
            )
            if table.name in OWNED_TABLES:
                # A row of an owned table that links in from outside the owned set.
                statement = statement.where(~owned_clause(table.name, customer_id))
            if "deleted_at" in table.c:
                statement = statement.where(table.c.deleted_at.is_(None))
            found = int(await session.scalar(statement) or 0)
            if found:
                blockers.append(
                    {
                        "kind": table.name,
                        "label": LABELS.get(table.name, table.name.replace("_", " ")),
                        "count": found,
                        "records": [],
                    }
                )
    return blockers


DELETION_OFF_MESSAGE = (
    "Customer deletion is not enabled in this environment. "
    "Nothing was removed. You can archive the customer instead."
)
STORAGE_NOT_READY_MESSAGE = (
    "Customer deletion is unavailable because protected history storage is not "
    "ready. Nothing was removed. You can archive the customer instead."
)


RETENTION_NOT_APPROVED_MESSAGE = (
    "Customer deletion is unavailable because this environment's evidence "
    "retention period has not been approved. Nothing was removed. You can archive "
    "the customer instead."
)


async def deletion_unavailable_reason() -> str | None:
    """Why deleting a customer is refused right now, or None when it is allowed.

    Two independent conditions: the environment switch, and the evidence store being
    the protected, locked bucket (or the local/test fallback). Either one off means
    nothing is archived or removed.
    """
    if not settings.customer_deletion_enabled:
        return DELETION_OFF_MESSAGE
    approved = bool(settings.history_retention_approval.strip())
    if not approved and not settings.is_local_or_test:
        return RETENTION_NOT_APPROVED_MESSAGE
    problems = await asyncio.to_thread(history_storage_problems)
    if problems:
        logger.error(
            "customer deletion refused: protected history storage is not ready",
            extra={"problems": problems},
        )
        return STORAGE_NOT_READY_MESSAGE
    return None


async def build_impact(session: AsyncSession, customer: Customer) -> dict[str, Any]:
    counts = await impact_counts(session, customer.id)
    earlier = await impact_counts(session, customer.id, previously_deleted=True)
    blockers = await external_references(session, customer.id)
    return {
        "can_delete": not blockers,
        "archived": customer.archived_at is not None,
        "blockers": blockers,
        "customer_name": customer.name,
        "customer_code": customer.code,
        "version": customer.version,
        "impact": {
            # Related records only: the customer itself is not counted.
            "total_records": sum(n for k, n in counts.items() if k != ROOT),
            "previously_deleted": sum(n for k, n in earlier.items() if k != ROOT),
            "items": [
                {
                    "kind": name,
                    "label": LABELS[name],
                    "count": counts[name],
                    "previously_deleted": earlier.get(name, 0),
                }
                for name in OWNED_TABLES
                if name in counts and name != ROOT
            ],
            "evidence_files": await evidence_file_count(session, customer.id),
        },
        "fingerprint": impact_fingerprint(
            customer, await impact_digest(session, customer.id)
        ),
        "retention_days": settings.history_retention_period_days,
        "retention_years": round(settings.history_retention_period_days / 365, 2),
    }


async def read_snapshot(session: AsyncSession, customer_id: str) -> Snapshot:
    snapshot = Snapshot()
    for name in OWNED_TABLES:
        table = _table(name)
        result = await session.execute(
            select(table).where(owned_clause(name, customer_id)).order_by(table.c.id)
        )
        rows = [
            {column.name: normalise_for_json(row[column.name]) for column in table.c}
            for row in result.mappings().all()
        ]
        snapshot.rows[name] = rows
        spec = EVIDENCE_COLUMNS.get(name)
        if spec is None:
            continue
        column, kind, content_type = spec
        for row in rows:
            key = row.get(column)
            if not key:
                continue
            snapshot.evidence.append(
                EvidenceItem(
                    kind=kind,
                    record_type=name,
                    original_id=str(row["id"]),
                    label=str(row.get("number") or row.get("caption") or row["id"]),
                    source_key=str(key),
                    content_type=content_type,
                    declared_sha256=row.get("pdf_sha256"),
                )
            )
    return snapshot


def _record_hash(record_type: str, row: dict[str, Any]) -> str:
    return sha256_hex(canonical_json({"type": record_type, "payload": row}))


def manifest_hash(
    record_hashes: list[tuple[str, str, str]],
    evidence: list[tuple[str, str]],
) -> str:
    lines = sorted(f"R|{t}|{i}|{h}" for t, i, h in record_hashes)
    lines += sorted(f"E|{i}|{h}" for i, h in evidence)
    return sha256_hex("\n".join(lines))


def _relationships(snapshot: Snapshot) -> list[dict[str, Any]]:
    owned_ids = {
        (name, str(row["id"])) for name, rows in snapshot.rows.items() for row in rows
    }
    edges: list[dict[str, Any]] = []
    for name, rows in snapshot.rows.items():
        table = _table(name)
        for foreign_key in table.foreign_keys:
            parent = foreign_key.column.table.name
            for row in rows:
                parent_id = row.get(foreign_key.parent.name)
                if parent_id is None:
                    continue
                edges.append(
                    {
                        "child_type": name,
                        "child_id": str(row["id"]),
                        "fk_column": foreign_key.parent.name,
                        "parent_type": parent,
                        "parent_id": str(parent_id),
                        "parent_retained": (parent, str(parent_id)) not in owned_ids,
                    }
                )
    return edges


def _copy_evidence(
    source: ObjectStorage,
    history: ObjectStorage,
    batch_id: str,
    snapshot: Snapshot,
    written: list[dict[str, Any]],
    retention_until: date,
) -> None:
    """Copy every evidence file into the history store, pinned to its version.

    ``written`` gets an entry for each key *before* it is written and the version id
    once known, so a file left behind by any failure (even a write whose outcome is
    unknown) is listed on the FAILED batch for reconciliation.
    """
    min_retain_until = datetime.combine(retention_until, time.min, tzinfo=UTC)
    for item in snapshot.evidence:
        try:
            data = source.get(item.source_key)
        except ObjectNotFoundError as exc:
            raise ArchiveError(
                f"{item.label}: the stored {item.kind.lower().replace('_', ' ')} "
                "file is missing, so it cannot be archived"
            ) from exc
        digest = sha256_hex(data)
        if item.declared_sha256 and item.declared_sha256 != digest:
            raise ArchiveError(
                f"{item.label}: the stored file does not match its issuance hash"
            )
        item.history_key = (
            f"{HISTORY_PREFIX}/{batch_id}/{item.record_type}/{item.original_id}/"
            f"{item.source_key.rsplit('/', 1)[-1]}"
        )
        entry: dict[str, Any] = {"key": item.history_key, "version_id": None}
        written.append(entry)
        try:
            stored = put_evidence(
                history,
                item.history_key,
                data,
                content_type=item.content_type,
                min_retain_until=min_retain_until,
            )
        except HistoryStorageError as exc:
            entry["version_id"] = exc.version_id
            raise ArchiveError(f"{item.label}: {exc}") from exc
        entry["version_id"] = stored.version_id
        item.history_version_id = stored.version_id
        item.retention_mode = stored.retention_mode
        item.retain_until = stored.retain_until
        try:
            copy = get_evidence(history, item.history_key, stored.version_id)
        except (HistoryStorageError, ObjectNotFoundError) as exc:
            raise ArchiveError(
                f"{item.label}: the archived copy could not be read back"
            ) from exc
        if sha256_hex(copy) != digest:
            raise ArchiveError(f"{item.label}: archived copy failed verification")
        item.size_bytes = len(data)
        item.sha256 = digest


def _cleanup(storage: ObjectStorage, written: list[dict[str, Any]]) -> str:
    if getattr(storage, "protected", False):
        # Locked evidence is never deleted and its retention is never weakened. A
        # copy left by a failed attempt stays until its retention ends; it is
        # unreferenced, and the FAILED batch lists it (key and version) to reconcile.
        return (
            f"{len(written)} retained in protected storage" if written else "removed"
        )
    failed = 0
    for entry in written:
        try:
            storage.delete(entry["key"])
        except Exception:  # best effort; the keys are listed on the FAILED batch
            failed += 1
            logger.warning("history object cleanup failed", extra={"key": entry["key"]})
    return "removed" if not failed else f"{failed} could not be removed"


async def _next_number(session: AsyncSession) -> str:
    await acquire_ledger_lock(session)
    count = int(
        await session.scalar(select(func.count()).select_from(CustomerDeletionBatch))
        or 0
    )
    return f"DEL-{datetime.now(UTC).year}-{count + 1:06d}"


async def _actor_name(session: AsyncSession, principal: Principal) -> str:
    user = await session.get(User, principal.persisted_user_id)
    if user is None:
        return principal.user_id
    full = " ".join(part for part in (user.first_name, user.last_name) if part)
    return full or user.email


def _retention() -> tuple[date, str]:
    today = datetime.now(UTC).date()
    days = settings.history_retention_period_days
    until = today + timedelta(days=days)
    approval = settings.history_retention_approval.strip()
    approved = f" Retention period approved under: {approval}." if approval else ""
    return until, (
        f"Certificate and inspection evidence is retained for {days} days from "
        "deletion under the HMS evidence-retention setting."
        f"{approved} Retention of a record is not the same as erasing personal "
        "data; erasure requests are reviewed separately."
    )


async def _find_replay(
    session: AsyncSession, key: str | None, customer_id: str
) -> CustomerDeletionBatch | None:
    if not key:
        return None
    batch = (
        await session.scalars(
            select(CustomerDeletionBatch).where(
                CustomerDeletionBatch.idempotency_key == key
            )
        )
    ).first()
    if batch is None:
        return None
    if batch.customer_id != customer_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This idempotency key was used for a different customer.",
        )
    return batch


async def _record_failure(
    session: AsyncSession,
    *,
    batch_id: str,
    customer: dict[str, Any],
    actor_id: str,
    actor_name: str,
    reason: str | None,
    fingerprint: str,
    detail: str,
    orphaned_evidence: list[dict[str, Any]] | None = None,
) -> CustomerDeletionBatch:
    number = await _next_number(session)
    batch = CustomerDeletionBatch(
        id=batch_id,
        deletion_number=number,
        status=DeletionStatus.FAILED,
        customer_id=customer["id"],
        customer_code=customer["code"],
        customer_name=customer["name"],
        customer_version=customer["version"],
        actor_id=actor_id,
        actor_name=actor_name,
        reason=reason,
        impact_fingerprint=fingerprint,
        failure_detail=detail[:2000],
        orphaned_evidence=orphaned_evidence or [],
    )
    session.add(batch)
    event = await append_audit_event(
        session,
        actor_id=actor_id,
        action="customer.deletion_failed",
        entity="CustomerDeletionBatch",
        entity_id=batch_id,
        before=None,
        after={
            "deletion_number": number,
            "customer_id": customer["id"],
            "status": DeletionStatus.FAILED,
            "detail": detail[:500],
            "orphaned_evidence": len(orphaned_evidence or []),
        },
    )
    batch.audit_event_sequence = event.sequence
    await session.commit()
    return batch


async def delete_customer_with_history(
    session: AsyncSession,
    *,
    customer_id: str,
    principal: Principal,
    source_storage: ObjectStorage,
    history_storage: ObjectStorage,
    confirm_name: str,
    expected_fingerprint: str,
    reason: str | None,
    idempotency_key: str | None,
    check_version: Callable[[int], None],
) -> DeletionOutcome:
    replay = await _find_replay(session, idempotency_key, customer_id)
    if replay is not None and replay.status == DeletionStatus.COMPLETED:
        return DeletionOutcome(replay, replayed=True)

    # Row lock: a concurrent delete waits here, then finds the customer gone.
    customer = (
        await session.scalars(
            select(Customer)
            .where(Customer.id == customer_id, Customer.deleted_at.is_(None))
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).first()
    if customer is None:
        replay = await _find_replay(session, idempotency_key, customer_id)
        if replay is not None and replay.status == DeletionStatus.COMPLETED:
            return DeletionOutcome(replay, replayed=True)
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Customer not found")
    check_version(customer.version)
    if confirm_name.strip() != customer.name.strip():
        raise HTTPException(
            422,
            "The customer name you typed does not match.",
        )

    # Lock every owned row now, so no child can change before this transaction ends.
    await lock_owned_rows(session, customer.id)
    fingerprint = impact_fingerprint(
        customer, await impact_digest(session, customer.id)
    )
    if fingerprint != expected_fingerprint:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This customer's records changed after you reviewed the impact. "
            "Review the impact again before deleting.",
        )
    blockers = await external_references(session, customer.id)
    if blockers:
        summary = ", ".join(f"{b['count']} {b['label']}" for b in blockers)
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Records outside this customer still refer to it ({summary}). "
            "Resolve them before deleting.",
        )

    actor_name = await _actor_name(session, principal)
    summary_customer = {
        "id": customer.id,
        "code": customer.code,
        "name": customer.name,
        "version": customer.version,
    }
    batch_id = str(uuid7())
    written: list[dict[str, Any]] = []
    retention_until, retention_basis = _retention()
    try:
        snapshot = await read_snapshot(session, customer.id)
        _copy_evidence(
            source_storage,
            history_storage,
            batch_id,
            snapshot,
            written,
            retention_until,
        )
        batch = await _write_archive_and_remove(
            session,
            customer=customer,
            principal=principal,
            actor_name=actor_name,
            batch_id=batch_id,
            snapshot=snapshot,
            fingerprint=fingerprint,
            reason=reason,
            idempotency_key=idempotency_key,
            retention_until=retention_until,
            retention_basis=retention_basis,
        )
        await session.commit()
    except HTTPException as exc:
        await session.rollback()
        cleanup = _cleanup(history_storage, written)
        if getattr(history_storage, "protected", False) and written:
            await _record_failure(
                session,
                batch_id=batch_id,
                customer=summary_customer,
                actor_id=principal.user_id,
                actor_name=actor_name,
                reason=reason,
                fingerprint=fingerprint,
                detail=f"refused after archiving files: {exc.detail}; {cleanup}",
                orphaned_evidence=written,
            )
        raise
    except Exception as exc:  # nothing has been removed: roll back, record, report
        await session.rollback()
        cleanup = _cleanup(history_storage, written)
        detail = f"{type(exc).__name__}: {exc}; archived copies {cleanup}"
        logger.error("customer deletion archive failed", exc_info=exc)
        failed = await _record_failure(
            session,
            batch_id=batch_id,
            customer=summary_customer,
            actor_id=principal.user_id,
            actor_name=actor_name,
            reason=reason,
            fingerprint=fingerprint,
            detail=detail,
            orphaned_evidence=(
                written if getattr(history_storage, "protected", False) else []
            ),
        )
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            f"The historical archive could not be created, so nothing was removed "
            f"(reference {failed.deletion_number}). Try again or contact support.",
        ) from exc
    return DeletionOutcome(batch, replayed=False)


async def _write_archive_and_remove(
    session: AsyncSession,
    *,
    customer: Customer,
    principal: Principal,
    actor_name: str,
    batch_id: str,
    snapshot: Snapshot,
    fingerprint: str,
    reason: str | None,
    idempotency_key: str | None,
    retention_until: date,
    retention_basis: str,
) -> CustomerDeletionBatch:
    number = await _next_number(session)
    record_hashes: list[tuple[str, str, str]] = []
    records: list[HistoryRecord] = []
    ordinal = 0
    for name in OWNED_TABLES:
        for row in snapshot.rows.get(name, []):
            digest = _record_hash(name, row)
            record_hashes.append((name, str(row["id"]), digest))
            ordinal += 1
            records.append(
                HistoryRecord(
                    batch_id=batch_id,
                    record_type=name,
                    original_id=str(row["id"]),
                    original_version=row.get("version"),
                    schema_version=SNAPSHOT_SCHEMA_VERSION,
                    ordinal=ordinal,
                    payload=row,
                    payload_sha256=digest,
                )
            )
    manifest = manifest_hash(
        record_hashes, [(e.original_id, e.sha256) for e in snapshot.evidence]
    )
    counts = snapshot.counts
    earlier = snapshot.previously_deleted_counts
    total = sum(n for name, n in counts.items() if name != ROOT)

    event = await append_audit_event(
        session,
        actor_id=principal.user_id,
        action="customer.deleted_with_history",
        entity="CustomerDeletionBatch",
        entity_id=batch_id,
        before=None,
        after={
            "deletion_number": number,
            "customer_id": customer.id,
            "customer_code": customer.code,
            "customer_name": customer.name,
            "record_counts": counts,
            "previously_deleted_counts": earlier,
            "total_records": total,
            "evidence_files": len(snapshot.evidence),
            "manifest_sha256": manifest,
            "reason": reason,
            "retention_until": retention_until.isoformat(),
        },
    )
    batch = CustomerDeletionBatch(
        id=batch_id,
        deletion_number=number,
        status=DeletionStatus.COMPLETED,
        customer_id=customer.id,
        customer_code=customer.code,
        customer_name=customer.name,
        customer_version=customer.version,
        actor_id=principal.user_id,
        actor_name=actor_name,
        reason=reason,
        idempotency_key=idempotency_key,
        record_counts=counts,
        previously_deleted_counts=earlier,
        total_records=total,
        evidence_files=len(snapshot.evidence),
        evidence_bytes=sum(e.size_bytes for e in snapshot.evidence),
        impact_fingerprint=fingerprint,
        manifest_sha256=manifest,
        retention_until=retention_until,
        retention_basis=retention_basis,
        audit_event_sequence=event.sequence,
    )
    session.add(batch)
    await session.flush()
    for start in range(0, len(records), _CHUNK):
        session.add_all(records[start : start + _CHUNK])
        await session.flush()
    session.add_all(
        HistoryRelationship(batch_id=batch_id, **edge)
        for edge in _relationships(snapshot)
    )
    session.add_all(
        HistoryEvidenceObject(
            batch_id=batch_id,
            kind=item.kind,
            record_type=item.record_type,
            original_id=item.original_id,
            label=item.label[:200],
            source_key=item.source_key,
            history_key=item.history_key,
            content_type=item.content_type,
            size_bytes=item.size_bytes,
            sha256=item.sha256,
            history_version_id=item.history_version_id,
            retention_mode=item.retention_mode,
            retain_until=item.retain_until,
        )
        for item in snapshot.evidence
    )
    await session.flush()
    await verify_batch_in_session(session, batch)
    await _remove_from_active(session, customer, principal, snapshot, batch)
    return batch


async def verify_batch_in_session(
    session: AsyncSession, batch: CustomerDeletionBatch
) -> None:
    """Re-read the stored archive and prove it matches the manifest (raises if not)."""
    stored = (
        await session.execute(
            select(
                HistoryRecord.record_type,
                HistoryRecord.original_id,
                HistoryRecord.payload,
                HistoryRecord.payload_sha256,
            ).where(HistoryRecord.batch_id == batch.id)
        )
    ).all()
    hashes: list[tuple[str, str, str]] = []
    for record_type, original_id, payload, declared in stored:
        recomputed = _record_hash(record_type, payload)
        if recomputed != declared:
            raise ArchiveError(f"snapshot of {record_type} {original_id} is corrupt")
        hashes.append((record_type, original_id, recomputed))
    evidence = (
        await session.execute(
            select(
                HistoryEvidenceObject.original_id, HistoryEvidenceObject.sha256
            ).where(HistoryEvidenceObject.batch_id == batch.id)
        )
    ).all()
    if len(hashes) != batch.total_records + 1:  # related records plus the customer
        raise ArchiveError("archived record count does not match the impact review")
    if manifest_hash(hashes, [(i, h) for i, h in evidence]) != batch.manifest_sha256:
        raise ArchiveError("archive manifest does not match the stored snapshots")


async def _remove_from_active(
    session: AsyncSession,
    customer: Customer,
    principal: Principal,
    snapshot: Snapshot,
    batch: CustomerDeletionBatch,
) -> None:
    from hms_backend.app.api.sync_bootstrap import SYNC_MODELS

    now = datetime.now(UTC)
    classes = {
        str(getattr(m.local_table, "name", "")): m.class_ for m in Base.registry.mappers
    }
    for name in reversed(OWNED_TABLES):
        if name == ROOT:
            continue
        # Rows already soft-deleted stay exactly as they were: no second delete, no
        # version bump and no duplicate tombstone.
        ids = [
            str(row["id"])
            for row in snapshot.rows.get(name, [])
            if row.get("deleted_at") is None
        ]
        model = classes[name]
        for start in range(0, len(ids), _CHUNK):
            rows = (
                await session.scalars(
                    select(model)
                    .options(lazyload("*"))
                    .where(model.id.in_(ids[start : start + _CHUNK]))
                )
            ).all()
            for entity in rows:
                entity.deleted_at = now
                entity.version += 1
                if model.__name__ in SYNC_MODELS:
                    await stage_sync_change(
                        session,
                        entity=model.__name__,
                        entity_id=entity.id,
                        op="delete",
                        version=entity.version,
                    )
    before = customer.to_audit_dict()
    customer.deleted_at = now
    customer.version += 1
    await stage_sync_change(
        session,
        entity="Customer",
        entity_id=customer.id,
        op="delete",
        version=customer.version,
    )
    await append_audit_event(
        session,
        actor_id=principal.user_id,
        action="customer.deleted",
        entity="Customer",
        entity_id=customer.id,
        before=before,
        after={**customer.to_audit_dict(), "deletion_batch_id": batch.id},
    )
