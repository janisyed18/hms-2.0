from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel as PydanticBaseModel
from pydantic import ConfigDict, Field


class BaseModel(PydanticBaseModel):
    model_config = ConfigDict(extra="forbid")


class SyncDeviceRead(BaseModel):
    device_id: str
    platform: str
    app_version: str
    offline_window_days: int
    revoked: bool


class SyncRecordRead(BaseModel):
    seq: int | None = None
    entity: str
    entity_id: str
    op: Literal["upsert", "delete"]
    version: int
    changed_at: datetime | None = None
    payload: dict[str, Any] | None


class SyncWorkContext(BaseModel):
    appointment_id: str
    booking_id: str
    revision_id: str
    assignment_id: str
    asset_id: str


class SyncBootstrapResponse(BaseModel):
    device: SyncDeviceRead
    cursor: int
    has_more: bool = False
    records: list[SyncRecordRead]
    work_contexts: list[SyncWorkContext] = Field(default_factory=list)
    # Paged protocol (version 2) only. ``cursor`` is then the snapshot watermark
    # pinned on the first page; the client reads ``/sync/changes`` from it once the
    # last page is in. ``scope_changed`` on the last page means the caller's
    # visibility moved during the traversal, so the partial copy must be discarded.
    protocol_version: int = 1
    next_page_token: str | None = None
    page_size: int | None = None
    scope_changed: bool = False


class SyncChangesResponse(BaseModel):
    cursor: int
    has_more: bool
    changes: list[SyncRecordRead]


class SyncOperationWrite(BaseModel):
    op_id: str
    idempotency_key: str
    entity: str
    entity_id: str
    op: Literal["create", "update", "delete"]
    base_version: int | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    work_context: SyncWorkContext | None = None
    # Protocol 3, Inspection only: the business transitions this operation performs, in
    # order, around the form data in ``payload``. ``None`` is the earlier shape, where
    # ``payload.status`` implied them; an operation queued by an older app still is.
    lifecycle_actions: list[Literal["start", "rework", "submit"]] | None = Field(
        default=None, max_length=3
    )


class SyncPushRequest(BaseModel):
    operations: list[SyncOperationWrite]


class SyncOperationResult(BaseModel):
    op_id: str
    idempotency_key: str
    entity: str
    entity_id: str
    status: Literal["applied", "conflict", "rejected"]
    version: int | None = None
    current_version: int | None = None
    payload: dict[str, Any] | None = None
    error: str | None = None
    error_code: str | None = None


class SyncPushResponse(BaseModel):
    cursor: int
    results: list[SyncOperationResult]
