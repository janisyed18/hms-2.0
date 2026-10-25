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
    def pipeline(self, *_args: Any, **_kwargs: Any) -> Any:
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


# --- the window is created, kept and repaired atomically -----------------------------

_ACCOUNT = "hms:login-rate:account:a@x.com"
_IP = "hms:login-rate:ip:203.0.113.9"


@pytest.mark.asyncio
async def test_first_hit_creates_the_counter_and_its_ttl_together(
    _fake_redis: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    expire_calls: list[object] = []
    original = _fake_redis.expire

    async def spy(*args: Any, **kwargs: Any) -> object:
        expire_calls.append(args)
        return await original(*args, **kwargs)

    monkeypatch.setattr(_fake_redis, "expire", spy)
    await _limiter().hit("account:a@x.com")

    assert int(await _fake_redis.get(_ACCOUNT)) == 1
    assert 0 < await _fake_redis.ttl(_ACCOUNT) <= 100
    assert expire_calls == []


@pytest.mark.asyncio
async def test_later_hits_do_not_extend_a_healthy_window(_fake_redis: Any) -> None:
    limiter = _limiter()
    await limiter.hit("account:a@x.com")
    await _fake_redis.expire(_ACCOUNT, 9)
    await limiter.hit("account:a@x.com")

    assert int(await _fake_redis.get(_ACCOUNT)) == 2
    assert 0 < await _fake_redis.ttl(_ACCOUNT) <= 9


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("key", "name"), [(_ACCOUNT, "account:a@x.com"), (_IP, "ip:203.0.113.9")]
)
async def test_an_orphaned_counter_without_a_ttl_repairs_itself(
    _fake_redis: Any, key: str, name: str
) -> None:
    await _fake_redis.set(key, 1)  # what INCR-then-EXPIRE could leave behind
    assert await _fake_redis.ttl(key) == -1

    decision = await _limiter().hit(name)

    assert decision.allowed
    assert int(await _fake_redis.get(key)) == 2
    assert 0 < await _fake_redis.ttl(key) <= 100


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("key", "name"), [(_ACCOUNT, "account:a@x.com"), (_IP, "ip:203.0.113.9")]
)
async def test_an_orphan_already_over_the_threshold_still_ends_on_its_own(
    _fake_redis: Any, key: str, name: str
) -> None:
    await _fake_redis.set(key, 50)

    decision = await _limiter().hit(name)

    assert not decision.allowed
    assert decision.retry_after_seconds == 100  # unchanged policy: capped at the window
    assert 0 < await _fake_redis.ttl(key) <= 100  # so the block cannot be permanent


@pytest.mark.asyncio
async def test_concurrent_hits_are_all_counted(_fake_redis: Any) -> None:
    import asyncio

    limiter = LoginRateLimiter(
        max_attempts=1000, window_seconds=100, lockout_seconds=10
    )
    await asyncio.gather(*(limiter.hit("account:a@x.com") for _ in range(40)))

    assert int(await _fake_redis.get(_ACCOUNT)) == 40
    assert 0 < await _fake_redis.ttl(_ACCOUNT) <= 100


@pytest.mark.asyncio
async def test_reset_removes_the_counter_and_its_ttl(_fake_redis: Any) -> None:
    limiter = _limiter()
    await limiter.hit("account:a@x.com")
    await limiter.reset("account:a@x.com")

    assert await _fake_redis.get(_ACCOUNT) is None
    assert (await limiter.hit("account:a@x.com")).allowed
    assert int(await _fake_redis.get(_ACCOUNT)) == 1


@pytest.mark.asyncio
async def test_a_redis_outage_still_fails_closed_when_deployed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "environment", "production")
    set_redis_client(_BrokenRedis())  # type: ignore[arg-type]

    decision = await _limiter().hit("account:a@x.com")

    assert not decision.allowed
    assert decision.retry_after_seconds == 10
