from typing import Any

import pytest

from hms_backend.app import main
from hms_backend.app.core.config import Settings, settings


def production_settings(**overrides: object) -> Settings:
    values: dict[str, Any] = {
        "environment": "production",
        "auth_browser_login_enabled": True,
        **overrides,
    }
    return Settings.model_validate(values)


def test_production_browser_auth_rejects_missing_security_secrets() -> None:
    configured = production_settings()
    errors = configured.browser_auth_config_errors()
    assert "AUTH_BEARER_HMAC_SECRET is required" in errors
    assert "AUTH_MFA_ENCRYPTION_KEY is required" in errors
    assert "AUTH_RECOVERY_CODE_PEPPER is required" in errors
    assert "AUTH_BROWSER_ALLOWED_ORIGINS must list the staff origin" in errors


def test_production_browser_auth_accepts_complete_secure_configuration() -> None:
    configured = production_settings(
        auth_bearer_hmac_secret="signing-secret",
        auth_mfa_encryption_key="base64-32-byte-key-value",
        auth_recovery_code_pepper="recovery-pepper",
        auth_browser_allowed_origins=["https://staff.example.com"],
        auth_browser_cookie_secure=True,
    )
    assert configured.browser_auth_config_errors() == []
    configured.validate_browser_auth()


@pytest.mark.asyncio
async def test_application_lifespan_validates_browser_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        type(settings),
        "validate_browser_auth",
        lambda _settings: calls.append("validated"),
    )
    async with main.lifespan(main.create_app()):
        assert calls == ["validated"]
