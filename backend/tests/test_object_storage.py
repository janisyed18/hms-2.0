from __future__ import annotations

from typing import Any

import pytest

import hms_backend.app.core.object_storage as storage_module
from hms_backend.app.core.config import settings
from hms_backend.app.core.object_storage import ObjectNotFoundError, S3ObjectStorage


class _FakeS3Error(Exception):
    def __init__(self, code: str) -> None:
        self.response = {"Error": {"Code": code}}


class _FakeBody:
    def __init__(self, data: bytes) -> None:
        self._data = data

    def read(self) -> bytes:
        return self._data


class _FakeS3Client:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], dict[str, Any]] = {}

    def put_object(
        self,
        *,
        Bucket: str,
        Key: str,
        Body: bytes,
        ContentType: str,
    ) -> dict[str, object]:
        self.objects[(Bucket, Key)] = {
            "Body": Body,
            "ContentType": ContentType,
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


def test_s3_object_storage_reports_missing_objects() -> None:
    storage = S3ObjectStorage(
        bucket="hms-dev-media",
        prefix="dev/media",
        client=_FakeS3Client(),
    )

    assert storage.exists("certificates/missing.pdf") is False
    with pytest.raises(ObjectNotFoundError):
        storage.get("certificates/missing.pdf")


def test_s3_object_storage_rejects_escaping_keys() -> None:
    storage = S3ObjectStorage(
        bucket="hms-dev-media",
        prefix="dev/media",
        client=_FakeS3Client(),
    )

    with pytest.raises(ValueError):
        storage.put("../secret.pdf", b"data")


def test_storage_factory_selects_s3_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_client = _FakeS3Client()
    monkeypatch.setattr(settings, "object_storage_backend", "s3")
    monkeypatch.setattr(settings, "object_storage_s3_bucket", "hms-dev")
    monkeypatch.setattr(settings, "object_storage_s3_prefix", "media")
    monkeypatch.setattr(
        settings,
        "object_storage_s3_region",
        "ap-southeast-2",
    )
    monkeypatch.setattr(storage_module, "_storage", None)
    monkeypatch.setattr(
        storage_module,
        "_create_s3_client",
        lambda region_name: fake_client,
    )

    storage = storage_module.get_object_storage()

    assert isinstance(storage, S3ObjectStorage)
    storage.put("certificates/CERT-2.pdf", b"pdf")
    assert fake_client.objects[("hms-dev", "media/certificates/CERT-2.pdf")][
        "Body"
    ] == b"pdf"
