"""Async Redis client management.

A single process-wide :class:`redis.asyncio.Redis` (backed by a connection pool)
is created lazily from ``settings.redis_url``. Short connect/command timeouts mean
a missing Redis fails fast rather than hanging requests. Tests inject a fake client
via :func:`set_redis_client`.
"""

from __future__ import annotations

import redis.asyncio as aioredis

from hms_backend.app.core.config import settings

_client: aioredis.Redis | None = None


def get_redis() -> aioredis.Redis:
    """Return the shared async Redis client (created on first use)."""
    global _client
    if _client is None:
        _client = aioredis.from_url(  # type: ignore[no-untyped-call]
            settings.redis_url,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=settings.redis_connect_timeout_seconds,
            socket_timeout=settings.redis_command_timeout_seconds,
            retry_on_timeout=False,
            health_check_interval=30,
        )
    return _client


def set_redis_client(client: aioredis.Redis | None) -> None:
    """Override the shared client (used by tests / fakeredis)."""
    global _client
    _client = client


async def ping_redis() -> bool:
    """Return True if Redis responds to PING, False otherwise."""
    try:
        return bool(await get_redis().ping())
    except Exception:  # noqa: BLE001 - readiness must never raise
        return False


async def close_redis() -> None:
    global _client
    if _client is not None:
        try:
            await _client.aclose()
        except Exception:  # noqa: BLE001 - shutdown best-effort
            pass
        _client = None
