"""Object storage abstraction for certificate PDFs and media.

Two backends sit behind the same :class:`ObjectStorage` protocol, selected by
``settings.object_storage_backend``:

* ``local`` — a filesystem-backed store rooted at ``settings.object_storage_dir``.
  Fine for a single-node dev box, but not safe when more than one process serves
  requests because a PDF written by one node is invisible to the others.
* ``s3`` — Amazon S3. Required for ECS/Fargate, where every task is ephemeral and
  no local disk is shared. Credentials come from the task/instance role via the
  standard AWS chain, never static keys.

Callers only ever see opaque object keys. An S3-backed store additionally offers
short-lived presigned download URLs (:class:`PresignedObjectStorage`) so the API
can redirect large PDF downloads straight to S3 instead of streaming bytes
through the app.
"""

from __future__ import annotations

import importlib
import os
import posixpath
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol, cast, runtime_checkable
from uuid import uuid4

from hms_backend.app.core.config import settings

S3Client = Any


class ObjectNotFoundError(FileNotFoundError):
    """Raised when an object key does not exist."""


@dataclass(frozen=True)
class StoredObject:
    """One listed object: its opaque key, last write time (UTC) and size."""

    key: str
    last_modified: datetime
    size: int


class ObjectStorage(Protocol):
    def put(
        self, key: str, data: bytes, *, content_type: str = "application/pdf"
    ) -> str: ...

    def get(self, key: str) -> bytes: ...

    def exists(self, key: str) -> bool: ...

    def delete(self, key: str) -> None:
        """Remove an object. Deleting a missing key is not an error."""
        ...

    def list_objects(self, prefix: str) -> list[StoredObject]:
        """Every object whose key starts with ``prefix`` (used for reconciliation)."""
        ...


@runtime_checkable
class PresignedObjectStorage(Protocol):
    """Storage that can mint short-lived, directly-downloadable URLs."""

    def presigned_get_url(
        self,
        key: str,
        *,
        download_filename: str | None = None,
        expires_in: int | None = None,
    ) -> str: ...


_LOCAL_TEMP_MARKER = ".tmp-"


class LocalObjectStorage:
    """Filesystem-backed store. Keys map to paths under ``root``."""

    def __init__(self, root: Path | str) -> None:
        self._root = Path(root).resolve()
        self._root.mkdir(parents=True, exist_ok=True)

    def _resolve(self, key: str) -> Path:
        candidate = (self._root / key).resolve()
        if self._root not in candidate.parents and candidate != self._root:
            raise ValueError(f"object key escapes storage root: {key!r}")
        return candidate

    def put(
        self, key: str, data: bytes, *, content_type: str = "application/pdf"
    ) -> str:
        path = self._resolve(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Write to a sibling temp file and rename, so a crash or failure mid-write can
        # never leave a truncated object at a key that something may reference.
        temp = path.with_name(f"{path.name}{_LOCAL_TEMP_MARKER}{uuid4().hex}")
        try:
            temp.write_bytes(data)
            os.replace(temp, path)
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
        return key

    def get(self, key: str) -> bytes:
        path = self._resolve(key)
        if not path.exists():
            raise ObjectNotFoundError(key)
        return path.read_bytes()

    def exists(self, key: str) -> bool:
        return self._resolve(key).exists()

    def delete(self, key: str) -> None:
        self._resolve(key).unlink(missing_ok=True)

    def list_objects(self, prefix: str) -> list[StoredObject]:
        objects: list[StoredObject] = []
        for path in sorted(self._root.rglob("*")):
            if not path.is_file() or _LOCAL_TEMP_MARKER in path.name:
                continue
            key = path.relative_to(self._root).as_posix()
            if not key.startswith(prefix):
                continue
            stat = path.stat()
            objects.append(
                StoredObject(
                    key=key,
                    last_modified=datetime.fromtimestamp(stat.st_mtime, UTC),
                    size=stat.st_size,
                )
            )
        return objects


def _normalise_object_key(key: str) -> str:
    normalised = posixpath.normpath(key.strip())
    if (
        not normalised
        or normalised == "."
        or normalised == ".."
        or normalised.startswith("../")
        or normalised.startswith("/")
    ):
        raise ValueError(f"invalid object key: {key!r}")
    return normalised


def _create_s3_client(region_name: str, endpoint_url: str = "") -> S3Client:
    boto3 = importlib.import_module("boto3")
    kwargs: dict[str, str] = {}
    if region_name:
        kwargs["region_name"] = region_name
    if endpoint_url:
        kwargs["endpoint_url"] = endpoint_url
    return boto3.client("s3", **kwargs)


def _is_s3_not_found(exc: Exception) -> bool:
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return False
    error = response.get("Error")
    if not isinstance(error, dict):
        return False
    return error.get("Code") in {"404", "NoSuchKey", "NotFound"}


def _is_s3_no_such_version(exc: Exception) -> bool:
    response = getattr(exc, "response", None)
    error = response.get("Error") if isinstance(response, dict) else None
    return isinstance(error, dict) and error.get("Code") in {
        "NoSuchVersion",
        "InvalidArgument",
    }


class S3ObjectStorage:
    """S3-backed object store for AWS deployments."""

    def __init__(
        self,
        *,
        bucket: str,
        prefix: str = "",
        region_name: str = "",
        endpoint_url: str = "",
        presign_expiry_seconds: int = 900,
        sse: str = "AES256",
        sse_kms_key_id: str = "",
        client: S3Client | None = None,
    ) -> None:
        if not bucket.strip():
            raise ValueError("S3 object storage requires a bucket")
        self._bucket = bucket.strip()
        self._prefix = _normalise_object_key(prefix) if prefix.strip() else ""
        self._region_name = region_name
        self._endpoint_url = endpoint_url
        self._presign_expiry_seconds = presign_expiry_seconds
        self._sse = sse
        self._sse_kms_key_id = sse_kms_key_id
        self._client = client

    def _get_client(self) -> S3Client:
        if self._client is None:
            self._client = _create_s3_client(self._region_name, self._endpoint_url)
        return self._client

    def _s3_key(self, key: str) -> str:
        normalised = _normalise_object_key(key)
        if not self._prefix:
            return normalised
        return f"{self._prefix}/{normalised}"

    def _sse_args(self) -> dict[str, str]:
        if self._sse == "aws:kms":
            args = {"ServerSideEncryption": "aws:kms"}
            if self._sse_kms_key_id:
                args["SSEKMSKeyId"] = self._sse_kms_key_id
            return args
        if self._sse:
            return {"ServerSideEncryption": self._sse}
        return {}

    def put(
        self, key: str, data: bytes, *, content_type: str = "application/pdf"
    ) -> str:
        self._get_client().put_object(
            Bucket=self._bucket,
            Key=self._s3_key(key),
            Body=data,
            ContentType=content_type,
            **self._sse_args(),
        )
        return key

    def get(self, key: str) -> bytes:
        try:
            response = self._get_client().get_object(
                Bucket=self._bucket,
                Key=self._s3_key(key),
            )
        except Exception as exc:
            if _is_s3_not_found(exc):
                raise ObjectNotFoundError(key) from exc
            raise
        body = response["Body"]
        try:
            data = body.read()
        finally:
            close = getattr(body, "close", None)
            if callable(close):
                close()
        if not isinstance(data, bytes):
            raise TypeError(f"S3 object body did not return bytes: {key!r}")
        return data

    def exists(self, key: str) -> bool:
        try:
            self._get_client().head_object(Bucket=self._bucket, Key=self._s3_key(key))
        except Exception as exc:
            if _is_s3_not_found(exc):
                return False
            raise
        return True

    def delete(self, key: str) -> None:
        # S3 deletes are idempotent: a missing key is not an error.
        self._get_client().delete_object(Bucket=self._bucket, Key=self._s3_key(key))

    def list_objects(self, prefix: str) -> list[StoredObject]:
        base = f"{self._prefix}/" if self._prefix else ""
        objects: list[StoredObject] = []
        token: str | None = None
        while True:
            kwargs: dict[str, Any] = {
                "Bucket": self._bucket,
                "Prefix": f"{base}{prefix}",
            }
            if token:
                kwargs["ContinuationToken"] = token
            response = self._get_client().list_objects_v2(**kwargs)
            for item in response.get("Contents", []):
                modified = item["LastModified"]
                if modified.tzinfo is None:
                    modified = modified.replace(tzinfo=UTC)
                objects.append(
                    StoredObject(
                        key=item["Key"][len(base) :],
                        last_modified=modified,
                        size=int(item["Size"]),
                    )
                )
            if not response.get("IsTruncated"):
                return objects
            token = response["NextContinuationToken"]

    def presigned_get_url(
        self,
        key: str,
        *,
        download_filename: str | None = None,
        expires_in: int | None = None,
    ) -> str:
        params = {"Bucket": self._bucket, "Key": self._s3_key(key)}
        if download_filename:
            params["ResponseContentDisposition"] = (
                f'attachment; filename="{download_filename}"'
            )
        url = self._get_client().generate_presigned_url(
            "get_object",
            Params=params,
            ExpiresIn=expires_in or self._presign_expiry_seconds,
        )
        return cast(str, url)


class HistoryStorageError(RuntimeError):
    """Archived evidence was not stored (or could not be read) as required.

    ``version_id`` is set when an object version was written before the problem was
    found, so the caller can record it as an orphan for reconciliation.
    """

    def __init__(self, message: str, *, version_id: str | None = None) -> None:
        super().__init__(message)
        self.version_id = version_id


@dataclass(frozen=True)
class StoredEvidence:
    """The exact protected object version a copy of evidence was written as."""

    version_id: str | None
    retention_mode: str | None = None
    retain_until: datetime | None = None


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


class S3HistoryStorage(S3ObjectStorage):
    """S3 store for deleted-customer evidence: write once, never delete.

    The bucket (not this class) provides the protection: versioning plus Object Lock
    default retention, and a bucket policy that denies delete and retention changes
    to the application role. This class adds the checks that fail the archive closed
    when that protection is missing: the written *version* is pinned and must come
    back locked for at least the batch retention, and :meth:`check_protection`
    reports a bucket that is not configured as required.
    """

    protected = True

    def put_evidence(
        self,
        key: str,
        data: bytes,
        *,
        content_type: str,
        min_retain_until: datetime | None = None,
    ) -> StoredEvidence:
        s3_key = self._s3_key(key)
        client = self._get_client()
        args: dict[str, Any] = {
            "Bucket": self._bucket,
            "Key": s3_key,
            "Body": data,
            "ContentType": content_type,
            **self._sse_args(),
        }
        response = client.put_object(**args)
        version_id = response.get("VersionId")
        if not version_id:
            raise HistoryStorageError(
                "the archived file was stored without a version id (bucket "
                "versioning is not enabled)"
            )
        try:
            head = client.head_object(
                Bucket=self._bucket, Key=s3_key, VersionId=version_id
            )
        except Exception as exc:
            # The version exists; keep its id so the caller records the orphan.
            raise HistoryStorageError(
                f"the archived file's retention could not be verified "
                f"({type(exc).__name__})",
                version_id=version_id,
            ) from exc
        mode = head.get("ObjectLockMode")
        until = head.get("ObjectLockRetainUntilDate")
        if mode not in {"GOVERNANCE", "COMPLIANCE"} or until is None:
            raise HistoryStorageError(
                "the archived file was stored without Object Lock retention",
                version_id=version_id,
            )
        until = _aware(until)
        if until <= datetime.now(UTC):
            raise HistoryStorageError(
                "the archived file's retention has already ended",
                version_id=version_id,
            )
        if min_retain_until is not None and until < _aware(min_retain_until):
            raise HistoryStorageError(
                "the archived file's retention is shorter than the batch retention",
                version_id=version_id,
            )
        return StoredEvidence(version_id, mode, until)

    def put(
        self, key: str, data: bytes, *, content_type: str = "application/pdf"
    ) -> str:
        self.put_evidence(key, data, content_type=content_type)
        return key

    def get_version(self, key: str, version_id: str) -> bytes:
        try:
            response = self._get_client().get_object(
                Bucket=self._bucket, Key=self._s3_key(key), VersionId=version_id
            )
        except Exception as exc:
            if _is_s3_not_found(exc) or _is_s3_no_such_version(exc):
                raise ObjectNotFoundError(key) from exc
            raise
        return cast(bytes, response["Body"].read())

    def describe_version(self, key: str, version_id: str) -> StoredEvidence:
        try:
            head = self._get_client().head_object(
                Bucket=self._bucket, Key=self._s3_key(key), VersionId=version_id
            )
        except Exception as exc:
            if _is_s3_not_found(exc) or _is_s3_no_such_version(exc):
                raise ObjectNotFoundError(key) from exc
            raise
        until = head.get("ObjectLockRetainUntilDate")
        return StoredEvidence(
            version_id,
            head.get("ObjectLockMode"),
            _aware(until) if until is not None else None,
        )

    def delete(self, key: str) -> None:
        raise PermissionError("archived history evidence is never deleted by the app")

    def check_protection(self, *, min_retention_days: int) -> list[str]:
        """What is wrong with the bucket; an empty list means it is as required."""
        problems: list[str] = []
        client = self._get_client()
        try:
            versioning = client.get_bucket_versioning(Bucket=self._bucket)
            if versioning.get("Status") != "Enabled":
                problems.append("bucket versioning is not enabled")
        except Exception as exc:
            problems.append(
                f"bucket versioning could not be read ({type(exc).__name__})"
            )
        try:
            config = client.get_object_lock_configuration(Bucket=self._bucket)[
                "ObjectLockConfiguration"
            ]
        except Exception as exc:
            problems.append(f"Object Lock is not enabled ({type(exc).__name__})")
            return problems
        if config.get("ObjectLockEnabled") != "Enabled":
            problems.append("Object Lock is not enabled")
        retention = (config.get("Rule") or {}).get("DefaultRetention") or {}
        if retention.get("Mode") not in {"GOVERNANCE", "COMPLIANCE"}:
            problems.append("no default retention mode is set")
        days = int(retention.get("Days") or 0) + 365 * int(retention.get("Years") or 0)
        if days < min_retention_days:
            problems.append(
                f"default retention ({days} days) is shorter than the configured "
                f"history retention ({min_retention_days} days)"
            )
        return problems


def put_evidence(
    storage: ObjectStorage,
    key: str,
    data: bytes,
    *,
    content_type: str,
    min_retain_until: datetime | None = None,
) -> StoredEvidence:
    """Write evidence and say exactly which version (and retention) was stored.

    The local/test fallback has no versions or locks; it returns a null version.
    """
    if isinstance(storage, S3HistoryStorage):
        return storage.put_evidence(
            key, data, content_type=content_type, min_retain_until=min_retain_until
        )
    storage.put(key, data, content_type=content_type)
    return StoredEvidence(None)


def get_evidence(storage: ObjectStorage, key: str, version_id: str | None) -> bytes:
    """Read evidence at the pinned version; never whatever is newest at the key."""
    if isinstance(storage, S3HistoryStorage):
        if not version_id:
            raise HistoryStorageError("the archived file has no pinned version")
        return storage.get_version(key, version_id)
    return storage.get(key)


def describe_evidence(
    storage: ObjectStorage, key: str, version_id: str | None
) -> StoredEvidence | None:
    """Retention now applied to the pinned version; None for unprotected stores."""
    if isinstance(storage, S3HistoryStorage):
        if not version_id:
            raise HistoryStorageError("the archived file has no pinned version")
        return storage.describe_version(key, version_id)
    return None


class HistoryStorageUnavailable(RuntimeError):
    """Deleting customers is refused because protected storage is not ready."""


_history_storage: ObjectStorage | None = None
_protection_checked_at: float | None = None
_protection_problems: list[str] = []


def get_history_storage() -> ObjectStorage:
    """The store for archived evidence.

    A configured history bucket always wins. Without one, local and test runs use the
    ordinary store so developers need no AWS; any other environment is refused,
    because evidence kept in the shared media bucket is not protected.
    """
    global _history_storage
    if _history_storage is None:
        bucket = settings.history_object_storage_s3_bucket.strip()
        if bucket:
            _history_storage = S3HistoryStorage(
                bucket=bucket,
                region_name=settings.object_storage_s3_region,
                endpoint_url=settings.object_storage_s3_endpoint_url,
                sse=settings.object_storage_s3_sse,
                sse_kms_key_id=settings.object_storage_s3_sse_kms_key_id,
            )
        elif settings.is_local_or_test:
            return get_object_storage()
        else:
            raise HistoryStorageUnavailable(
                "protected history storage is not configured"
            )
    return _history_storage


def set_history_storage(storage: ObjectStorage | None) -> None:
    """Override the history store and forget any cached protection result (tests)."""
    global _history_storage, _protection_checked_at
    _history_storage = storage
    _protection_checked_at = None


def history_storage_problems() -> list[str]:
    """Why archived evidence cannot be trusted right now; empty when it can.

    Cached for ``history_storage_check_ttl_seconds`` so the answer is cheap on every
    request but a misconfigured bucket is noticed within minutes.
    """
    global _protection_checked_at, _protection_problems
    try:
        storage = get_history_storage()
    except HistoryStorageUnavailable as exc:
        return [str(exc)]
    if not isinstance(storage, S3HistoryStorage):
        return []  # local/test fallback: there is nothing to check
    now = time.monotonic()
    ttl = settings.history_storage_check_ttl_seconds
    if _protection_checked_at is None or now - _protection_checked_at >= ttl:
        _protection_problems = storage.check_protection(
            min_retention_days=settings.history_retention_period_days
        )
        _protection_checked_at = now
    return list(_protection_problems)


_storage: ObjectStorage | None = None


def _build_storage() -> ObjectStorage:
    if settings.object_storage_backend == "s3":
        return S3ObjectStorage(
            bucket=settings.object_storage_s3_bucket,
            prefix=settings.object_storage_s3_prefix,
            region_name=settings.object_storage_s3_region,
            endpoint_url=settings.object_storage_s3_endpoint_url,
            presign_expiry_seconds=settings.object_storage_s3_presign_expiry_seconds,
            sse=settings.object_storage_s3_sse,
            sse_kms_key_id=settings.object_storage_s3_sse_kms_key_id,
        )
    return LocalObjectStorage(settings.object_storage_dir)


def get_object_storage() -> ObjectStorage:
    """Return the process-wide storage instance for the configured backend."""
    global _storage
    if _storage is None:
        _storage = _build_storage()
    return _storage


def set_object_storage(storage: ObjectStorage | None) -> None:
    """Override the process-wide storage instance (used by tests)."""
    global _storage
    _storage = storage
