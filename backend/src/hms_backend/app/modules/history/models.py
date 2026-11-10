"""Historical archive schema for customers removed from active HMS.

Four insert-only tables (database triggers reject UPDATE and DELETE on PostgreSQL):

* ``history_customer_deletions`` - one row per deletion attempt (the batch).
* ``history_records``            - one versioned, hashed snapshot per removed row.
* ``history_relationships``      - the foreign-key edges between snapshotted rows.
* ``history_evidence_objects``   - protected copies of certificate PDFs and photos.

None of them has a foreign key to a live operational table, so removing or restoring
operational rows can never cascade into the archive.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column
from uuid6 import uuid7

from hms_backend.app.models.base import Base, utc_now

# Bump when the payload layout of any record type changes; old snapshots keep theirs.
SNAPSHOT_SCHEMA_VERSION = 1


def _new_id() -> str:
    return str(uuid7())


class DeletionStatus:
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class CustomerDeletionBatch(Base):
    __tablename__ = "history_customer_deletions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_id)
    deletion_number: Mapped[str] = mapped_column(
        String(24), nullable=False, unique=True
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    customer_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    customer_code: Mapped[str] = mapped_column(String(40), nullable=False)
    customer_name: Mapped[str] = mapped_column(String(200), nullable=False)
    customer_version: Mapped[int] = mapped_column(Integer, nullable=False)
    actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    actor_name: Mapped[str] = mapped_column(String(320), nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(
        String(80), nullable=True, unique=True
    )
    snapshot_schema_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=SNAPSHOT_SCHEMA_VERSION
    )
    record_counts: Mapped[dict[str, int]] = mapped_column(
        JSON, nullable=False, default=dict
    )
    total_records: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    evidence_files: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    evidence_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    impact_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    manifest_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    retention_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    retention_basis: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    audit_event_sequence: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, index=True
    )


class HistoryRecord(Base):
    __tablename__ = "history_records"
    __table_args__ = (
        UniqueConstraint(
            "batch_id", "record_type", "original_id", name="uq_history_record"
        ),
        Index("ix_history_records_batch_type", "batch_id", "record_type"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_id)
    batch_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("history_customer_deletions.id"), nullable=False
    )
    record_type: Mapped[str] = mapped_column(String(80), nullable=False)
    original_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    original_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    schema_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=SNAPSHOT_SCHEMA_VERSION
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    payload_sha256: Mapped[str] = mapped_column(String(64), nullable=False)


class HistoryRelationship(Base):
    __tablename__ = "history_relationships"
    __table_args__ = (Index("ix_history_relationships_batch", "batch_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_id)
    batch_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("history_customer_deletions.id"), nullable=False
    )
    child_type: Mapped[str] = mapped_column(String(80), nullable=False)
    child_id: Mapped[str] = mapped_column(String(36), nullable=False)
    fk_column: Mapped[str] = mapped_column(String(80), nullable=False)
    parent_type: Mapped[str] = mapped_column(String(80), nullable=False)
    parent_id: Mapped[str] = mapped_column(String(36), nullable=False)
    # True when the parent was not removed (a shared record such as a product).
    parent_retained: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )


class HistoryEvidenceObject(Base):
    __tablename__ = "history_evidence_objects"
    __table_args__ = (Index("ix_history_evidence_batch", "batch_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_id)
    batch_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("history_customer_deletions.id"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    record_type: Mapped[str] = mapped_column(String(80), nullable=False)
    original_id: Mapped[str] = mapped_column(String(36), nullable=False)
    label: Mapped[str] = mapped_column(String(200), nullable=False)
    source_key: Mapped[str] = mapped_column(String(500), nullable=False)
    history_key: Mapped[str] = mapped_column(String(600), nullable=False)
    content_type: Mapped[str] = mapped_column(String(80), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    verified_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
