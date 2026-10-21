from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

import hms_backend.app.core.object_storage as storage_module
from hms_backend.app.core.config import settings
from hms_backend.app.core.object_storage import (
    ObjectNotFoundError,
    PresignedObjectStorage,
    S3ObjectStorage,
)


class _FakeS3Error(Exception):
    def __init__(self, code: str) -> None:
        self.response = {"Error": {"Code": code}}


class _FakeBody:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self.closed = False

    def read(self) -> bytes:
        return self._data

    def close(self) -> None:
        self.closed = True


class _FakeS3Client:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], dict[str, Any]] = {}
        self.last_presign_params: dict[str, str] = {}

    def put_object(
        self,
        *,
        Bucket: str,
        Key: str,
        Body: bytes,
        ContentType: str,
        **kwargs: Any,
    ) -> dict[str, object]:
        self.objects[(Bucket, Key)] = {
            "Body": Body,
            "ContentType": ContentType,
            **kwargs,
        }
        return {}

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, object]:
        try:
            stored = self.objects[(Bucket, Key)]
        except KeyError as exc:
            raise _FakeS3Error("NoSuchKey") from exc
        return {"Body": _FakeBody(stored["Body"])}

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, object]:
        if (Bucket, Key) not in self.objects:
            raise _FakeS3Error("404")
        return {}

    def delete_object(self, *, Bucket: str, Key: str) -> dict[str, object]:
        # Like S3, deleting a missing key succeeds.
        self.objects.pop((Bucket, Key), None)
        return {}

    def list_objects_v2(
        self,
        *,
        Bucket: str,
        Prefix: str = "",
        ContinuationToken: str | None = None,
    ) -> dict[str, object]:
        page_size = 2
        keys = sorted(
            key
            for (bucket, key) in self.objects
            if bucket == Bucket and key.startswith(Prefix)
        )
        start = int(ContinuationToken) if ContinuationToken else 0
        page = keys[start : start + page_size]
        response: dict[str, object] = {
            "Contents": [
                {
                    "Key": key,
                    "LastModified": datetime(2026, 1, 1, tzinfo=UTC),
                    "Size": len(self.objects[(Bucket, key)]["Body"]),
                }
                for key in page
            ],
            "IsTruncated": start + page_size < len(keys),
        }
        if response["IsTruncated"]:
            response["NextContinuationToken"] = str(start + page_size)
        return response

    def generate_presigned_url(
        self,
        operation: str,
        *,
        Params: dict[str, str],
        ExpiresIn: int,
    ) -> str:
        self.last_presign_params = Params
        return (
            f"https://s3.example/{Params['Bucket']}/{Params['Key']}"
            f"?op={operation}&exp={ExpiresIn}"
        )


def test_s3_object_storage_round_trips_with_prefix() -> None:
    client = _FakeS3Client()
    storage = S3ObjectStorage(
        bucket="hms-dev-media",
        prefix="dev/media",
        client=client,
    )

    returned_key = storage.put(
        "certificates/CERT-1.pdf",
        b"%PDF-1.7",
        content_type="application/pdf",
    )

    assert returned_key == "certificates/CERT-1.pdf"
    assert storage.exists("certificates/CERT-1.pdf") is True
    assert storage.get("certificates/CERT-1.pdf") == b"%PDF-1.7"
    assert client.objects[
        ("hms-dev-media", "dev/media/certificates/CERT-1.pdf")
    ]["ContentType"] == "application/pdf"
    assert client.objects[("hms-dev-media", "dev/media/certificates/CERT-1.pdf")][
        "ServerSideEncryption"
    ] == "AES256"


def test_s3_object_storage_reports_missing_objects() -> None:
    storage = S3ObjectStorage(
        bucket="hms-dev-media",
        prefix="dev/media",
        client=_FakeS3Client(),
    )

    assert storage.exists("certificates/missing.pdf") is False
    with pytest.raises(ObjectNotFoundError):
        storage.get("certificates/missing.pdf")


def test_s3_object_storage_delete_is_idempotent_and_prefix_scoped() -> None:
    client = _FakeS3Client()
    storage = S3ObjectStorage(
        bucket="hms-dev-media", prefix="dev/media", client=client
    )
    storage.put("certificates/a/v1.pdf", b"a")

    storage.delete("certificates/a/v1.pdf")
    storage.delete("certificates/a/v1.pdf")  # already gone: not an error

    assert storage.exists("certificates/a/v1.pdf") is False
    assert client.objects == {}


def test_s3_object_storage_lists_by_prefix_across_pages_with_keys_unprefixed() -> None:
    client = _FakeS3Client()
    storage = S3ObjectStorage(
        bucket="hms-dev-media", prefix="dev/media", client=client
    )
    for name in ("a", "b", "c", "d", "e"):
        storage.put(f"certificates/{name}/v1.pdf", name.encode())
    storage.put("media/other.png", b"x")
    client.objects[("hms-dev-media", "elsewhere/certificates/z.pdf")] = {"Body": b"z"}

    listed = storage.list_objects("certificates/")

    # Five objects over three pages; keys come back without the configured prefix,
    # and objects outside the prefix (or another prefix) are not listed.
    assert [o.key for o in listed] == [f"certificates/{n}/v1.pdf" for n in "abcde"]
    assert {o.size for o in listed} == {1}
    assert all(o.last_modified.tzinfo is not None for o in listed)


def test_s3_object_storage_rejects_escaping_keys() -> None:
    storage = S3ObjectStorage(
        bucket="hms-dev-media",
        prefix="dev/media",
        client=_FakeS3Client(),
    )

    with pytest.raises(ValueError):
        storage.put("../secret.pdf", b"data")


def test_s3_object_storage_presigns_downloads_with_prefix() -> None:
    storage = S3ObjectStorage(
        bucket="hms-dev-media",
        prefix="dev/media",
        presign_expiry_seconds=900,
        client=_FakeS3Client(),
    )

    url = storage.presigned_get_url("certificates/CERT-1.pdf")

    assert "hms-dev-media/dev/media/certificates/CERT-1.pdf" in url
    assert "exp=900" in url
    assert "exp=60" in storage.presigned_get_url("k", expires_in=60)
    assert isinstance(storage, PresignedObjectStorage)


def test_s3_object_storage_presigns_attachment_downloads() -> None:
    client = _FakeS3Client()
    storage = S3ObjectStorage(bucket="hms-dev-media", client=client)

    storage.presigned_get_url(
        "certificates/CERT-1.pdf",
        download_filename="CERT-1.pdf",
    )

    # S3 receives the response header override as part of the signed request.
    assert client.last_presign_params["ResponseContentDisposition"] == (
        'attachment; filename="CERT-1.pdf"'
    )


def test_storage_factory_selects_s3_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_client = _FakeS3Client()
    monkeypatch.setattr(settings, "object_storage_backend", "s3")
    monkeypatch.setattr(settings, "object_storage_s3_bucket", "hms-dev-media")
    monkeypatch.setattr(settings, "object_storage_s3_prefix", "dev/media")
    monkeypatch.setattr(
        settings,
        "object_storage_s3_region",
        "ap-southeast-2",
    )
    monkeypatch.setattr(settings, "object_storage_s3_endpoint_url", "")
    monkeypatch.setattr(settings, "object_storage_s3_presign_expiry_seconds", 120)
    monkeypatch.setattr(settings, "object_storage_s3_sse", "AES256")
    monkeypatch.setattr(settings, "object_storage_s3_sse_kms_key_id", "")
    monkeypatch.setattr(storage_module, "_storage", None)
    monkeypatch.setattr(
        storage_module,
        "_create_s3_client",
        lambda region_name, endpoint_url="": fake_client,
    )

    storage = storage_module.get_object_storage()

    assert isinstance(storage, S3ObjectStorage)
    storage.put("certificates/CERT-2.pdf", b"pdf")
    assert fake_client.objects[("hms-dev-media", "dev/media/certificates/CERT-2.pdf")][
        "Body"
    ] == b"pdf"
