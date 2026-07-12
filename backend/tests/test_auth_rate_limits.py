"""Login rate-limiter tests (Task 3): fakeredis path + in-process fallback."""

from __future__ import annotations

from typing import Any

import fakeredis.aioredis
import pytest

from hms_backend.app.core.config import settings
from hms_backend.app.core.rate_limit import LoginRateLimiter
from hms_backend.app.core.redis import set_redis_client


@pytest.fixture(autouse=True)
def _fake_redis(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setattr(settings, "environment", "test")
    client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    set_redis_client(client)
    yield client
    set_redis_client(None)


def _limiter() -> LoginRateLimiter:
    return LoginRateLimiter(max_attempts=3, window_seconds=100, lockout_seconds=10)


@pytest.mark.asyncio
async def test_allows_up_to_the_threshold_then_locks() -> None:
    limiter = _limiter()
    for _ in range(3):
        assert (await limiter.hit("account:a@x.com")).allowed
    locked = await limiter.hit("account:a@x.com")
    assert not locked.allowed
    assert locked.retry_after_seconds == 10


@pytest.mark.asyncio
async def test_lockout_is_progressive() -> None:
    limiter = _limiter()
    for _ in range(3):
        await limiter.hit("account:a@x.com")
    first = await limiter.hit("account:a@x.com")  # overage 1
    second = await limiter.hit("account:a@x.com")  # overage 2
    assert second.retry_after_seconds > first.retry_after_seconds


@pytest.mark.asyncio
async def test_account_and_ip_keys_are_independent() -> None:
    limiter = _limiter()
    for _ in range(4):
        await limiter.hit("account:a@x.com")
    # The IP key is untouched, so it is still allowed.
    assert (await limiter.hit("ip:203.0.113.9")).allowed


@pytest.mark.asyncio
async def test_reset_clears_the_counter() -> None:
    limiter = _limiter()
    for _ in range(4):
        await limiter.hit("account:a@x.com")
    await limiter.reset("account:a@x.com")
    assert (await limiter.hit("account:a@x.com")).allowed


class _BrokenRedis:
    async def incr(self, *_args: Any, **_kwargs: Any) -> int:
        from redis.exceptions import RedisError

        raise RedisError("down")

    async def expire(self, *_args: Any, **_kwargs: Any) -> bool:
        return False

    async def delete(self, *_args: Any, **_kwargs: Any) -> int:
        return 0


@pytest.mark.asyncio
async def test_falls_back_to_in_process_counter_when_redis_down() -> None:
    set_redis_client(_BrokenRedis())  # type: ignore[arg-type]
    limiter = _limiter()
    # now injected so the fallback window is deterministic.
    for index in range(3):
        assert (await limiter.hit("account:a@x.com", now=1000.0 + index)).allowed
    locked = await limiter.hit("account:a@x.com", now=1003.0)
    assert not locked.allowed
    assert locked.retry_after_seconds == 10
