"""Request IDs and structured request logs (and what they must never contain)."""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Generator
from typing import Any

import fakeredis.aioredis
import httpx
import pytest
from fastapi import FastAPI

from hms_backend.app.core.config import settings
from hms_backend.app.core.redis import set_redis_client
from hms_backend.app.main import create_app

EDGE_SECRET = "edge-secret-for-tests"
REQUEST_ID = re.compile(r"^[0-9a-f]{32}$")


@pytest.fixture(autouse=True)
def _config(monkeypatch: pytest.MonkeyPatch) -> Generator[None]:
    monkeypatch.setattr(settings, "environment", "test")
    set_redis_client(fakeredis.aioredis.FakeRedis(decode_responses=True))
    yield
    set_redis_client(None)


def _app() -> FastAPI:
    app = create_app()

    @app.get("/api/v1/probe/{item_id}")
    async def probe(item_id: str) -> dict[str, str]:
        return {"ok": "yes"}

    @app.get("/api/v1/explode")
    async def explode() -> dict[str, str]:
        raise ValueError("database said password=hunter2-SECRET for user 4242")

    return app


def _client(app: FastAPI, *, peer: str = "203.0.113.5") -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(
            app=app, client=(peer, 40000), raise_app_exceptions=False
        ),
        base_url="http://t",
    )


def _request_logs(captured: str) -> list[dict[str, Any]]:
    entries = []
    for line in captured.splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)  # every line must be valid JSON
        if entry.get("logger") == "hms_backend.request":
            entries.append(entry)
    return entries


@pytest.mark.asyncio
async def test_each_request_gets_a_distinct_server_generated_id(
    capsys: pytest.CaptureFixture[str],
) -> None:
    async with _client(_app()) as client:
        first = await client.get("/health")
        second = await client.get("/health")

    ids = {first.headers["x-request-id"], second.headers["x-request-id"]}
    assert len(ids) == 2
    assert all(REQUEST_ID.match(value) for value in ids)
    logged = {entry["request_id"] for entry in _request_logs(capsys.readouterr().out)}
    assert logged == ids


@pytest.mark.asyncio
async def test_an_inbound_request_id_is_ignored(
    capsys: pytest.CaptureFixture[str],
) -> None:
    async with _client(_app()) as client:
        response = await client.get("/health", headers={"X-Request-ID": "attacker-1"})

    assert response.headers["x-request-id"] != "attacker-1"
    assert REQUEST_ID.match(response.headers["x-request-id"])
    assert "attacker-1" not in capsys.readouterr().out


@pytest.mark.asyncio
async def test_success_is_logged_with_correlated_fields(
    capsys: pytest.CaptureFixture[str],
) -> None:
    async with _client(_app()) as client:
        response = await client.get("/health")

    (entry,) = _request_logs(capsys.readouterr().out)
    assert response.status_code == 200
    assert entry["event"] == "request.completed"
    assert entry["level"] == "INFO"
    assert entry["request_id"] == response.headers["x-request-id"]
    assert entry["method"] == "GET"
    assert entry["path"] == "/health"
    assert entry["status"] == 200
    assert isinstance(entry["duration_ms"], int | float) and entry["duration_ms"] >= 0
    assert entry["client_ip"] == "203.0.113.5"
    assert entry["ts"].endswith("+00:00")


@pytest.mark.asyncio
async def test_client_errors_are_logged_with_status_and_no_raw_path(
    capsys: pytest.CaptureFixture[str],
) -> None:
    async with _client(_app()) as client:
        missing = await client.get("/api/v1/does-not-exist/SECRET-PATH-TOKEN")
        probe = await client.get("/api/v1/probe/SECRET-ITEM-ID")

    out = capsys.readouterr().out
    entries = _request_logs(out)
    assert [e["status"] for e in entries] == [missing.status_code, probe.status_code]
    assert missing.status_code == 404
    assert entries[0]["path"] == "(unmatched)"
    assert entries[1]["path"] == "/api/v1/probe/{item_id}"
    assert "SECRET-PATH-TOKEN" not in out
    assert "SECRET-ITEM-ID" not in out
    assert entries[0]["request_id"] == missing.headers["x-request-id"]


@pytest.mark.asyncio
async def test_unhandled_exception_is_correlated_and_does_not_leak_the_message(
    capsys: pytest.CaptureFixture[str],
) -> None:
    async with _client(_app()) as client:
        response = await client.get("/api/v1/explode")

    out = capsys.readouterr().out
    (entry,) = _request_logs(out)
    request_id = response.headers["x-request-id"]
    assert response.status_code == 500
    assert response.json()["error"] == {
        "code": "internal_error",
        "message": "Internal server error",
        "details": {"request_id": request_id},
    }
    assert entry["event"] == "request.failed"
    assert entry["level"] == "ERROR"
    assert entry["request_id"] == request_id
    assert entry["status"] == 500
    assert entry["path"] == "/api/v1/explode"
    assert entry["error_type"] == "ValueError"
    assert entry["frames"] and all(" in " in frame for frame in entry["frames"])
    assert "hunter2" not in out
    assert "4242" not in out
    assert "hunter2" not in response.text


@pytest.mark.asyncio
async def test_query_strings_headers_cookies_and_bodies_are_never_logged(
    capsys: pytest.CaptureFixture[str],
) -> None:
    async with _client(_app()) as client:
        await client.post(
            "/api/v1/auth/browser/login?password=QPASS&token=QTOKEN",
            json={"email": "a@example.test", "password": "BODYPASS"},
            headers={
                "Authorization": "Bearer HEADERTOKEN",
                "Cookie": "hms_staff_refresh=COOKIEVALUE",
            },
        )

    out = capsys.readouterr().out
    assert _request_logs(out)
    for secret in ("QPASS", "QTOKEN", "BODYPASS", "HEADERTOKEN", "COOKIEVALUE"):
        assert secret not in out
    assert "?" not in "".join(e["path"] for e in _request_logs(out))


@pytest.mark.asyncio
async def test_rejected_requests_still_carry_an_id_and_are_logged(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(settings, "security_edge_shared_secret", EDGE_SECRET)
    async with _client(_app()) as client:
        denied = await client.get("/api/v1/openapi.json")

    (entry,) = _request_logs(capsys.readouterr().out)
    assert denied.status_code == 403
    assert entry["status"] == 403
    assert entry["request_id"] == denied.headers["x-request-id"]


@pytest.mark.asyncio
async def test_logged_client_ip_is_the_trusted_viewer_not_a_forged_value(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(settings, "security_edge_shared_secret", EDGE_SECRET)
    monkeypatch.setattr(settings, "security_trusted_proxy_hops", 2)
    async with _client(_app(), peer="10.0.0.7") as client:
        await client.get(
            "/api/v1/probe/x",
            headers={
                "X-HMS-Edge-Secret": EDGE_SECRET,
                "X-Forwarded-For": "6.6.6.6, 198.51.100.20, 130.176.0.9",
            },
        )

    (entry,) = _request_logs(capsys.readouterr().out)
    assert entry["client_ip"] == "198.51.100.20"


@pytest.mark.asyncio
async def test_health_endpoints_work_normally(
    capsys: pytest.CaptureFixture[str],
) -> None:
    async with _client(_app()) as client:
        health = await client.get("/health")
        metadata = await client.get("/health/metadata")

    assert health.json() == {"status": "ok", "service": "hms-backend"}
    assert metadata.status_code == 200
    assert [e["path"] for e in _request_logs(capsys.readouterr().out)] == [
        "/health",
        "/health/metadata",
    ]


def test_uvicorn_access_log_with_query_strings_is_suppressed() -> None:
    create_app()
    seen: list[logging.LogRecord] = []

    class _Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            seen.append(record)

    access = logging.getLogger("uvicorn.access")
    handler = _Collect()
    access.addHandler(handler)
    previous_level = access.level
    access.setLevel(logging.INFO)
    try:
        access.info('%s - "GET /x?token=LEAKED HTTP/1.1" 200', "1.2.3.4")
    finally:
        access.removeHandler(handler)
        access.setLevel(previous_level)

    assert seen == []


# --- uvicorn's own per-request traceback (real server) ------------------------------

_SERVER_SECRET = "SERVER-SIDE-SECRET-hunter2"


async def _hit_real_uvicorn(app: FastAPI, path: str) -> httpx.Response:
    """Serve ``app`` with a real uvicorn server so its real log path runs."""
    import asyncio

    import uvicorn

    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=0,
        log_config=None,
        lifespan="off",
        http="h11",
        loop="asyncio",
    )
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    try:
        for _ in range(200):
            if server.started:
                break
            await asyncio.sleep(0.01)
        assert server.started, "uvicorn did not start"
        port = server.servers[0].sockets[0].getsockname()[1]
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as client:
            return await client.get(path)
    finally:
        server.should_exit = True
        await task


@pytest.fixture
def _uvicorn_error_logger_enabled() -> Generator[None]:
    # Alembic's fileConfig (run by other tests in this process) disables existing
    # loggers; a disabled logger would make the "no leak" assertions vacuous.
    logger = logging.getLogger("uvicorn.error")
    was_disabled = logger.disabled
    logger.disabled = False
    yield
    logger.disabled = was_disabled


def _secret_app() -> FastAPI:
    app = create_app()

    @app.get("/api/v1/leaky")
    async def leaky() -> dict[str, str]:
        raise RuntimeError(f"upstream rejected credential {_SERVER_SECRET}")

    return app


def _uvicorn_error_text(caplog: pytest.LogCaptureFixture) -> str:
    return "\n".join(
        record.getMessage() + (record.exc_text or "") + repr(record.exc_info)
        for record in caplog.records
        if record.name == "uvicorn.error"
    )


@pytest.mark.asyncio
@pytest.mark.usefixtures("_uvicorn_error_logger_enabled")
async def test_real_uvicorn_does_not_log_the_exception_message(
    caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str]
) -> None:
    app = _secret_app()  # installs the uvicorn.error filter
    caplog.set_level(logging.DEBUG)

    response = await _hit_real_uvicorn(app, "/api/v1/leaky")

    assert response.status_code == 500
    assert _SERVER_SECRET not in response.text
    assert _SERVER_SECRET not in _uvicorn_error_text(caplog)
    assert "Exception in ASGI application" not in caplog.text
    out = capsys.readouterr().out
    assert _SERVER_SECRET not in out
    (entry,) = [e for e in _request_logs(out) if e["event"] == "request.failed"]
    assert entry["error_type"] == "RuntimeError"
    assert entry["request_id"] == response.headers["x-request-id"]


@pytest.mark.asyncio
@pytest.mark.usefixtures("_uvicorn_error_logger_enabled")
async def test_control_without_the_filter_uvicorn_does_leak_the_message(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Proves the test above can detect the leak, so its pass is meaningful."""
    app = _secret_app()
    server_errors = logging.getLogger("uvicorn.error")
    installed = list(server_errors.filters)
    for log_filter in installed:
        server_errors.removeFilter(log_filter)
    caplog.set_level(logging.DEBUG)
    try:
        await _hit_real_uvicorn(app, "/api/v1/leaky")
    finally:
        for log_filter in installed:
            server_errors.addFilter(log_filter)

    assert _SERVER_SECRET in _uvicorn_error_text(caplog)


@pytest.mark.usefixtures("_uvicorn_error_logger_enabled")
def test_other_uvicorn_server_errors_are_preserved(
    caplog: pytest.LogCaptureFixture,
) -> None:
    create_app()
    caplog.set_level(logging.DEBUG)
    server_errors = logging.getLogger("uvicorn.error")

    server_errors.error("Application startup failed. Exiting.")
    server_errors.error("Exception in 'lifespan' protocol\n")
    server_errors.error("Invalid HTTP request received.")
    server_errors.error("Exception in ASGI application\n")

    messages = [r.getMessage() for r in caplog.records if r.name == "uvicorn.error"]
    assert messages == [
        "Application startup failed. Exiting.",
        "Exception in 'lifespan' protocol\n",
        "Invalid HTTP request received.",
    ]
