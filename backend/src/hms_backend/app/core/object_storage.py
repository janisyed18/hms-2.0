"""Object storage abstraction for certificate PDFs and media.

Two backends sit behind the same :class:`ObjectStorage` protocol, selected by
``settings.object_storage_backend``:

* ``local`` — a filesystem-backed store rooted at ``settings.object_storage_dir``.
  Fine for a single-node dev box, but NOT safe when more than one process serves
  requests: a PDF written by one node is invisible to the others.
* ``s3`` — Amazon S3. Required for ECS/Fargate, where every task is ephemeral and
  no local disk is shared. Credentials come from the task/instance role via the
  standard AWS chain — never static keys.

Callers only ever see opaque object keys. An S3-backed store additionally offers
short-lived presigned download URLs (:class:`PresignedObjectStorage`) so the API
can redirect large PDF downloads straight to S3 instead of streaming bytes
through the app.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Protocol, runtime_checkable

from hms_backend.app.core.config import settings

if TYPE_CHECKING:  # pragma: no cover - typing only
    from mypy_boto3_s3 import S3Client
else:  # runtime: boto3 is optional and only imported for the S3 backend
    S3Client = object


class ObjectNotFoundError(FileNotFoundError):
    """Raised when an object key does not exist."""


class ObjectStorage(Protocol):
    def put(
        self, key: str, data: bytes, *, content_type: str = "application/pdf"
    ) -> str: ...

    def get(self, key: str) -> bytes: ...

    def exists(self, key: str) -> bool: ...


@runtime_checkable
class PresignedObjectStorage(Protocol):
    """Storage that can mint short-lived, directly-downloadable URLs."""

    def presigned_get_url(self, key: str, *, expires_in: int | None = None) -> str: ...


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


class S3ObjectStorage:
    """Amazon S3-backed store.

    The boto3 client is created lazily so importing this module never requires
    boto3 or AWS configuration (dev/tests use the local backend). Credentials are
    resolved by boto3's default chain — on ECS/Fargate that is the task role, so
    no access keys are stored anywhere.

    Server-side encryption is applied on every upload. A ``key_prefix`` can carve
    out a namespace within a shared bucket; it is transparent to callers, who
    always pass and receive the logical (unprefixed) key.
    """

    def __init__(
        self,
        bucket: str,
        *,
        region: str = "",
        endpoint_url: str = "",
        key_prefix: str = "",
        presign_expiry_seconds: int = 900,
        sse: str = "AES256",
        sse_kms_key_id: str = "",
        client: S3Client | None = None,
    ) -> None:
        if not bucket:
            raise ValueError("S3 object storage requires a bucket name")
        self._bucket = bucket
        self._region = region
        self._endpoint_url = endpoint_url
        self._prefix = key_prefix.strip("/")
        self._presign_expiry = presign_expiry_seconds
        self._sse = sse
        self._sse_kms_key_id = sse_kms_key_id
        self._client = client

    # -- client / key helpers ----------------------------------------------------

    def _get_client(self) -> S3Client:
        if self._client is None:
            import boto3  # imported lazily; only the S3 backend needs it

            kwargs: dict[str, str] = {}
            if self._region:
                kwargs["region_name"] = self._region
            if self._endpoint_url:
                kwargs["endpoint_url"] = self._endpoint_url
            self._client = boto3.client("s3", **kwargs)
        return self._client

    def _object_key(self, key: str) -> str:
        return f"{self._prefix}/{key}" if self._prefix else key

    def _sse_args(self) -> dict[str, str]:
        if self._sse == "aws:kms":
            args = {"ServerSideEncryption": "aws:kms"}
            if self._sse_kms_key_id:
                args["SSEKMSKeyId"] = self._sse_kms_key_id
            return args
        if self._sse:
            return {"ServerSideEncryption": self._sse}
        return {}

    # -- ObjectStorage protocol --------------------------------------------------

    def put(
        self, key: str, data: bytes, *, content_type: str = "application/pdf"
    ) -> str:
        self._get_client().put_object(
            Bucket=self._bucket,
            Key=self._object_key(key),
            Body=data,
            ContentType=content_type,
            **self._sse_args(),
        )
        return key

    def get(self, key: str) -> bytes:
        from botocore.exceptions import ClientError

        try:
            response = self._get_client().get_object(
                Bucket=self._bucket, Key=self._object_key(key)
            )
        except ClientError as exc:
            if _is_not_found(exc):
                raise ObjectNotFoundError(key) from exc
            raise
        body = response["Body"]
        try:
            return body.read()  # type: ignore[no-any-return]
        finally:
            body.close()

    def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError

        try:
            self._get_client().head_object(
                Bucket=self._bucket, Key=self._object_key(key)
            )
        except ClientError as exc:
            if _is_not_found(exc):
                return False
            raise
        return True

    # -- PresignedObjectStorage --------------------------------------------------

    def presigned_get_url(self, key: str, *, expires_in: int | None = None) -> str:
        return self._get_client().generate_presigned_url(
            "get_object",
            Params={"Bucket": self._bucket, "Key": self._object_key(key)},
            ExpiresIn=expires_in or self._presign_expiry,
        )


def _is_not_found(exc: Exception) -> bool:
    """True when a botocore ClientError represents a missing object."""
    error = getattr(exc, "response", {}).get("Error", {})
    code = str(error.get("Code", ""))
    return code in {"NoSuchKey", "NotFound", "404"}


_storage: ObjectStorage | None = None


def _build_storage() -> ObjectStorage:
    if settings.object_storage_backend == "s3":
        return S3ObjectStorage(
            settings.s3_bucket,
            region=settings.s3_region,
            endpoint_url=settings.s3_endpoint_url,
            key_prefix=settings.s3_key_prefix,
            presign_expiry_seconds=settings.s3_presign_expiry_seconds,
            sse=settings.s3_sse,
            sse_kms_key_id=settings.s3_sse_kms_key_id,
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
