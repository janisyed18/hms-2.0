"""Password policy + temporary-password tests (Task 2)."""

from __future__ import annotations

from hms_backend.app.core.passwords import (
    generate_temporary_password,
    validate_password_policy,
)


def test_accepts_12_to_128_characters() -> None:
    assert validate_password_policy("a" * 12).valid
    assert validate_password_policy("a" * 128).valid


def test_rejects_too_short() -> None:
    result = validate_password_policy("a" * 11)
    assert not result.valid
    assert any("at least" in error for error in result.errors)


def test_rejects_too_long_without_truncation() -> None:
    result = validate_password_policy("a" * 129)
    assert not result.valid
    assert any("at most" in error for error in result.errors)


def test_accepts_passphrase_with_whitespace() -> None:
    assert validate_password_policy("correct horse battery staple").valid


def test_accepts_unicode_passphrase() -> None:
    assert validate_password_policy("café-résumé-señor-2026").valid


def test_rejects_common_password_even_when_long_enough() -> None:
    # 16 characters (passes length) but on the deny list.
    result = validate_password_policy("passwordpassword")
    assert not result.valid
    assert any("common" in error.lower() for error in result.errors)


def test_common_password_check_is_case_insensitive() -> None:
    assert not validate_password_policy("PasswordPassword").valid


def test_generated_temporary_password_satisfies_policy() -> None:
    seen: set[str] = set()
    for _ in range(25):
        password = generate_temporary_password()
        assert validate_password_policy(password).valid
        assert len(password) >= 12
        seen.add(password)
    assert len(seen) > 20  # high entropy: essentially always distinct
