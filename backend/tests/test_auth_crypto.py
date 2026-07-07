"""Auth crypto tests: Argon2 hashing, local HS256 token issue/verify, and OIDC
RS256 validation. These depend only on the auth core (no ORM), so they exercise
the security-critical logic directly.
"""

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey

from hms_backend.app.core.auth import (
    TokenValidationError,
    decode_hs256_bearer_token,
    encode_hs256_bearer_token,
)
from hms_backend.app.core.oidc import OidcValidationError, OidcValidator
from hms_backend.app.core.passwords import (
    hash_password,
    needs_rehash,
    verify_password,
)

_SECRET = "unit-test-secret"


# --- Argon2 ---------------------------------------------------------------------


def test_password_hash_and_verify() -> None:
    h = hash_password("correct horse battery staple")
    assert h != "correct horse battery staple"
    assert h.startswith("$argon2")
    assert verify_password(h, "correct horse battery staple") is True
    assert verify_password(h, "wrong password") is False


def test_verify_rejects_garbage_hash() -> None:
    assert verify_password("not-a-hash", "whatever") is False


def test_needs_rehash_false_for_current_params() -> None:
    assert needs_rehash(hash_password("another-password")) is False


# --- Local HS256 tokens ---------------------------------------------------------


def test_issue_and_decode_roundtrip() -> None:
    token = encode_hs256_bearer_token(
        subject="user-oidc-1",
        secret=_SECRET,
        issuer="hms",
        audience="hms-api",
        ttl_seconds=300,
    )
    claims = decode_hs256_bearer_token(
        token, secret=_SECRET, issuer="hms", audience="hms-api"
    )
    assert claims.subject == "user-oidc-1"


def test_decode_rejects_wrong_secret() -> None:
    token = encode_hs256_bearer_token(subject="u", secret=_SECRET, ttl_seconds=300)
    with pytest.raises(TokenValidationError):
        decode_hs256_bearer_token(token, secret="different-secret")


def test_decode_rejects_expired() -> None:
    token = encode_hs256_bearer_token(subject="u", secret=_SECRET, ttl_seconds=-10)
    with pytest.raises(TokenValidationError):
        decode_hs256_bearer_token(token, secret=_SECRET, leeway_seconds=0)


# --- OIDC RS256 -----------------------------------------------------------------


@pytest.fixture(scope="module")
def rsa_key() -> RSAPrivateKey:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key


class _Validator(OidcValidator):
    def __init__(self, public_key: object, *, issuer: str, audience: str) -> None:
        super().__init__(issuer=issuer, audience=audience)
        self._public_key = public_key

    def _signing_key(self, token: str) -> object:  # bypass JWKS network
        return self._public_key


def _make_validator(rsa_key: RSAPrivateKey) -> _Validator:
    return _Validator(
        rsa_key.public_key(),
        issuer="https://idp.example/realms/hms",
        audience="hms-api",
    )


def _mint(rsa_key: RSAPrivateKey, **overrides: object) -> str:
    now = int(time.time())
    claims: dict[str, object] = {
        "sub": "user-123",
        "email": "u@x.com",
        "iss": "https://idp.example/realms/hms",
        "aud": "hms-api",
        "iat": now,
        "exp": now + 300,
    }
    claims.update(overrides)
    pem = rsa_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    return jwt.encode(claims, pem, algorithm="RS256")


def test_oidc_valid_token(rsa_key: RSAPrivateKey) -> None:
    claims = _make_validator(rsa_key).validate(_mint(rsa_key))
    assert claims.subject == "user-123"
    assert claims.email == "u@x.com"


@pytest.mark.parametrize(
    "overrides",
    [
        {"iss": "https://evil"},
        {"aud": "other-api"},
        {"exp": int(time.time()) - 1000},
        {"sub": ""},
    ],
)
def test_oidc_rejects_bad_claims(
    rsa_key: RSAPrivateKey,
    overrides: dict[str, object],
) -> None:
    with pytest.raises(OidcValidationError):
        _make_validator(rsa_key).validate(_mint(rsa_key, **overrides))


def test_oidc_rejects_bad_signature(rsa_key: RSAPrivateKey) -> None:
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    token = _mint(other, sub="attacker")
    with pytest.raises(OidcValidationError):
        _make_validator(rsa_key).validate(token)
