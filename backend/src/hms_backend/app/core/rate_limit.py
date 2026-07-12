"""Login throttling (Task 3).

A fixed-window counter, keyed independently by normalised account and by source
IP, with a progressive lockout. Backed by Redis so it holds across API tasks; if
Redis is unreachable it fails *secure* in deployed environments (deny) and falls
back to a bounded in-process counter only in local/test.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from redis.exceptions import RedisError

from hms_backend.app.core.config import settings
from hms_backend.app.core.redis import get_redis

_KEY_PREFIX = "hms:login-rate:"
_FALLBACK_MAX_KEYS = 10_000


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    retry_after_seconds: int


class LoginRateLimiter:
    def __init__(
        self,
        *,
        max_attempts: int | None = None,
        window_seconds: int | None = None,
        lockout_seconds: int | None = None,
    ) -> None:
        self._max = max_attempts or settings.auth_login_rate_limit_max_attempts
        self._window = window_seconds or settings.auth_login_rate_limit_window_seconds
        self._lockout = lockout_seconds or settings.auth_login_lockout_seconds
        self._fallback: dict[str, tuple[int, float]] = {}

    def _decision(self, count: int) -> RateLimitDecision:
        if count <= self._max:
            return RateLimitDecision(allowed=True, retry_after_seconds=0)
        overage = count - self._max
        # Progressive: each attempt past the threshold extends the lockout,
        # capped at the window so it can never grow unbounded.
        retry_after = min(self._lockout * overage, self._window)
        return RateLimitDecision(allowed=False, retry_after_seconds=retry_after)

    async def hit(self, key: str, *, now: float | None = None) -> RateLimitDecision:
        namespaced = f"{_KEY_PREFIX}{key}"
        try:
            client = get_redis()
            count = int(await client.incr(namespaced))
            if count == 1:
                await client.expire(namespaced, self._window)
            return self._decision(count)
        except (RedisError, RuntimeError, OSError):
            if not settings.is_local_or_test:
                # Never let a throttle outage silently disable rate limiting.
                return RateLimitDecision(
                    allowed=False, retry_after_seconds=self._lockout
                )
            return self._fallback_hit(
                namespaced, now if now is not None else time.monotonic()
            )

    def _fallback_hit(self, key: str, now: float) -> RateLimitDecision:
        count, reset_at = self._fallback.get(key, (0, now + self._window))
        if now >= reset_at:
            count, reset_at = 0, now + self._window
        count += 1
        if len(self._fallback) > _FALLBACK_MAX_KEYS:
            self._fallback.clear()
        self._fallback[key] = (count, reset_at)
        return self._decision(count)

    async def reset(self, key: str) -> None:
        namespaced = f"{_KEY_PREFIX}{key}"
        self._fallback.pop(namespaced, None)
        try:
            await get_redis().delete(namespaced)
        except (RedisError, RuntimeError, OSError):
            pass
