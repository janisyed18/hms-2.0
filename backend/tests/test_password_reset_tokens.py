from __future__ import annotations

import base64

import pytest

from hms_backend.app.core.config import Settings
from hms_backend.app.core.password_reset_tokens import (
    decrypt_password_reset_delivery,
    digest_password_reset_secret,
    encrypt_password_reset_delivery,
    generate_password_reset_secret,
)


def test_generated_secret_is_url_safe_and_digest_is_one_way() -> None:
    secret = generate_password_reset_secret()

    assert len(secret.raw) >= 40
    assert secret.digest == digest_password_reset_secret(secret.raw)
    assert secret.raw not in secret.digest


def test_delivery_envelope_round_trips_with_reset_record_aad() -> None:
    key = base64.urlsafe_b64encode(b"r" * 32).decode("ascii")
    config = Settings(
        auth_password_reset_encryption_key=key,
        auth_password_reset_key_version=3,
    )
    secret = generate_password_reset_secret()

    envelope = encrypt_password_reset_delivery(
        secret.raw,
        reset_id="reset-1",
        user_id="user-1",
        config=config,
    )

    assert envelope.key_version == 3
    assert secret.raw not in envelope.ciphertext
    assert (
        decrypt_password_reset_delivery(
            envelope,
            reset_id="reset-1",
            user_id="user-1",
            config=config,
        )
        == secret.raw
    )


def test_delivery_envelope_rejects_wrong_authenticated_context() -> None:
    key = base64.urlsafe_b64encode(b"s" * 32).decode("ascii")
    config = Settings(auth_password_reset_encryption_key=key)
    secret = generate_password_reset_secret()
    envelope = encrypt_password_reset_delivery(
        secret.raw,
        reset_id="reset-1",
        user_id="user-1",
        config=config,
    )

    with pytest.raises(ValueError, match="could not decrypt"):
        decrypt_password_reset_delivery(
            envelope,
            reset_id="reset-2",
            user_id="user-1",
            config=config,
        )
