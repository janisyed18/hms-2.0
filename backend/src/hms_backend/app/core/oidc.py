"""OIDC access-token validation for an external IdP (Keycloak / OCI Identity
Domains).

Verifies RS256/ES256 JWTs against the provider's published JWKS (asymmetric —
the server never holds a signing secret), and checks issuer, audience and
expiry. Identity only: the HMS role is read from the persisted user, not the
token, so authorization stays DB-authoritative.

Signing keys are fetched from the JWKS endpoint and cached by ``PyJWKClient``.
The JWKS URL is discovered from the issuer's OpenID configuration unless given
explicitly.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any

import httpx
import jwt
from jwt import PyJWKClient

_ALGORITHMS = ["RS256", "RS384", "RS512", "ES256", "ES384"]


class OidcConfigurationError(RuntimeError):
    """OIDC mode is selected but not configured correctly."""


class OidcValidationError(ValueError):
    """A presented token could not be trusted."""


@dataclass(frozen=True)
class OidcClaims:
    subject: str
    email: str | None
    raw: dict[str, Any]


class OidcValidator:
    def __init__(
        self,
        *,
        issuer: str,
        audience: str,
        jwks_url: str = "",
        cache_seconds: int = 3600,
        leeway_seconds: int = 60,
    ) -> None:
        if not issuer:
            raise OidcConfigurationError("auth_oidc_issuer is required for oidc mode")
        self._issuer = issuer.rstrip("/")
        self._audience = audience
        self._leeway = leeway_seconds
        self._cache_seconds = cache_seconds
        self._configured_jwks_url = jwks_url
        self._jwk_client: PyJWKClient | None = None
        self._lock = threading.Lock()

    # --- signing key retrieval (seam for tests) ---

    def _client(self) -> PyJWKClient:
        if self._jwk_client is None:
            with self._lock:
                if self._jwk_client is None:
                    url = self._configured_jwks_url or self._discover_jwks_url()
                    self._jwk_client = PyJWKClient(
                        url, cache_keys=True, lifespan=self._cache_seconds
                    )
        return self._jwk_client

    def _discover_jwks_url(self) -> str:
        well_known = f"{self._issuer}/.well-known/openid-configuration"
        try:
            response = httpx.get(well_known, timeout=10)
            response.raise_for_status()
            jwks_uri = response.json().get("jwks_uri")
        except (httpx.HTTPError, ValueError) as exc:
            raise OidcConfigurationError(
                f"failed to discover JWKS from {well_known}: {exc}"
            ) from exc
        if not jwks_uri:
            raise OidcConfigurationError("issuer did not advertise a jwks_uri")
        return str(jwks_uri)

    def _signing_key(self, token: str) -> Any:
        return self._client().get_signing_key_from_jwt(token).key

    # --- validation ---

    def validate(self, token: str) -> OidcClaims:
        try:
            key = self._signing_key(token)
        except jwt.PyJWTError as exc:
            raise OidcValidationError(f"unable to resolve signing key: {exc}") from exc

        try:
            payload = jwt.decode(
                token,
                key,
                algorithms=_ALGORITHMS,
                issuer=self._issuer,
                audience=self._audience or None,
                leeway=self._leeway,
                options={
                    "require": ["exp", "sub"],
                    "verify_aud": bool(self._audience),
                },
            )
        except jwt.PyJWTError as exc:
            raise OidcValidationError(str(exc)) from exc

        subject = payload.get("sub")
        if not isinstance(subject, str) or not subject.strip():
            raise OidcValidationError("token is missing a subject")

        return OidcClaims(
            subject=subject.strip(),
            email=_string_or_none(payload.get("email")),
            raw=payload,
        )


def _string_or_none(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


_validator: OidcValidator | None = None
_validator_lock = threading.Lock()


def get_oidc_validator() -> OidcValidator:
    """Return the process-wide validator built from settings."""
    from hms_backend.app.core.config import settings

    global _validator
    if _validator is None:
        with _validator_lock:
            if _validator is None:
                _validator = OidcValidator(
                    issuer=settings.auth_oidc_issuer,
                    audience=settings.auth_oidc_audience,
                    jwks_url=settings.auth_oidc_jwks_url,
                    cache_seconds=settings.auth_oidc_jwks_cache_seconds,
                    leeway_seconds=settings.auth_token_leeway_seconds,
                )
    return _validator


def set_oidc_validator(validator: OidcValidator | None) -> None:
    """Override the shared validator (tests)."""
    global _validator
    _validator = validator
