from __future__ import annotations

import os

# Local/test operation must be selected explicitly: an unset ENVIRONMENT is treated
# as an under-configured deployment (see Settings.auth_config_errors). Set before any
# application module builds the global ``settings``.
os.environ.setdefault("ENVIRONMENT", "test")

from zoneinfo import reset_tzpath  # noqa: E402

import pytest

import hms_backend.app.core.cache as cache
from hms_backend.app.core.redis import set_redis_client

# Match the containers, which set PYTHONTZPATH="" to use the locked tzdata.
reset_tzpath(())


@pytest.fixture(autouse=True)
def disable_cache_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep API tests isolated from any developer/Docker Redis instance."""
    monkeypatch.setattr(cache.settings, "cache_enabled", False)
    set_redis_client(None)
    cache.reset_circuit_breaker()
