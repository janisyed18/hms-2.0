"""Object storage abstraction for certificate PDFs and media.

Local development uses a filesystem-backed store rooted at
``settings.object_storage_dir``. Production swaps in an OCI Object Storage
implementation behind the same :class:`ObjectStorage` protocol — callers only ever
see opaque object keys and short-lived access via the API, never a bucket SDK.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

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


_storage: ObjectStorage | None = None


def get_object_storage() -> ObjectStorage:
    """Return the process-wide storage instance (local FS in dev)."""
    global _storage
    if _storage is None:
        _storage = LocalObjectStorage(settings.object_storage_dir)
    return _storage
