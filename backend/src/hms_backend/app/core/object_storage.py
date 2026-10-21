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
