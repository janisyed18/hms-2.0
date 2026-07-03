from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


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


class SyncBootstrapResponse(BaseModel):
    device: SyncDeviceRead
    cursor: int
    has_more: bool = False
    records: list[SyncRecordRead]


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


class SyncPushResponse(BaseModel):
    cursor: int
    results: list[SyncOperationResult]
