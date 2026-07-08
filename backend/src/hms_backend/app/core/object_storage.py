"""Object storage abstraction for certificate PDFs and media.

Local development uses a filesystem-backed store rooted at
``settings.object_storage_dir``. AWS deployments use S3 behind the same
:class:`ObjectStorage` protocol — callers only ever see opaque object keys and
short-lived access via the API, never a bucket SDK.
"""

from __future__ import annotations

import importlib
import posixpath
from pathlib import Path
from typing import Any, Protocol

from hms_backend.app.core.config import settings


class ObjectNotFoundError(FileNotFoundError):
    """Raised when an object key does not exist."""


class ObjectStorage(Protocol):
    def put(
        self, key: str, data: bytes, *, content_type: str = "application/pdf"
    ) -> str: ...

    def get(self, key: str) -> bytes: ...

    def exists(self, key: str) -> bool: ...


class LocalObjectStorage:
    """Filesystem-backed store. Keys map to paths under ``root``.

    Keys are validated to prevent path traversal outside the storage root.
    """

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
        path.write_bytes(data)
        return key

    def get(self, key: str) -> bytes:
        path = self._resolve(key)
        if not path.exists():
            raise ObjectNotFoundError(key)
        return path.read_bytes()

    def exists(self, key: str) -> bool:
        return self._resolve(key).exists()


def _normalise_object_key(key: str) -> str:
    normalised = posixpath.normpath(key.strip())
    if (
        not normalised
        or normalised == "."
        or normalised.startswith("../")
        or normalised == ".."
        or normalised.startswith("/")
    ):
        raise ValueError(f"invalid object key: {key!r}")
    return normalised


def _create_s3_client(region_name: str) -> Any:
    boto3 = importlib.import_module("boto3")
    kwargs = {"region_name": region_name} if region_name else {}
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
        client: Any | None = None,
    ) -> None:
        if not bucket.strip():
            raise ValueError("S3 object storage requires a bucket")
        self._bucket = bucket.strip()
        self._prefix = _normalise_object_key(prefix) if prefix.strip() else ""
        self._client = client or _create_s3_client(region_name)

    def _s3_key(self, key: str) -> str:
        normalised = _normalise_object_key(key)
        if not self._prefix:
            return normalised
        return f"{self._prefix}/{normalised}"

    def put(
        self, key: str, data: bytes, *, content_type: str = "application/pdf"
    ) -> str:
        self._client.put_object(
            Bucket=self._bucket,
            Key=self._s3_key(key),
            Body=data,
            ContentType=content_type,
        )
        return key

    def get(self, key: str) -> bytes:
        try:
            response = self._client.get_object(
                Bucket=self._bucket,
                Key=self._s3_key(key),
            )
        except Exception as exc:
            if _is_s3_not_found(exc):
                raise ObjectNotFoundError(key) from exc
            raise
        body = response["Body"]
        data = body.read()
        if not isinstance(data, bytes):
            raise TypeError(f"S3 object body did not return bytes: {key!r}")
        return data

    def exists(self, key: str) -> bool:
        try:
            self._client.head_object(Bucket=self._bucket, Key=self._s3_key(key))
        except Exception as exc:
            if _is_s3_not_found(exc):
                return False
            raise
        return True


_storage: ObjectStorage | None = None


def get_object_storage() -> ObjectStorage:
    """Return the process-wide storage instance."""
    global _storage
    if _storage is None:
        if settings.object_storage_backend == "s3":
            _storage = S3ObjectStorage(
                bucket=settings.object_storage_s3_bucket,
                prefix=settings.object_storage_s3_prefix,
                region_name=settings.object_storage_s3_region,
            )
        else:
            _storage = LocalObjectStorage(settings.object_storage_dir)
    return _storage
