from __future__ import annotations

import pytest

import hms_backend.app.core.cache as cache
from hms_backend.app.core.redis import set_redis_client


@pytest.fixture(autouse=True)
def disable_cache_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep API tests isolated from any developer/Docker Redis instance."""
    monkeypatch.setattr(cache.settings, "cache_enabled", False)
    set_redis_client(None)
    cache.reset_circuit_breaker()
