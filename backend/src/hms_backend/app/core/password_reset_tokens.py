"""Password-reset token hashing and short-lived delivery encryption."""

from __future__ import annotations

import base64
import hashlib
import secrets
from dataclasses import dataclass

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hms_backend.app.core.config import Settings, settings

_TOKEN_BYTES = 32
_NONCE_BYTES = 12


@dataclass(frozen=True)
class PasswordResetSecret:
    raw: str
    digest: str


@dataclass(frozen=True)
class EncryptedPasswordResetDelivery:
    ciphertext: str
    key_version: int


def generate_password_reset_secret() -> PasswordResetSecret:
    raw = secrets.token_urlsafe(_TOKEN_BYTES)
    return PasswordResetSecret(raw=raw, digest=digest_password_reset_secret(raw))


def digest_password_reset_secret(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def encrypt_password_reset_delivery(
    raw: str,
    *,
    reset_id: str,
    user_id: str,
    config: Settings = settings,
) -> EncryptedPasswordResetDelivery:
    version = config.auth_password_reset_key_version
    key = _keyring(config).get(version)
    if key is None:
        raise RuntimeError(
            f"No password reset encryption key configured for version {version}"
        )
    nonce = secrets.token_bytes(_NONCE_BYTES)
    aad = _aad(reset_id, user_id)
    sealed = AESGCM(key).encrypt(nonce, raw.encode("utf-8"), aad)
    return EncryptedPasswordResetDelivery(
        ciphertext=base64.urlsafe_b64encode(nonce + sealed).decode("ascii"),
        key_version=version,
    )


def decrypt_password_reset_delivery(
    envelope: EncryptedPasswordResetDelivery,
    *,
    reset_id: str,
    user_id: str,
    config: Settings = settings,
) -> str:
    key = _keyring(config).get(envelope.key_version)
    if key is None:
        raise ValueError("could not decrypt password reset delivery")
    try:
        data = base64.urlsafe_b64decode(envelope.ciphertext)
        nonce, sealed = data[:_NONCE_BYTES], data[_NONCE_BYTES:]
        plaintext = AESGCM(key).decrypt(
            nonce, sealed, _aad(reset_id, user_id)
        )
    except (ValueError, InvalidTag) as exc:
        raise ValueError("could not decrypt password reset delivery") from exc
    return plaintext.decode("utf-8")


def _aad(reset_id: str, user_id: str) -> bytes:
    return f"hms-password-reset:{reset_id}:{user_id}".encode()


def _keyring(config: Settings) -> dict[int, bytes]:
    configured: dict[int, bytes] = {}
    for version, raw in config.auth_password_reset_encryption_keys.items():
        configured[version] = _decode_key(raw)
    if config.auth_password_reset_encryption_key:
        configured[config.auth_password_reset_key_version] = _decode_key(
            config.auth_password_reset_encryption_key
        )
    if not configured:
        raise RuntimeError("AUTH_PASSWORD_RESET_ENCRYPTION_KEY is not configured")
    return configured


def _decode_key(raw: str) -> bytes:
    padded = raw + "=" * (-len(raw) % 4)
    candidates: list[bytes] = []
    for decoder in (base64.urlsafe_b64decode, base64.b64decode):
        try:
            candidates.append(decoder(padded))
        except ValueError:
            pass
    try:
        candidates.append(bytes.fromhex(raw))
    except ValueError:
        pass
    for key in candidates:
        if len(key) == 32:
            return key
    raise ValueError("AUTH_PASSWORD_RESET_ENCRYPTION_KEY must decode to 32 bytes")
