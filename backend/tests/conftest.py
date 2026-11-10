from __future__ import annotations

import io
import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

# Local/test operation must be selected explicitly: an unset ENVIRONMENT is treated
# as an under-configured deployment (see Settings.auth_config_errors). Set before any
# application module builds the global ``settings``.
os.environ.setdefault("ENVIRONMENT", "test")

from zoneinfo import reset_tzpath  # noqa: E402

import pytest

import hms_backend.app.core.cache as cache
from hms_backend.app.core.object_storage import S3HistoryStorage, set_history_storage
from hms_backend.app.core.redis import set_redis_client

# Match the containers, which set PYTHONTZPATH="" to use the locked tzdata.
reset_tzpath(())


class FakeHistoryS3:
    """Just enough S3 to model a versioned, Object Lock bucket for evidence tests.

    ``objects`` holds the latest bytes per key; ``versions`` every version written,
    so tests can show a newer upload never changes what a pinned version returns.
    """

    def __init__(
        self,
        *,
        versioning: str | None = "Enabled",
        lock: bool = True,
        mode: str | None = "GOVERNANCE",
        years: int = 7,
        days: int = 0,
        lock_objects: bool = True,
        retain_days: int = 2555,
        return_version_id: bool = True,
        fail_put_on: int | None = None,
        corrupt_reads: bool = False,
    ) -> None:
        self.versioning = versioning
        self.lock = lock
        self.mode = mode
        self.years = years
        self.days = days
        self.lock_objects = lock_objects
        self.retain_days = retain_days
        self.return_version_id = return_version_id
        self.fail_put_on = fail_put_on
        self.corrupt_reads = corrupt_reads
        self.objects: dict[str, bytes] = {}
        self.versions: dict[str, dict[str, dict[str, Any]]] = {}
        self.calls: list[str] = []
        self._counter = 0

    def put_object(
        self, *, Bucket: str, Key: str, Body: bytes, **_: Any
    ) -> dict[str, Any]:
        self.calls.append("put_object")
        puts = self.calls.count("put_object")
        if self.fail_put_on is not None and puts == self.fail_put_on:
            raise _FakeClientError("InternalError")
        self._counter += 1
        version_id = f"v{self._counter}"
        self.objects[Key] = Body
        self.versions.setdefault(Key, {})[version_id] = {
            "body": Body,
            "until": datetime.now(UTC) + timedelta(days=self.retain_days),
        }
        return {"VersionId": version_id} if self.return_version_id else {}

    def _version(self, Key: str, VersionId: str | None) -> dict[str, Any]:
        history = self.versions.get(Key)
        if not history:
            raise _FakeClientError("404")
        if VersionId is None:
            return list(history.values())[-1]
        if VersionId not in history:
            raise _FakeClientError("NoSuchVersion")
        return history[VersionId]

    def head_object(
        self, *, Bucket: str, Key: str, VersionId: str | None = None
    ) -> dict[str, Any]:
        self.calls.append("head_object")
        version = self._version(Key, VersionId)
        if not self.lock_objects:
            return {}
        return {
            "ObjectLockMode": "GOVERNANCE",
            "ObjectLockRetainUntilDate": version["until"],
        }

    def get_object(
        self, *, Bucket: str, Key: str, VersionId: str | None = None
    ) -> dict[str, Any]:
        self.calls.append("get_object")
        body: bytes = self._version(Key, VersionId)["body"]
        if self.corrupt_reads:
            body = body + b"-tampered"
        return {"Body": io.BytesIO(body)}

    def get_bucket_versioning(self, *, Bucket: str) -> dict[str, Any]:
        self.calls.append("get_bucket_versioning")
        return {"Status": self.versioning} if self.versioning else {}

    def get_object_lock_configuration(self, *, Bucket: str) -> dict[str, Any]:
        self.calls.append("get_object_lock_configuration")
        if not self.lock:
            raise _FakeClientError("ObjectLockConfigurationNotFoundError")
        rule: dict[str, Any] = {}
        if self.mode:
            retention: dict[str, Any] = {"Mode": self.mode}
            if self.years:
                retention["Years"] = self.years
            if self.days:
                retention["Days"] = self.days
            rule = {"DefaultRetention": retention}
        return {
            "ObjectLockConfiguration": {"ObjectLockEnabled": "Enabled", "Rule": rule}
        }

    def delete_object(self, **_: Any) -> None:
        raise AssertionError("archived history evidence must never be deleted")


class _FakeClientError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


@pytest.fixture(autouse=True)
def reset_history_storage() -> Iterator[None]:
    """Never let one test's history store (or cached protection check) leak."""
    set_history_storage(None)
    yield
    set_history_storage(None)


@pytest.fixture
def protected_history() -> Iterator[tuple[S3HistoryStorage, FakeHistoryS3]]:
    """A protected (locked, versioned) history bucket installed as the history store."""
    fake = FakeHistoryS3()
    store = S3HistoryStorage(bucket="hms-history", client=fake)
    set_history_storage(store)
    yield store, fake


@pytest.fixture
def customer_deletion_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    """Opt a test in to "Delete Customer and Related Data".

    The flag is off by default (as in every deployment); tests that exercise the
    deletion itself ask for it explicitly.
    """
    from hms_backend.app.core.config import settings

    monkeypatch.setattr(settings, "customer_deletion_enabled", True)


@pytest.fixture(autouse=True)
def disable_cache_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep API tests isolated from any developer/Docker Redis instance."""
    monkeypatch.setattr(cache.settings, "cache_enabled", False)
    set_redis_client(None)
    cache.reset_circuit_breaker()
