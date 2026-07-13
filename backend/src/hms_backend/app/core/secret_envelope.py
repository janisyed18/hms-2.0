"""Versioned authenticated encryption for short-lived application secrets."""

from __future__ import annotations

import base64
import binascii
import re
import secrets
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hms_backend.app.core.config import settings

_NONCE_BYTES = 12
_BASE64URL_PATTERN = re.compile(r"[A-Za-z0-9_-]+={0,2}")


@dataclass(frozen=True)
class SealedSecret:
    ciphertext: str
    key_version: int


def _decode_base64url(raw: str) -> bytes:
    if not _BASE64URL_PATTERN.fullmatch(raw):
        raise ValueError("Value must be valid Base64URL")
    padded = raw + "=" * (-len(raw) % 4)
    try:
        decoded = base64.b64decode(padded, altchars=b"-_", validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("Value must be valid Base64URL") from None
    canonical = base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=")
    if raw.rstrip("=") != canonical:
        raise ValueError("Value must be valid Base64URL")
    return decoded


def _decode_key(raw: str) -> bytes:
    try:
        key = _decode_base64url(raw)
    except ValueError:
        raise RuntimeError(
            "AUTH_PASSWORD_RESET_KEYS values must decode to 32 bytes"
        ) from None
    if len(key) != 32:
        raise RuntimeError("AUTH_PASSWORD_RESET_KEYS values must decode to 32 bytes")
    return key


def _keyring() -> dict[int, bytes]:
    return {
        version: _decode_key(raw)
        for version, raw in settings.auth_password_reset_keys.items()
    }


def seal_secret(value: str, context: str) -> SealedSecret:
    version = settings.auth_password_reset_key_version
    key = _keyring().get(version)
    if key is None:
        raise RuntimeError(
            f"No password reset key configured for current version {version}"
        )
    nonce = secrets.token_bytes(_NONCE_BYTES)
    ciphertext = AESGCM(key).encrypt(
        nonce,
        value.encode("utf-8"),
        context.encode("utf-8"),
    )
    encoded = base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")
    return SealedSecret(ciphertext=encoded, key_version=version)


def open_secret(sealed: SealedSecret, context: str) -> str:
    key = _keyring().get(sealed.key_version)
    if key is None:
        raise RuntimeError(
            f"No password reset key configured for version {sealed.key_version}"
        )
    try:
        data = _decode_base64url(sealed.ciphertext)
    except ValueError:
        raise ValueError("Sealed secret ciphertext must be valid Base64URL") from None
    nonce, ciphertext = data[:_NONCE_BYTES], data[_NONCE_BYTES:]
    plaintext = AESGCM(key).decrypt(
        nonce,
        ciphertext,
        context.encode("utf-8"),
    )
    return plaintext.decode("utf-8")
