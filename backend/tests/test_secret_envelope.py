from __future__ import annotations

import base64

import pytest
from cryptography.exceptions import InvalidTag

from hms_backend.app.core.config import settings
from hms_backend.app.core.secret_envelope import (
    SealedSecret,
    open_secret,
    seal_secret,
)


@pytest.fixture(autouse=True)
def _password_reset_keyring(monkeypatch: pytest.MonkeyPatch) -> None:
    key = base64.urlsafe_b64encode(b"k" * 32).decode("ascii")
    monkeypatch.setattr(settings, "auth_password_reset_keys", {1: key})
    monkeypatch.setattr(settings, "auth_password_reset_key_version", 1)


def test_secret_envelope_round_trips_with_random_ciphertext() -> None:
    value = "reset-secret"
    context = "reset-1:user-1"

    sealed = seal_secret(value, context)
    resealed = seal_secret(value, context)

    assert sealed.key_version == 1
    assert sealed.ciphertext != value
    assert resealed.ciphertext != sealed.ciphertext
    assert open_secret(sealed, context) == value


def test_serialized_envelope_prefixes_exactly_12_byte_nonce(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    nonce = bytes(range(12))

    def fixed_nonce(size: int) -> bytes:
        assert size == 12
        return nonce

    monkeypatch.setattr(
        "hms_backend.app.core.secret_envelope.secrets.token_bytes",
        fixed_nonce,
    )

    value = "reset-secret"
    sealed = seal_secret(value, "reset-1:user-1")
    serialized = base64.b64decode(
        sealed.ciphertext,
        altchars=b"-_",
        validate=True,
    )

    assert serialized[:12] == nonce
    assert len(serialized) == 12 + len(value.encode("utf-8")) + 16


def test_secret_envelope_rejects_different_context() -> None:
    sealed = seal_secret("reset-secret", "reset-1:user-1")

    with pytest.raises(InvalidTag):
        open_secret(sealed, "reset-1:user-2")


def test_secret_envelope_opens_previous_key_version_after_rotation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    version_1_key = settings.auth_password_reset_keys[1]
    sealed = seal_secret("reset-secret", "reset-1:user-1")
    version_2_key = base64.urlsafe_b64encode(b"v" * 32).decode("ascii")
    monkeypatch.setattr(
        settings,
        "auth_password_reset_keys",
        {1: version_1_key, 2: version_2_key},
    )
    monkeypatch.setattr(settings, "auth_password_reset_key_version", 2)

    assert sealed.key_version == 1
    assert open_secret(sealed, "reset-1:user-1") == "reset-secret"


def test_secret_envelope_rejects_key_that_is_not_32_bytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    invalid_key = base64.urlsafe_b64encode(b"short").decode("ascii")
    monkeypatch.setattr(settings, "auth_password_reset_keys", {1: invalid_key})

    with pytest.raises(RuntimeError, match="decode to 32 bytes"):
        seal_secret("reset-secret", "reset-1:user-1")


@pytest.mark.parametrize(
    "malformed_key",
    [
        "!!!!" + base64.urlsafe_b64encode(b"k" * 32).decode("ascii"),
        base64.urlsafe_b64encode(b"k" * 32).decode("ascii") + "\n",
        base64.b64encode(b"\xff" * 32).decode("ascii"),
        base64.urlsafe_b64encode(b"k" * 32).decode("ascii")[:-2] + "t=",
    ],
)
def test_secret_envelope_rejects_invalid_base64url_key_syntax(
    monkeypatch: pytest.MonkeyPatch,
    malformed_key: str,
) -> None:
    assert len(base64.urlsafe_b64decode(malformed_key)) == 32
    monkeypatch.setattr(settings, "auth_password_reset_keys", {1: malformed_key})

    with pytest.raises(RuntimeError, match="decode to 32 bytes"):
        seal_secret("reset-secret", "reset-1:user-1")


def test_secret_envelope_rejects_unknown_key_version() -> None:
    sealed = SealedSecret(ciphertext="unused", key_version=2)

    with pytest.raises(
        RuntimeError,
        match="No password reset key configured for version 2",
    ):
        open_secret(sealed, "reset-1:user-1")


def test_secret_envelope_rejects_invalid_base64url_ciphertext_prefix() -> None:
    sealed = seal_secret("reset-secret", "reset-1:user-1")
    malformed = SealedSecret(
        ciphertext="!!!!" + sealed.ciphertext,
        key_version=sealed.key_version,
    )

    with pytest.raises(ValueError, match="valid Base64URL"):
        open_secret(malformed, "reset-1:user-1")
