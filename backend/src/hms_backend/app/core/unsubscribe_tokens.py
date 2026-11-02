"""Signed one-click unsubscribe tokens.

An unsubscribe link carries no database state: the token binds one party to one
notification category with an HMAC, so only someone who received that email can opt that
party out. The key is derived from the bearer HMAC secret with a purpose label, so a
token can never be replayed as a session token or the other way round.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
from dataclasses import dataclass

from hms_backend.app.core.config import Settings

_PURPOSE = b"hms:unsubscribe:v1"
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


def create_unsubscribe_token(claim: UnsubscribeClaim, config: Settings) -> str | None:
    """Return a token, or None when this deployment has no signing key.

    A missing key must mean "no unsubscribe link", never an unsigned link.
    """
    key = _key(config)
    if key is None:
        return None
    body = _SEPARATOR.join((claim.party_type, claim.party_id, claim.category)).encode()
    encoded = base64.urlsafe_b64encode(body).decode("ascii").rstrip("=")
    return f"{encoded}.{_sign(key, body)}"


def read_unsubscribe_token(token: str, config: Settings) -> UnsubscribeClaim | None:
    """Return the claim when the signature is valid, otherwise None."""
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
        party_type, party_id, category = body.decode("utf-8").split(_SEPARATOR)
    except (UnicodeDecodeError, ValueError):
        return None
    return UnsubscribeClaim(party_type, party_id, category)
