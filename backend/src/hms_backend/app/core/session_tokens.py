"""Opaque challenge / refresh tokens (Task 2).

Only the SHA-256 digest of a token is ever persisted; the raw value is a
URL-safe random string handed to the client once. Looking a token up means
digesting the presented raw value and matching the stored digest, so a database
leak never exposes usable tokens.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass

_TOKEN_BYTES = 32


@dataclass(frozen=True)
class OpaqueToken:
    raw: str
    digest: str


def digest_opaque_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def generate_opaque_token() -> OpaqueToken:
    raw = secrets.token_urlsafe(_TOKEN_BYTES)
    return OpaqueToken(raw=raw, digest=digest_opaque_token(raw))
