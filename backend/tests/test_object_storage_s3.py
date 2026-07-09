"""S3 object-storage adapter tests.

A fake boto3-style S3 client stands in for the real service, so these exercise
put/get/exists, key prefixing, server-side encryption arguments, presigned URL
generation, and 404 mapping without any network or AWS credentials.
"""

from __future__ import annotations

from typing import Any

import pytest

import hms_backend.app.core.object_storage as storage_module
from hms_backend.app.core.config import settings
from hms_backend.app.core.object_storage import (
    ObjectNotFoundError,
    PresignedObjectStorage,
    S3ObjectStorage,
)


class _ClientError(Exception):
    """Mimics botocore.exceptions.ClientError enough for the adapter."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class _Body:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self.closed = False

    def read(self) -> bytes:
        return self._data

    def close(self) -> None:
        self.closed = True


class _FakeS3Client:
    def __init__(self) -> None:
        self.store: dict[str, bytes] = {}
        self.puts: list[dict[str, Any]] = []

    def put_object(self, **kwargs: Any) -> dict[str, Any]:
        self.puts.append(kwargs)
        self.store[kwargs["Key"]] = kwargs["Body"]
        return {}

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        if Key not in self.store:
            raise _ClientError("NoSuchKey")
        return {"Body": _Body(self.store[Key])}

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        if Key not in self.store:
            raise _ClientError("404")
        return {}

    def generate_presigned_url(
        self, operation: str, *, Params: dict[str, str], ExpiresIn: int
    ) -> str:
        return (
            f"https://s3.example/{Params['Bucket']}/{Params['Key']}"
            f"?op={operation}&exp={ExpiresIn}"
        )


@pytest.fixture(autouse=True)
def _patch_client_error(monkeypatch: pytest.MonkeyPatch) -> None:
    # The adapter imports botocore lazily inside methods; point that import at
    # our fake exception type so `except ClientError` catches it.
    import types

    fake_botocore = types.ModuleType("botocore")
    fake_exceptions = types.ModuleType("botocore.exceptions")
    fake_exceptions.ClientError = _ClientError  # type: ignore[attr-defined]
    fake_botocore.exceptions = fake_exceptions  # type: ignore[attr-defined]
    monkeypatch.setitem(__import__("sys").modules, "botocore", fake_botocore)
    monkeypatch.setitem(
        __import__("sys").modules, "botocore.exceptions", fake_exceptions
    )


def _storage(client: _FakeS3Client, **kwargs: Any) -> S3ObjectStorage:
    return S3ObjectStorage("hms-media", client=client, **kwargs)


def test_put_get_round_trip() -> None:
    client = _FakeS3Client()
    store = _storage(client)
    assert store.put("certificates/CERT-1-v1.pdf", b"%PDF-1.7") == (
        "certificates/CERT-1-v1.pdf"
    )
    assert store.get("certificates/CERT-1-v1.pdf") == b"%PDF-1.7"


def test_key_prefix_is_transparent() -> None:
    client = _FakeS3Client()
    store = _storage(client, key_prefix="dev/")
    store.put("certificates/CERT-1.pdf", b"data")
    # Stored under the prefixed key...
    assert "dev/certificates/CERT-1.pdf" in client.store
    # ...but callers use the logical key.
    assert store.get("certificates/CERT-1.pdf") == b"data"
    assert store.exists("certificates/CERT-1.pdf") is True


def test_server_side_encryption_applied() -> None:
    client = _FakeS3Client()
    _storage(client).put("k", b"x")
    assert client.puts[0]["ServerSideEncryption"] == "AES256"
    assert client.puts[0]["ContentType"] == "application/pdf"


def test_kms_encryption_args() -> None:
    client = _FakeS3Client()
    _storage(client, sse="aws:kms", sse_kms_key_id="key-123").put("k", b"x")
    assert client.puts[0]["ServerSideEncryption"] == "aws:kms"
    assert client.puts[0]["SSEKMSKeyId"] == "key-123"


def test_get_missing_raises_object_not_found() -> None:
    store = _storage(_FakeS3Client())
    with pytest.raises(ObjectNotFoundError):
        store.get("nope.pdf")


def test_exists_false_for_missing() -> None:
    store = _storage(_FakeS3Client())
    assert store.exists("nope.pdf") is False


def test_presigned_url_uses_expiry_and_prefix() -> None:
    store = _storage(_FakeS3Client(), key_prefix="dev", presign_expiry_seconds=900)
    url = store.presigned_get_url("certificates/CERT-1.pdf")
    assert "hms-media/dev/certificates/CERT-1.pdf" in url
    assert "exp=900" in url
    # Explicit override wins.
    assert "exp=60" in store.presigned_get_url("k", expires_in=60)


def test_satisfies_presigned_protocol() -> None:
    assert isinstance(_storage(_FakeS3Client()), PresignedObjectStorage)


def test_requires_bucket() -> None:
    with pytest.raises(ValueError):
        S3ObjectStorage("")


def test_factory_uses_deployed_object_storage_s3_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    class _SpyStorage:
        def __init__(self, bucket: str, **kwargs: Any) -> None:
            captured["bucket"] = bucket
            captured.update(kwargs)

    monkeypatch.setattr(settings, "object_storage_backend", "s3")
    monkeypatch.setattr(settings, "object_storage_s3_bucket", "hms-dev-media")
    monkeypatch.setattr(settings, "object_storage_s3_region", "ap-southeast-2")
    monkeypatch.setattr(settings, "object_storage_s3_endpoint_url", "")
    monkeypatch.setattr(settings, "object_storage_s3_prefix", "dev/media")
    monkeypatch.setattr(settings, "object_storage_s3_presign_expiry_seconds", 120)
    monkeypatch.setattr(settings, "object_storage_s3_sse", "AES256")
    monkeypatch.setattr(settings, "object_storage_s3_sse_kms_key_id", "")
    monkeypatch.setattr(storage_module, "S3ObjectStorage", _SpyStorage)

    storage_module._build_storage()

    assert captured == {
        "bucket": "hms-dev-media",
        "region": "ap-southeast-2",
        "endpoint_url": "",
        "key_prefix": "dev/media",
        "presign_expiry_seconds": 120,
        "sse": "AES256",
        "sse_kms_key_id": "",
    }
