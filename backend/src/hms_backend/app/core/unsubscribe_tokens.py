"""Signed, expiring one-click unsubscribe tokens.

An unsubscribe link carries no database state: the token binds one party to one
notification category and an expiry with an HMAC, so only someone who received that
email can opt that party out, and only until the token expires. The key is derived from
the bearer HMAC secret with a purpose label, so a token can never be replayed as a
session token or the other way round.

Token layout: ``base64url(party_type|party_id|category|expires_at)`` ``.`` ``HMAC``.
``expires_at`` is whole seconds since the Unix epoch (UTC) and is covered by the HMAC.
A token is valid while ``now < expires_at``: at the exact expiry second it is already
refused.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from hms_backend.app.core.config import Settings

_PURPOSE = b"hms:unsubscribe:v2"
_LOCAL_KEY = "local-development-unsubscribe-key"
_SEPARATOR = "|"


@dataclass(frozen=True)
class UnsubscribeClaim:
    party_type: str
    party_id: str
    category: str


def _key(config: Settings) -> bytes | None:
    secret = config.auth_bearer_hmac_secret
    if not secret:
        if not config.is_local_or_test:
            return None
        secret = _LOCAL_KEY
    return hmac.new(secret.encode("utf-8"), _PURPOSE, hashlib.sha256).digest()


def _sign(key: bytes, body: bytes) -> str:
    digest = hmac.new(key, body, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def create_unsubscribe_token(
    claim: UnsubscribeClaim, config: Settings, *, now: datetime | None = None
) -> str | None:
    """Return a token valid for the configured TTL, or None without a signing key.

    A missing key must mean "no unsubscribe link", never an unsigned link.
    """
    key = _key(config)
    if key is None:
        return None
    issued = (now or datetime.now(UTC)).astimezone(UTC)
    ttl = config.notification_unsubscribe_token_ttl_seconds
    expires_at = int((issued + timedelta(seconds=ttl)).timestamp())
    body = _SEPARATOR.join(
        (claim.party_type, claim.party_id, claim.category, str(expires_at))
    ).encode()
    encoded = base64.urlsafe_b64encode(body).decode("ascii").rstrip("=")
    return f"{encoded}.{_sign(key, body)}"


def read_unsubscribe_token(
    token: str, config: Settings, *, now: datetime | None = None
) -> UnsubscribeClaim | None:
    """Return the claim when the signature is valid and the token has not expired."""
    key = _key(config)
    if key is None or token.count(".") != 1:
        return None
    encoded, signature = token.split(".")
    try:
        body = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    except (binascii.Error, ValueError):
        return None
    if not hmac.compare_digest(signature, _sign(key, body)):
        return None
    try:
        party_type, party_id, category, expires_text = body.decode("utf-8").split(
            _SEPARATOR
        )
        if not expires_text.isascii() or not expires_text.isdigit():
            return None
        expires_at = int(expires_text)
    except (UnicodeDecodeError, ValueError):
        return None
    current = (now or datetime.now(UTC)).astimezone(UTC)
    if int(current.timestamp()) >= expires_at:
        return None
    return UnsubscribeClaim(party_type, party_id, category)
