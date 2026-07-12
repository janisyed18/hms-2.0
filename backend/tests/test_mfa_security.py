"""MFA primitive tests: AES-GCM secret encryption, TOTP, recovery codes (Task 2)."""

from __future__ import annotations

import base64
import secrets
from datetime import UTC, datetime

import pyotp
import pytest
from cryptography.exceptions import InvalidTag

from hms_backend.app.core import mfa
from hms_backend.app.core.config import settings


@pytest.fixture(autouse=True)
def _mfa_config(monkeypatch: pytest.MonkeyPatch) -> None:
    key = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")
    monkeypatch.setattr(settings, "auth_mfa_encryption_key", key)
    monkeypatch.setattr(settings, "auth_mfa_key_version", 1)
    monkeypatch.setattr(settings, "auth_recovery_code_pepper", "unit-test-pepper")


# --- AES-256-GCM secret encryption ----------------------------------------------


def test_encrypt_decrypt_roundtrip() -> None:
    secret = mfa.generate_totp_secret()
    encrypted = mfa.encrypt_totp_secret(secret, user_id="user-1")
    assert encrypted.key_version == 1
    assert secret not in encrypted.ciphertext
    assert mfa.decrypt_totp_secret(encrypted, user_id="user-1") == secret


def test_decrypt_rejects_wrong_user_aad() -> None:
    encrypted = mfa.encrypt_totp_secret(mfa.generate_totp_secret(), user_id="user-1")
    with pytest.raises(InvalidTag):
        mfa.decrypt_totp_secret(encrypted, user_id="user-2")


def test_decrypt_rejects_wrong_key(monkeypatch: pytest.MonkeyPatch) -> None:
    encrypted = mfa.encrypt_totp_secret(mfa.generate_totp_secret(), user_id="user-1")
    other = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")
    monkeypatch.setattr(settings, "auth_mfa_encryption_key", other)
    with pytest.raises(InvalidTag):
        mfa.decrypt_totp_secret(encrypted, user_id="user-1")


# --- TOTP validation ------------------------------------------------------------


def test_verify_totp_accepts_current_code_and_returns_step() -> None:
    secret = mfa.generate_totp_secret()
    now = datetime.now(UTC)
    code = pyotp.TOTP(secret).at(now)
    step = mfa.verify_totp(secret, code, now=now)
    assert step == int(now.timestamp()) // 30


def test_verify_totp_step_is_stable_for_replay_detection() -> None:
    secret = mfa.generate_totp_secret()
    now = datetime.now(UTC)
    code = pyotp.TOTP(secret).at(now)
    first = mfa.verify_totp(secret, code, now=now)
    second = mfa.verify_totp(secret, code, now=now)
    # Same accepted step both times -> the service rejects the second as replay.
    assert first is not None
    assert first == second


def test_verify_totp_rejects_wrong_code() -> None:
    secret = mfa.generate_totp_secret()
    now = datetime.now(UTC)
    good = pyotp.TOTP(secret).at(now)
    wrong = "000000" if good != "000000" else "111111"
    assert mfa.verify_totp(secret, wrong, now=now) is None


def test_verify_totp_rejects_non_numeric() -> None:
    secret = mfa.generate_totp_secret()
    assert mfa.verify_totp(secret, "abcdef", now=datetime.now(UTC)) is None


# --- Recovery codes -------------------------------------------------------------


def test_generate_recovery_codes_are_unique_and_formatted() -> None:
    codes = mfa.generate_recovery_codes(10)
    assert len(codes) == 10
    assert len(set(codes)) == 10
    assert all(code.count("-") == 2 for code in codes)


def test_recovery_code_digest_is_stable_normalised_and_keyed() -> None:
    baseline = mfa.recovery_code_digest("abcd-efgh-jklm")
    assert baseline == mfa.recovery_code_digest("ABCD EFGH JKLM")
    assert len(baseline) == 64
    assert mfa.recovery_code_digest("zzzz-zzzz-zzzz") != baseline


def test_recovery_code_digest_depends_on_pepper(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    baseline = mfa.recovery_code_digest("abcd-efgh-jklm")
    monkeypatch.setattr(settings, "auth_recovery_code_pepper", "different-pepper")
    assert mfa.recovery_code_digest("abcd-efgh-jklm") != baseline
