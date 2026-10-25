from __future__ import annotations

from collections.abc import AsyncIterator, Generator

import fakeredis.aioredis
import httpx
import pytest
from fastapi import Request
from redis.exceptions import RedisError

from hms_backend.app.core.config import settings
from hms_backend.app.core.redis import set_redis_client
from hms_backend.app.main import create_app


@pytest.fixture(autouse=True)
def _security_settings(monkeypatch: pytest.MonkeyPatch) -> Generator[None]:
    monkeypatch.setattr(settings, "environment", "test")
    monkeypatch.setattr(
        settings, "security_max_request_body_bytes", 64, raising=False
    )
    monkeypatch.setattr(
        settings, "security_api_rate_limit_max_requests", 1, raising=False
    )
    monkeypatch.setattr(
        settings, "security_api_rate_limit_window_seconds", 60, raising=False
    )
    set_redis_client(fakeredis.aioredis.FakeRedis(decode_responses=True))
    yield
    set_redis_client(None)


@pytest.mark.asyncio
async def test_security_headers_are_added_to_responses() -> None:
    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        response = await client.get("/health")

    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert response.headers["content-security-policy"].startswith("default-src 'self'")
    assert response.headers["permissions-policy"] == (
        "camera=(), geolocation=(), microphone=()"
    )


@pytest.mark.asyncio
async def test_deployed_responses_include_hsts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "security_edge_shared_secret", "edge-secret")
    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(
        transport=transport, base_url="https://testserver"
    ) as client:
        response = await client.get("/health")

    assert response.headers["strict-transport-security"] == (
        "max-age=15552000; includeSubDomains"
    )


@pytest.mark.asyncio
async def test_request_body_over_the_configured_limit_is_rejected() -> None:
    app = create_app()

    @app.post("/echo")
    async def echo() -> dict[str, bool]:
        return {"accepted": True}

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        response = await client.post("/echo", content=b"x" * 65)

    assert response.status_code == 413


@pytest.mark.asyncio
async def test_streamed_request_body_over_the_limit_is_rejected() -> None:
    app = create_app()

    @app.post("/echo-stream")
    async def echo_stream(request: Request) -> dict[str, int]:
        return {"size": len(await request.body())}

    async def oversized_stream() -> AsyncIterator[bytes]:
        yield b"x" * 32
        yield b"x" * 33

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        response = await client.post("/echo-stream", content=oversized_stream())

    assert response.status_code == 413


@pytest.mark.asyncio
async def test_configured_edge_secret_blocks_direct_api_requests(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings, "security_edge_shared_secret", "edge-secret", raising=False
    )
    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        denied = await client.get("/api/v1/openapi.json")
        invalid = await client.get(
            "/api/v1/openapi.json", headers={"X-HMS-Edge-Secret": "invalid"}
        )
        allowed = await client.get(
            "/api/v1/openapi.json", headers={"X-HMS-Edge-Secret": "edge-secret"}
        )

    assert denied.status_code == 403
    assert invalid.status_code == 403
    assert allowed.status_code == 200


@pytest.mark.asyncio
async def test_api_requests_are_rate_limited_per_client() -> None:
    transport = httpx.ASGITransport(app=create_app(), client=("203.0.113.10", 50000))
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        first = await client.get("/api/v1/openapi.json")
        limited = await client.get("/api/v1/openapi.json")

    assert first.status_code == 200
    assert limited.status_code == 429
    assert 1 <= int(limited.headers["retry-after"]) <= 60


class _UnavailableRedis:
    def __init__(self, error: Exception) -> None:
        self._error = error

    def pipeline(self, *_args: object, **_kwargs: object) -> object:
        raise self._error


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error",
    [RedisError("down"), RuntimeError("no client"), OSError("unreachable")],
    ids=["redis-error", "runtime-error", "os-error"],
)
async def test_ordinary_api_requests_remain_available_when_redis_is_down(
    monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    # Deployed environment: the old code returned 503 here (local/test skipped it).
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "security_edge_shared_secret", "edge-secret")
    set_redis_client(_UnavailableRedis(error))  # type: ignore[arg-type]
    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(
        transport=transport, base_url="https://testserver"
    ) as client:
        response = await client.get(
            "/api/v1/openapi.json", headers={"X-HMS-Edge-Secret": "edge-secret"}
        )

    assert response.status_code == 200


# --- the broad API limiter's window is created, kept and repaired atomically ---------

_CLIENT = ("203.0.113.10", 50000)


def _rate_key() -> str:
    from hms_backend.app.core.client_identity import (
        client_address_from_scope,
        rate_limit_key,
    )
    from hms_backend.app.core.http_security import _RATE_KEY_PREFIX

    address = client_address_from_scope({"client": _CLIENT, "headers": []})
    return f"{_RATE_KEY_PREFIX}{rate_limit_key(address)}"


async def _get(client: httpx.AsyncClient) -> httpx.Response:
    return await client.get("/api/v1/openapi.json")


def _api_client() -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=create_app(), client=_CLIENT)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


@pytest.mark.asyncio
async def test_first_request_creates_the_count_and_ttl_without_a_separate_expire(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "security_api_rate_limit_max_requests", 100)
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    expire_calls: list[object] = []
    original = redis.expire

    async def spy(*args: object, **kwargs: object) -> object:
        expire_calls.append(args)
        return await original(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(redis, "expire", spy)
    set_redis_client(redis)
    async with _api_client() as client:
        assert (await _get(client)).status_code == 200

    assert int(await redis.get(_rate_key())) == 1
    assert 0 < await redis.ttl(_rate_key()) <= 60
    assert expire_calls == []  # the TTL came with the increment, not after it


@pytest.mark.asyncio
async def test_later_requests_count_but_do_not_extend_the_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "security_api_rate_limit_max_requests", 100)
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    set_redis_client(redis)
    async with _api_client() as client:
        await _get(client)
        await redis.expire(_rate_key(), 7)
        await _get(client)
        await _get(client)

    assert int(await redis.get(_rate_key())) == 3
    assert 0 < await redis.ttl(_rate_key()) <= 7


@pytest.mark.asyncio
async def test_a_counter_left_without_a_ttl_repairs_itself(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "security_api_rate_limit_max_requests", 100)
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    set_redis_client(redis)
    # What the old INCR-then-EXPIRE code could leave behind.
    await redis.set(_rate_key(), 5)
    assert await redis.ttl(_rate_key()) == -1
    async with _api_client() as client:
        assert (await _get(client)).status_code == 200

    assert int(await redis.get(_rate_key())) == 6
    assert 0 < await redis.ttl(_rate_key()) <= 60


@pytest.mark.asyncio
async def test_an_over_limit_orphan_is_refused_with_a_positive_retry_after(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    set_redis_client(redis)
    await redis.set(_rate_key(), 999)  # over the limit of 1, with no TTL
    async with _api_client() as client:
        limited = await _get(client)

    assert limited.status_code == 429
    assert 1 <= int(limited.headers["retry-after"]) <= 60  # never derived from -1
    assert 0 < await redis.ttl(_rate_key()) <= 60  # so the block ends on its own


@pytest.mark.asyncio
async def test_concurrent_requests_are_all_counted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio

    monkeypatch.setattr(settings, "security_api_rate_limit_max_requests", 1000)
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    set_redis_client(redis)
    async with _api_client() as client:
        responses = await asyncio.gather(*(_get(client) for _ in range(40)))

    assert all(response.status_code == 200 for response in responses)
    assert int(await redis.get(_rate_key())) == 40
    assert 0 < await redis.ttl(_rate_key()) <= 60
