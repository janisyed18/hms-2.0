"""Trusted client identity: one resolver for every per-client control."""

from __future__ import annotations

from collections.abc import AsyncGenerator, Generator

import fakeredis.aioredis
import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from hms_backend.app.api import browser_auth
from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.client_identity import (
    normalize_ip,
    rate_limit_key,
    resolve_client_address,
)
from hms_backend.app.core.config import Settings, settings
from hms_backend.app.core.rate_limit import LoginRateLimiter
from hms_backend.app.core.redis import set_redis_client
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base

EDGE_SECRET = "edge-secret-for-tests"
ALB_PEER = "10.0.12.34"
CLOUDFRONT = "130.176.0.9"
LOGIN = "/api/v1/auth/browser/login"


@pytest.fixture(autouse=True)
def _config(monkeypatch: pytest.MonkeyPatch) -> Generator[None]:
    monkeypatch.setattr(settings, "environment", "test")
    monkeypatch.setattr(settings, "auth_mode", "bearer")
    monkeypatch.setattr(settings, "auth_bearer_hmac_secret", "unit-test-secret")
    monkeypatch.setattr(settings, "auth_browser_login_enabled", True)
    monkeypatch.setattr(settings, "security_edge_shared_secret", EDGE_SECRET)
    monkeypatch.setattr(settings, "security_trusted_proxy_hops", 2)
    set_redis_client(fakeredis.aioredis.FakeRedis(decode_responses=True))
    yield
    set_redis_client(None)


def _chain(*entries: str) -> list[str]:
    return [", ".join(entries)]


# --- normalisation -------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("203.0.113.7", "203.0.113.7"),
        (" 203.0.113.7 ", "203.0.113.7"),
        ("203.0.113.7:51234", "203.0.113.7"),
        ("2001:DB8:0:0:0:0:0:1", "2001:db8::1"),
        ("[2001:db8::1]", "2001:db8::1"),
        ("[2001:db8::1]:443", "2001:db8::1"),
        ("::ffff:203.0.113.7", "203.0.113.7"),
    ],
)
def test_valid_addresses_are_normalised(raw: str, expected: str) -> None:
    assert normalize_ip(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        None,
        "",
        "   ",
        "unknown",
        "999.1.1.1",
        "1.2.3",
        "1.2.3.4.5",
        "203.0.113.7:abc",
        "[2001:db8::1",
        "[2001:db8::1]junk",
        "fe80::1%eth0",
        "2001:db8::1::2",
        "a" * 200,
        "203.0.113.7, 198.51.100.1",
        "<script>",
    ],
)
def test_malformed_addresses_fail_safely(raw: str | None) -> None:
    assert normalize_ip(raw) is None
    assert rate_limit_key(raw) == "unknown"


def test_ipv6_clients_share_a_key_across_their_64() -> None:
    assert rate_limit_key("2001:db8:1:2::1") == rate_limit_key("2001:db8:1:2:ffff::9")
    assert rate_limit_key("2001:db8:1:2::1") != rate_limit_key("2001:db8:1:3::1")
    assert rate_limit_key("203.0.113.7") == "203.0.113.7"


# --- resolution ----------------------------------------------------------------


def test_authenticated_edge_resolves_the_viewer_from_the_right() -> None:
    resolved = resolve_client_address(
        peer=ALB_PEER,
        forwarded_for=_chain("198.51.100.20", CLOUDFRONT),
        edge_secret=EDGE_SECRET,
    )
    assert resolved == "198.51.100.20"


def test_malicious_leading_values_cannot_choose_the_identity() -> None:
    honest = resolve_client_address(
        peer=ALB_PEER,
        forwarded_for=_chain("198.51.100.20", CLOUDFRONT),
        edge_secret=EDGE_SECRET,
    )
    forged = resolve_client_address(
        peer=ALB_PEER,
        forwarded_for=_chain(
            "1.1.1.1", "2.2.2.2, 3.3.3.3", "198.51.100.20", CLOUDFRONT
        ),
        edge_secret=EDGE_SECRET,
    )
    assert forged == honest == "198.51.100.20"


def test_multiple_header_lines_resolve_like_one_joined_line() -> None:
    resolved = resolve_client_address(
        peer=ALB_PEER,
        forwarded_for=["9.9.9.9", "198.51.100.20", CLOUDFRONT],
        edge_secret=EDGE_SECRET,
    )
    assert resolved == "198.51.100.20"


def test_ipv6_viewer_is_resolved() -> None:
    resolved = resolve_client_address(
        peer=ALB_PEER,
        forwarded_for=_chain("2001:db8:aa::5", CLOUDFRONT),
        edge_secret=EDGE_SECRET,
    )
    assert resolved == "2001:db8:aa::5"


@pytest.mark.parametrize("secret", [None, "", "wrong-secret", EDGE_SECRET + "x"])
def test_forwarded_header_without_the_edge_secret_is_ignored(
    secret: str | None,
) -> None:
    resolved = resolve_client_address(
        peer="203.0.113.99",
        forwarded_for=_chain("198.51.100.20", CLOUDFRONT),
        edge_secret=secret,
    )
    assert resolved == "203.0.113.99"


def test_no_trusted_hops_configured_means_the_header_is_never_used(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "security_trusted_proxy_hops", 0)
    resolved = resolve_client_address(
        peer="127.0.0.1",
        forwarded_for=_chain("198.51.100.20", CLOUDFRONT),
        edge_secret=EDGE_SECRET,
    )
    assert resolved == "127.0.0.1"


@pytest.mark.parametrize(
    "chain",
    [
        [],
        [CLOUDFRONT],  # shorter than the trusted chain
        _chain("not-an-ip", CLOUDFRONT),
        _chain("bogus, " + CLOUDFRONT),
        _chain("", CLOUDFRONT),
    ],
)
def test_unexpected_chains_fall_back_to_the_peer(chain: list[str]) -> None:
    resolved = resolve_client_address(
        peer=ALB_PEER, forwarded_for=chain, edge_secret=EDGE_SECRET
    )
    assert resolved == ALB_PEER


def test_missing_or_malformed_peer_with_no_trusted_header_is_none() -> None:
    assert resolve_client_address(peer=None, forwarded_for=[], edge_secret=None) is None
    assert (
        resolve_client_address(peer="garbage", forwarded_for=[], edge_secret=None)
        is None
    )


def test_direct_local_traffic_uses_the_socket_peer() -> None:
    assert (
        resolve_client_address(
            peer="127.0.0.1", forwarded_for=_chain("8.8.8.8"), edge_secret=None
        )
        == "127.0.0.1"
    )


# --- configuration guard -------------------------------------------------------


def test_trusted_hops_without_an_edge_secret_is_a_configuration_error() -> None:
    config = Settings.model_validate(
        {
            "environment": "local",
            "security_trusted_proxy_hops": 2,
            "security_edge_shared_secret": "",
        }
    )
    assert config.http_security_config_errors() == [
        "SECURITY_TRUSTED_PROXY_HOPS requires SECURITY_EDGE_SHARED_SECRET"
    ]


def _settings(**values: object) -> Settings:
    return Settings.model_validate(values)


@pytest.mark.parametrize("environment", ["local", "test"])
def test_local_and_test_allow_zero_trusted_hops(environment: str) -> None:
    config = _settings(
        environment=environment,
        security_trusted_proxy_hops=0,
        security_edge_shared_secret="",
    )
    assert config.http_security_config_errors() == []


def test_deployed_with_edge_secret_but_zero_hops_is_rejected() -> None:
    config = _settings(
        environment="production",
        security_trusted_proxy_hops=0,
        security_edge_shared_secret=EDGE_SECRET,
    )
    assert config.http_security_config_errors() == [
        "SECURITY_TRUSTED_PROXY_HOPS must be configured outside local/test"
    ]
    with pytest.raises(RuntimeError, match="SECURITY_TRUSTED_PROXY_HOPS"):
        config.validate_http_security()


def test_deployed_with_edge_secret_and_hops_is_accepted() -> None:
    config = _settings(
        environment="production",
        security_trusted_proxy_hops=2,
        security_edge_shared_secret=EDGE_SECRET,
    )
    assert config.http_security_config_errors() == []


def test_deployed_hops_without_an_edge_secret_is_rejected() -> None:
    config = _settings(
        environment="production",
        security_trusted_proxy_hops=2,
        security_edge_shared_secret="",
    )
    assert config.http_security_config_errors() == [
        "SECURITY_TRUSTED_PROXY_HOPS requires SECURITY_EDGE_SHARED_SECRET"
    ]


def test_trusted_hops_with_an_edge_secret_is_accepted() -> None:
    config = Settings.model_validate(
        {
            "environment": "local",
            "security_trusted_proxy_hops": 2,
            "security_edge_shared_secret": EDGE_SECRET,
        }
    )
    assert config.http_security_config_errors() == []


# --- end to end through the real middleware and routes ---------------------------


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


def _app(session_factory: async_sessionmaker[AsyncSession]):  # type: ignore[no-untyped-def]
    app = create_app()

    async def _override() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = _override
    return app


def _client(app, *, peer: str = ALB_PEER) -> httpx.AsyncClient:  # type: ignore[no-untyped-def]
    # Every request reaches the API from the load balancer, never from the viewer.
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, client=(peer, 40000)),
        base_url="http://t",
    )


def _via_edge(*xff: str) -> dict[str, str]:
    return {"X-HMS-Edge-Secret": EDGE_SECRET, "X-Forwarded-For": ", ".join(xff)}


async def _failed_login(
    client: httpx.AsyncClient, headers: dict[str, str], n: int
) -> int:
    response = await client.post(
        LOGIN,
        json={"email": f"nobody{n}@example.test", "password": "wrong"},
        headers=headers,
    )
    return response.status_code


@pytest.fixture
def _tight_login_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        browser_auth,
        "_ip_login_limiter",
        LoginRateLimiter(max_attempts=3, window_seconds=300, lockout_seconds=60),
    )
    # Distinct emails per attempt keep the account bucket out of the way.
    monkeypatch.setattr(
        browser_auth,
        "_account_login_limiter",
        LoginRateLimiter(max_attempts=100, window_seconds=300, lockout_seconds=60),
    )


@pytest.mark.asyncio
@pytest.mark.usefixtures("_tight_login_limits")
async def test_two_real_clients_do_not_share_one_login_bucket(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = _via_edge("198.51.100.1", CLOUDFRONT)
    bob = _via_edge("198.51.100.2", CLOUDFRONT)
    async with _client(_app(session_factory)) as client:
        for n in range(3):
            assert await _failed_login(client, alice, n) == 401
        assert await _failed_login(client, alice, 3) == 429
        # Same ALB peer, different viewer: unaffected by alice's lockout.
        assert await _failed_login(client, bob, 4) == 401


@pytest.mark.asyncio
@pytest.mark.usefixtures("_tight_login_limits")
async def test_rotating_forged_leading_xff_does_not_evade_the_login_limit(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with _client(_app(session_factory)) as client:
        for n in range(3):
            headers = _via_edge(f"192.0.2.{n + 1}", "198.51.100.1", CLOUDFRONT)
            assert await _failed_login(client, headers, n) == 401
        forged = _via_edge("192.0.2.200", "198.51.100.1", CLOUDFRONT)
        assert await _failed_login(client, forged, 3) == 429


@pytest.mark.asyncio
@pytest.mark.usefixtures("_tight_login_limits")
async def test_forged_forwarding_without_the_edge_is_refused_by_the_edge_guard(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with _client(_app(session_factory)) as client:
        response = await client.post(
            LOGIN,
            json={"email": "a@example.test", "password": "x"},
            headers={"X-Forwarded-For": "198.51.100.1, " + CLOUDFRONT},
        )
        wrong_secret = await client.post(
            LOGIN,
            json={"email": "a@example.test", "password": "x"},
            headers={
                "X-HMS-Edge-Secret": "wrong",
                "X-Forwarded-For": "198.51.100.1, " + CLOUDFRONT,
            },
        )
    assert response.status_code == 403
    assert wrong_secret.status_code == 403


@pytest.mark.asyncio
@pytest.mark.usefixtures("_tight_login_limits")
async def test_login_with_malformed_forwarding_still_works_and_is_limited_by_peer(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    junk = _via_edge("not-an-ip", "also-bad")
    async with _client(_app(session_factory)) as client:
        for n in range(3):
            assert await _failed_login(client, junk, n) == 401
        assert await _failed_login(client, junk, 3) == 429


@pytest.mark.asyncio
async def test_direct_local_traffic_without_a_trusted_edge_still_works(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    monkeypatch.setattr(settings, "security_edge_shared_secret", None)
    monkeypatch.setattr(settings, "security_trusted_proxy_hops", 0)
    async with _client(_app(session_factory), peer="127.0.0.1") as client:
        health = await client.get("/health")
        forged = await client.get(
            "/api/v1/openapi.json", headers={"X-Forwarded-For": "1.2.3.4"}
        )
    assert health.status_code == 200
    assert forged.status_code == 200


@pytest.mark.asyncio
async def test_global_api_limiter_keys_on_the_viewer_not_on_the_leading_xff(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    monkeypatch.setattr(settings, "security_api_rate_limit_max_requests", 2)
    monkeypatch.setattr(settings, "security_api_rate_limit_window_seconds", 60)
    path = "/api/v1/openapi.json"
    async with _client(_app(session_factory)) as client:
        # A viewer who rotates the attacker-controlled prefix stays in one bucket.
        statuses = [
            (
                await client.get(
                    path,
                    headers=_via_edge(f"192.0.2.{i}", "198.51.100.1", CLOUDFRONT),
                )
            ).status_code
            for i in range(3)
        ]
        other_viewer = await client.get(
            path, headers=_via_edge("198.51.100.2", CLOUDFRONT)
        )
    assert statuses == [200, 200, 429]
    assert other_viewer.status_code == 200
