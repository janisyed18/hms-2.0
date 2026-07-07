"""Redis cache layer + readiness tests.

Uses fakeredis, so no live Redis is required. Covers the cache-aside round-trip,
prefix invalidation, graceful degradation when Redis errors, and the readiness
endpoint's reporting.
"""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import fakeredis.aioredis
import httpx
import pytest

import hms_backend.app.core.cache as cache
import hms_backend.app.main as main_module
from hms_backend.app.core.redis import set_redis_client
from hms_backend.app.main import create_app


@pytest.fixture(autouse=True)
def _fake_redis(monkeypatch: pytest.MonkeyPatch):
    client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(cache.settings, "cache_enabled", True)
    set_redis_client(client)
    cache.reset_circuit_breaker()
    yield client
    set_redis_client(None)


@pytest.mark.asyncio
async def test_cache_round_trip() -> None:
    assert await cache.cache_get_json("k1") is None
    await cache.cache_set_json("k1", {"a": 1, "b": ["x", "y"]})
    assert await cache.cache_get_json("k1") == {"a": 1, "b": ["x", "y"]}


@pytest.mark.asyncio
async def test_cache_delete() -> None:
    await cache.cache_set_json("k2", 42)
    await cache.cache_delete("k2")
    assert await cache.cache_get_json("k2") is None


@pytest.mark.asyncio
async def test_cache_delete_prefix() -> None:
    await cache.cache_set_json("reference:standards:default", [1])
    await cache.cache_set_json("reference:standards:code", [2])
    await cache.cache_set_json("other:thing", [3])
    await cache.cache_delete_prefix("reference:standards:")
    assert await cache.cache_get_json("reference:standards:default") is None
    assert await cache.cache_get_json("reference:standards:code") is None
    assert await cache.cache_get_json("other:thing") == [3]


class _BrokenRedis:
    async def get(self, *_a, **_k):
        from redis.exceptions import ConnectionError as RedisConnectionError

        raise RedisConnectionError("boom")

    async def set(self, *_a, **_k):
        from redis.exceptions import ConnectionError as RedisConnectionError

        raise RedisConnectionError("boom")


@pytest.mark.asyncio
async def test_cache_degrades_gracefully_on_error() -> None:
    set_redis_client(_BrokenRedis())  # type: ignore[arg-type]
    cache.reset_circuit_breaker()
    # No exception should escape; miss is returned and the breaker trips.
    assert await cache.cache_get_json("x") is None
    await cache.cache_set_json("x", 1)  # also swallowed
    assert await cache.cache_get_json("x") is None


@pytest.mark.asyncio
async def test_cache_disabled_by_flag(monkeypatch) -> None:
    monkeypatch.setattr(cache.settings, "cache_enabled", False)
    await cache.cache_set_json("k", 1)
    assert await cache.cache_get_json("k") is None


@asynccontextmanager
async def _client() -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        yield c


@pytest.mark.asyncio
async def test_readiness_ready(monkeypatch, _fake_redis) -> None:
    monkeypatch.setattr(main_module, "_check_database", lambda: _true())
    async with _client() as client:
        response = await client.get("/health/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["checks"]["database"] == "ok"
    assert body["checks"]["redis"] == "ok"


@pytest.mark.asyncio
async def test_readiness_not_ready_when_db_down(monkeypatch, _fake_redis) -> None:
    monkeypatch.setattr(main_module, "_check_database", lambda: _false())
    async with _client() as client:
        response = await client.get("/health/ready")
    assert response.status_code == 503
    assert response.json()["checks"]["database"] == "down"


async def _true() -> bool:
    return True


async def _false() -> bool:
    return False
