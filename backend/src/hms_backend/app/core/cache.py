"""Graceful cache-aside layer over Redis.

Design goals:
  * **Never break a request.** Any Redis error is swallowed and treated as a
    cache miss, so the app keeps serving from the database if Redis is down.
  * **Fail fast under outage.** After a Redis error a short circuit-breaker
    window skips cache calls entirely, so an outage doesn't add a timeout to
    every request.
  * **JSON values, namespaced keys.**

This is intended for read-heavy, low-churn, non-tenant-scoped data (e.g.
reference lookups). Do not cache customer-scoped or safety-critical live state
without explicit, immediate invalidation.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from redis.exceptions import RedisError

from hms_backend.app.core.config import settings
from hms_backend.app.core.redis import get_redis

logger = logging.getLogger("hms_backend.cache")

_KEY_PREFIX = "hms:cache:"
_disabled_until = 0.0

__all__ = [
    "cache_delete",
    "cache_delete_prefix",
    "cache_get_json",
    "cache_set_json",
    "reset_circuit_breaker",
    "settings",
]


def _namespaced(key: str) -> str:
    return f"{_KEY_PREFIX}{key}"


def _available() -> bool:
    if not settings.cache_enabled:
        return False
    return time.monotonic() >= _disabled_until


def _trip_breaker(exc: Exception) -> None:
    global _disabled_until
    _disabled_until = time.monotonic() + settings.cache_circuit_breaker_seconds
    logger.warning(
        "cache disabled for %.0fs after Redis error: %s",
        settings.cache_circuit_breaker_seconds,
        exc,
    )


async def cache_get_json(key: str) -> Any | None:
    """Return the cached JSON value for ``key`` or None (miss / unavailable)."""
    if not _available():
        return None
    try:
        raw = await get_redis().get(_namespaced(key))
    except (RedisError, RuntimeError) as exc:
        _trip_breaker(exc)
        return None
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


async def cache_set_json(key: str, value: Any, ttl: int | None = None) -> None:
    if not _available():
        return
    try:
        payload = json.dumps(value, separators=(",", ":"), default=str)
        await get_redis().set(
            _namespaced(key), payload, ex=ttl or settings.cache_ttl_seconds
        )
    except (RedisError, RuntimeError) as exc:
        _trip_breaker(exc)


async def cache_delete(*keys: str) -> None:
    if not _available() or not keys:
        return
    try:
        await get_redis().delete(*[_namespaced(k) for k in keys])
    except (RedisError, RuntimeError) as exc:
        _trip_breaker(exc)


async def cache_delete_prefix(prefix: str) -> None:
    """Delete every key under a namespace prefix (e.g. ``reference:``)."""
    if not _available():
        return
    pattern = f"{_namespaced(prefix)}*"
    try:
        client = get_redis()
        batch: list[str] = []
        async for key in client.scan_iter(match=pattern, count=200):
            batch.append(key)
            if len(batch) >= 200:
                await client.delete(*batch)
                batch = []
        if batch:
            await client.delete(*batch)
    except (RedisError, RuntimeError) as exc:
        _trip_breaker(exc)


def reset_circuit_breaker() -> None:
    """Re-enable cache attempts immediately (used by tests)."""
    global _disabled_until
    _disabled_until = 0.0
