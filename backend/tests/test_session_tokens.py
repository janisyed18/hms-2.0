"""Opaque token digest tests (Task 2)."""

from __future__ import annotations

import hashlib

from hms_backend.app.core.session_tokens import (
    digest_opaque_token,
    generate_opaque_token,
)


def test_digest_is_sha256_hex() -> None:
    digest = digest_opaque_token("abc")
    assert digest == hashlib.sha256(b"abc").hexdigest()
    assert len(digest) == 64


def test_generate_returns_matching_digest_and_random_url_safe_raw() -> None:
    first = generate_opaque_token()
    second = generate_opaque_token()
    assert first.digest == digest_opaque_token(first.raw)
    assert first.raw != second.raw
    assert first.digest != second.digest
    assert len(first.digest) == 64
    assert all(ch.isalnum() or ch in "-_" for ch in first.raw)
