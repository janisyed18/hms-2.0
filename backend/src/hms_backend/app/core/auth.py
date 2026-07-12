from __future__ import annotations

import base64
import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any


class TokenValidationError(ValueError):
    """Raised when a bearer token cannot be trusted."""


def encode_hs256_bearer_token(
    *,
    subject: str,
    secret: str,
    issuer: str | None = None,
    audience: str | None = None,
    ttl_seconds: int = 3600,
    now: datetime | None = None,
    extra_claims: dict[str, Any] | None = None,
) -> str:
    """Mint an HS256 access token (used by the Argon2 password-login flow)."""
    if not secret:
        raise TokenValidationError("Token signing secret is not configured")
    issued_at = int((now or datetime.now(UTC)).timestamp())
    payload: dict[str, Any] = {
        "sub": subject,
        "iat": issued_at,
        "exp": issued_at + ttl_seconds,
    }
    if issuer:
        payload["iss"] = issuer
    if audience:
        payload["aud"] = audience
    if extra_claims:
        payload.update(extra_claims)

    header = {"alg": "HS256", "typ": "JWT"}
    encoded_header = _b64url_encode(json.dumps(header, separators=(",", ":")).encode())
    encoded_payload = _b64url_encode(
        json.dumps(payload, separators=(",", ":")).encode()
    )
    signing_input = f"{encoded_header}.{encoded_payload}".encode()
    signature = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    return f"{encoded_header}.{encoded_payload}.{_b64url_encode(signature)}"


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


@dataclass(frozen=True)
class BearerClaims:
    subject: str
    roles: tuple[str, ...]
    customer_ids: tuple[str, ...]
    purpose: str | None = None  # e.g. "pw_reset" for single-use links
    auth_time: int | None = None  # unix seconds of credential presentation


def decode_hs256_bearer_token(
    token: str,
    *,
    secret: str,
    issuer: str | None = None,
    audience: str | None = None,
    leeway_seconds: int = 60,
    now: datetime | None = None,
) -> BearerClaims:
    if not secret:
        raise TokenValidationError("Bearer auth is not configured")

    parts = token.split(".")
    if len(parts) != 3:
        raise TokenValidationError("Invalid bearer token")

    encoded_header, encoded_payload, encoded_signature = parts
    header = _decode_json(encoded_header)
    if header.get("alg") != "HS256":
        raise TokenValidationError("Invalid bearer token")

    signing_input = f"{encoded_header}.{encoded_payload}".encode()
    expected_signature = hmac.new(
        secret.encode(),
        signing_input,
        hashlib.sha256,
    ).digest()
    actual_signature = _b64url_decode(encoded_signature)
    if not hmac.compare_digest(expected_signature, actual_signature):
        raise TokenValidationError("Invalid bearer token")

    payload = _decode_json(encoded_payload)
    timestamp = int((now or datetime.now(UTC)).timestamp())
    _validate_time_claims(payload, timestamp, leeway_seconds)
    _validate_issuer(payload, issuer)
    _validate_audience(payload, audience)

    subject = payload.get("sub")
    if not isinstance(subject, str) or not subject.strip():
        raise TokenValidationError("Invalid bearer token")

    purpose = payload.get("purpose")
    auth_time = payload.get("auth_time")
    return BearerClaims(
        subject=subject.strip(),
        roles=_string_sequence(payload.get("hms_roles", payload.get("roles", ()))),
        customer_ids=_string_sequence(
            payload.get("hms_customer_ids", payload.get("customer_ids", ()))
        ),
        purpose=purpose if isinstance(purpose, str) else None,
        auth_time=auth_time if isinstance(auth_time, int) else None,
    )


def _decode_json(value: str) -> dict[str, Any]:
    try:
        decoded = _b64url_decode(value)
        payload = json.loads(decoded)
    except (ValueError, json.JSONDecodeError) as exc:
        raise TokenValidationError("Invalid bearer token") from exc
    if not isinstance(payload, dict):
        raise TokenValidationError("Invalid bearer token")
    return payload


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    try:
        return base64.urlsafe_b64decode(f"{value}{padding}")
    except ValueError as exc:
        raise TokenValidationError("Invalid bearer token") from exc


def _validate_time_claims(
    payload: dict[str, Any],
    timestamp: int,
    leeway_seconds: int,
) -> None:
    exp = payload.get("exp")
    if exp is not None and not isinstance(exp, int):
        raise TokenValidationError("Invalid bearer token")
    if isinstance(exp, int) and exp < timestamp - leeway_seconds:
        raise TokenValidationError("Bearer token has expired")

    nbf = payload.get("nbf")
    if nbf is not None and not isinstance(nbf, int):
        raise TokenValidationError("Invalid bearer token")
    if isinstance(nbf, int) and nbf > timestamp + leeway_seconds:
        raise TokenValidationError("Bearer token is not active yet")


def _validate_issuer(payload: dict[str, Any], issuer: str | None) -> None:
    if issuer and payload.get("iss") != issuer:
        raise TokenValidationError("Invalid bearer token")


def _validate_audience(payload: dict[str, Any], audience: str | None) -> None:
    if not audience:
        return
    token_audience = payload.get("aud")
    if isinstance(token_audience, str) and token_audience == audience:
        return
    if isinstance(token_audience, list) and audience in token_audience:
        return
    raise TokenValidationError("Invalid bearer token")


def _string_sequence(value: object) -> tuple[str, ...]:
    if isinstance(value, str):
        return tuple(item.strip() for item in value.split(",") if item.strip())
    if isinstance(value, list):
        return tuple(
            item.strip() for item in value if isinstance(item, str) and item.strip()
        )
    return ()
