from __future__ import annotations

from collections.abc import AsyncIterator, Generator

import fakeredis.aioredis
import httpx
import pytest
from fastapi import Request

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
