"""TOTP MFA, AES-256-GCM secret encryption, and recovery codes (Task 2).

TOTP secrets are encrypted at rest with a versioned AES-256-GCM key and the user
id as authenticated associated data, so a leaked ciphertext cannot be replayed
against a different account and keys can be rotated without re-enrolling every
user. Recovery codes are returned to the user once and persisted only as HMAC
digests keyed by a separate pepper.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime

import pyotp
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hms_backend.app.core.config import settings

_TOTP_PERIOD = 30
_TOTP_DIGITS = 6
_TOTP_WINDOW = 1  # accept adjacent steps for modest clock skew
_NONCE_BYTES = 12
_RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_RECOVERY_GROUPS = 3
_RECOVERY_GROUP_LEN = 4


@dataclass(frozen=True)
class EncryptedTotpSecret:
    ciphertext: str
    key_version: int


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
    raise RuntimeError("AUTH_MFA_ENCRYPTION_KEY must decode to 32 bytes")


def _keyring() -> dict[int, bytes]:
    configured = {
        version: _decode_key(raw)
        for version, raw in settings.auth_mfa_encryption_keys.items()
    }
    if settings.auth_mfa_encryption_key:
        configured[settings.auth_mfa_key_version] = _decode_key(
            settings.auth_mfa_encryption_key
        )
    if not configured:
        raise RuntimeError("AUTH_MFA_ENCRYPTION_KEY is not configured")
    return configured


def generate_totp_secret() -> str:
    return pyotp.random_base32()


def build_totp_uri(secret: str, *, email: str, issuer: str) -> str:
    totp = pyotp.TOTP(secret, digits=_TOTP_DIGITS, interval=_TOTP_PERIOD)
    return totp.provisioning_uri(name=email, issuer_name=issuer)


def encrypt_totp_secret(secret: str, *, user_id: str) -> EncryptedTotpSecret:
    version = settings.auth_mfa_key_version
    key = _keyring().get(version)
    if key is None:
        raise RuntimeError(f"No MFA key configured for current version {version}")
    nonce = secrets.token_bytes(_NONCE_BYTES)
    ciphertext = AESGCM(key).encrypt(
        nonce, secret.encode("utf-8"), user_id.encode("utf-8")
    )
    blob = base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")
    return EncryptedTotpSecret(ciphertext=blob, key_version=version)


def decrypt_totp_secret(value: EncryptedTotpSecret, *, user_id: str) -> str:
    key = _keyring().get(value.key_version)
    if key is None:
        raise RuntimeError(f"No MFA key configured for version {value.key_version}")
    data = base64.urlsafe_b64decode(value.ciphertext)
    nonce, ciphertext = data[:_NONCE_BYTES], data[_NONCE_BYTES:]
    plaintext = AESGCM(key).decrypt(nonce, ciphertext, user_id.encode("utf-8"))
    return plaintext.decode("utf-8")


def verify_totp(secret: str, code: str, *, now: datetime) -> int | None:
    """Return the accepted 30-second time-step if ``code`` is valid within the
    skew window, else None. The returned step lets the caller persist
    ``mfa_last_accepted_step`` and reject same-step replay."""
    cleaned = code.strip().replace(" ", "")
    if not cleaned.isdigit():
        return None
    totp = pyotp.TOTP(secret, digits=_TOTP_DIGITS, interval=_TOTP_PERIOD)
    current = int(now.timestamp()) // _TOTP_PERIOD
    for step in range(current - _TOTP_WINDOW, current + _TOTP_WINDOW + 1):
        if hmac.compare_digest(totp.at(step * _TOTP_PERIOD), cleaned):
            return step
    return None


def generate_recovery_codes(count: int = 10) -> tuple[str, ...]:
    codes: list[str] = []
    for _ in range(count):
        groups = [
            "".join(
                secrets.choice(_RECOVERY_ALPHABET)
                for _ in range(_RECOVERY_GROUP_LEN)
            )
            for _ in range(_RECOVERY_GROUPS)
        ]
        codes.append("-".join(groups))
    return tuple(codes)


def normalise_recovery_code(code: str) -> str:
    return "".join(ch for ch in code.upper() if ch.isalnum())


def recovery_code_digest(code: str) -> str:
    if not settings.auth_recovery_code_pepper:
        raise RuntimeError("AUTH_RECOVERY_CODE_PEPPER is not configured")
    return hmac.new(
        settings.auth_recovery_code_pepper.encode("utf-8"),
        normalise_recovery_code(code).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
