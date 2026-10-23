"""Auth configuration must fail closed: dev-style auth needs an explicit local/test.

``Settings.environment`` defaults to ``"local"``, so a deployment that loses
``ENVIRONMENT`` would otherwise start in header-based dev auth. These tests prove the
guard distinguishes a *chosen* local/test run from a silent fall-back to defaults.
"""

from __future__ import annotations

import os
from typing import Any

import pytest

from hms_backend.app import main
from hms_backend.app.core.config import Settings

DEPLOYED_ENVIRONMENTS = ["dev", "staging", "production", "prod", "prd", "live"]


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """BaseSettings reads the process environment even via ``model_validate``.

    The suite selects ``ENVIRONMENT=test`` explicitly (conftest), which would mask
    "unset" cases, so clear every variable these settings read.
    """
    for name in list(os.environ):
        if name == "ENVIRONMENT" or name.startswith(("AUTH_", "SECURITY_")):
            monkeypatch.delenv(name, raising=False)


def build(**values: Any) -> Settings:
    # Init arguments count as explicitly provided, exactly like environment values.
    return Settings(_env_file=None, **values)  # type: ignore[call-arg]


def configured(**overrides: Any) -> Settings:
    return build(**overrides)


def deployed_bearer(**overrides: Any) -> Settings:
    """Mirrors the DEV deployment's auth settings."""
    values: dict[str, Any] = {
        "environment": "dev",
        "auth_mode": "bearer",
        "auth_dev_headers_enabled": False,
        "auth_dev_allow_role_fallback": False,
        "auth_bearer_hmac_secret": "signing-secret",
        "auth_browser_login_enabled": True,
        "auth_mfa_required": False,
        **overrides,
    }
    return build(**values)


# ------------------------------------------------------------ explicit provenance


def test_unset_environment_is_not_explicit(monkeypatch: pytest.MonkeyPatch) -> None:
    fresh = build()
    assert fresh.environment == "local"  # the silent default...
    assert fresh.environment_is_explicit is False  # ...is detectable
    assert fresh.is_explicit_local_or_test is False


@pytest.mark.parametrize("value", ["local", "test", "development", "LOCAL"])
def test_environment_from_the_variable_is_explicit(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("ENVIRONMENT", value)
    fresh = Settings(_env_file=None)  # type: ignore[call-arg]
    assert fresh.environment_is_explicit is True
    assert fresh.is_explicit_local_or_test is True


def test_missing_environment_cannot_enable_dev_auth() -> None:
    # Pure defaults: environment local, auth dev, headers on, fallback on.
    errors = configured().auth_config_errors()
    assert any("ENVIRONMENT must be set explicitly" in e for e in errors)
    assert any("AUTH_MODE=dev" in e for e in errors)
    assert any("AUTH_DEV_HEADERS_ENABLED" in e for e in errors)
    assert any("AUTH_DEV_ALLOW_ROLE_FALLBACK" in e for e in errors)
    with pytest.raises(RuntimeError, match="ENVIRONMENT must be set explicitly"):
        configured().validate_auth_configuration()


def test_missing_environment_is_refused_even_with_secure_auth_settings() -> None:
    errors = build(
        auth_mode="bearer",
        auth_dev_headers_enabled=False,
        auth_dev_allow_role_fallback=False,
        auth_bearer_hmac_secret="signing-secret",
    ).auth_config_errors()
    assert errors == [
        "ENVIRONMENT must be set explicitly (local, test, dev, staging or production)"
    ]


# --------------------------------------------------------- explicit local / test


@pytest.mark.parametrize("environment", ["local", "test", "development", "Local"])
def test_explicit_local_or_test_may_use_dev_auth(environment: str) -> None:
    settings = configured(environment=environment)
    assert settings.auth_config_errors() == []
    settings.validate_auth_configuration()


# ------------------------------------------------------------------- deployed


@pytest.mark.parametrize("environment", DEPLOYED_ENVIRONMENTS)
def test_deployed_environment_rejects_dev_auth_mode(environment: str) -> None:
    errors = configured(
        environment=environment,
        auth_dev_headers_enabled=False,
        auth_dev_allow_role_fallback=False,
    ).auth_config_errors()
    assert any("AUTH_MODE=dev" in e for e in errors)


@pytest.mark.parametrize("environment", DEPLOYED_ENVIRONMENTS)
def test_deployed_environment_rejects_dev_headers_and_role_fallback(
    environment: str,
) -> None:
    headers = deployed_bearer(environment=environment, auth_dev_headers_enabled=True)
    assert headers.auth_config_errors() == [
        "AUTH_DEV_HEADERS_ENABLED must be false outside local/test"
    ]
    fallback = deployed_bearer(
        environment=environment, auth_dev_allow_role_fallback=True
    )
    assert fallback.auth_config_errors() == [
        "AUTH_DEV_ALLOW_ROLE_FALLBACK must be false outside local/test"
    ]


def test_current_dev_style_bearer_configuration_passes() -> None:
    settings = deployed_bearer()
    assert settings.auth_config_errors() == []
    settings.validate_auth_configuration()


@pytest.mark.parametrize("environment", DEPLOYED_ENVIRONMENTS)
def test_every_deployed_environment_accepts_a_complete_bearer_configuration(
    environment: str,
) -> None:
    assert deployed_bearer(environment=environment).auth_config_errors() == []


def test_deployed_bearer_mode_requires_a_signing_secret() -> None:
    errors = deployed_bearer(auth_bearer_hmac_secret="").auth_config_errors()
    assert errors == ["AUTH_BEARER_HMAC_SECRET is required"]


def test_deployed_oidc_mode_requires_issuer_and_audience() -> None:
    base = {
        "environment": "production",
        "auth_mode": "oidc",
        "auth_dev_headers_enabled": False,
        "auth_dev_allow_role_fallback": False,
    }
    assert configured(**base).auth_config_errors() == [
        "AUTH_OIDC_ISSUER is required",
        "AUTH_OIDC_AUDIENCE is required",
    ]
    complete = configured(
        **base,
        auth_oidc_issuer="https://idp.example.com",
        auth_oidc_audience="hms-api",
    )
    assert complete.auth_config_errors() == []


# ------------------------------------------------------------- startup wiring


@pytest.mark.asyncio
async def test_application_startup_refuses_a_missing_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(main, "settings", configured())
    with pytest.raises(RuntimeError, match="Invalid auth configuration"):
        async with main.lifespan(main.create_app()):
            pytest.fail("the application must not start")


@pytest.mark.asyncio
async def test_application_startup_refuses_deployed_dev_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(main, "settings", configured(environment="production"))
    with pytest.raises(RuntimeError, match="AUTH_MODE=dev"):
        async with main.lifespan(main.create_app()):
            pytest.fail("the application must not start")


@pytest.mark.asyncio
async def test_application_startup_allows_explicit_local() -> None:
    # The test suite selects ENVIRONMENT=test explicitly (conftest), so the real
    # global settings pass the guard.
    async with main.lifespan(main.create_app()):
        pass
