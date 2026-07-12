"""Argon2 password hashing (guardrail: passwords are Argon2-hashed, never stored
or displayed in plaintext).

Argon2id with library defaults. ``needs_rehash`` lets the login flow transparently
upgrade a stored hash when parameters change. This module also owns the password
policy (length bounds + common-password deny list) and temporary-password
generation used by the staff browser auth flow.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources

from argon2 import PasswordHasher
from argon2.exceptions import (
    HashingError,
    InvalidHashError,
    VerificationError,
    VerifyMismatchError,
)

from hms_backend.app.core.config import settings

_hasher = PasswordHasher()

# Unambiguous alphabet for generated temporary passwords (no 0/O/1/l/I).
_TEMP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
_TEMP_LENGTH = 16


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    """Return True iff ``password`` matches the stored Argon2 hash."""
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError, VerificationError):
        return False


def needs_rehash(password_hash: str) -> bool:
    try:
        return _hasher.check_needs_rehash(password_hash)
    except (InvalidHashError, HashingError):
        return True


# --- Password policy ------------------------------------------------------------


@dataclass(frozen=True)
class PasswordPolicyResult:
    valid: bool
    errors: tuple[str, ...]


@lru_cache(maxsize=1)
def _common_passwords() -> frozenset[str]:
    """Load the packaged common-password deny list (lowercased, deduped)."""
    text = (
        resources.files("hms_backend.app.data")
        .joinpath("common_passwords.txt")
        .read_text(encoding="utf-8")
    )
    return frozenset(
        line.strip().lower()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )


def validate_password_policy(password: str) -> PasswordPolicyResult:
    """Validate a password against length bounds and the common-password list.

    Length is measured in Unicode code points and the password is never
    truncated; whitespace and passphrases are accepted.
    """
    errors: list[str] = []
    minimum = settings.auth_password_min_length
    maximum = settings.auth_password_max_length
    length = len(password)
    if length < minimum:
        errors.append(f"Password must be at least {minimum} characters.")
    if length > maximum:
        errors.append(f"Password must be at most {maximum} characters.")
    if password.strip().lower() in _common_passwords():
        errors.append("Password is too common; choose a less predictable one.")
    return PasswordPolicyResult(valid=not errors, errors=tuple(errors))


def generate_temporary_password() -> str:
    """Return a high-entropy, human-typable temporary password that satisfies the
    policy. Callers must hash it and force a change on first login."""
    return "".join(secrets.choice(_TEMP_ALPHABET) for _ in range(_TEMP_LENGTH))
