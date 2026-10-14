"""Shared HTTP security controls for every public API route."""

from __future__ import annotations

import hmac
import json
from typing import Any

from redis.exceptions import RedisError
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from hms_backend.app.core.config import settings
from hms_backend.app.core.redis import get_redis

_HEALTH_PATHS = frozenset({"/health", "/health/ready"})
_RATE_KEY_PREFIX = "hms:api-rate:"


def _headers(scope: Scope) -> dict[str, str]:
    return {key.decode().lower(): value.decode() for key, value in scope["headers"]}


async def _json(
    send: Send,
    status: int,
    payload: dict[str, Any],
    headers: dict[str, str] | None = None,
) -> None:
    response_headers = [(b"content-type", b"application/json")]
    response_headers.extend(
        (key.encode(), value.encode()) for key, value in (headers or {}).items()
    )
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": response_headers,
        }
    )
    await send({"type": "http.response.body", "body": json.dumps(payload).encode()})


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.extend(
                    [
                        (
                            b"content-security-policy",
                            settings.security_content_security_policy.encode(),
                        ),
                        (b"x-content-type-options", b"nosniff"),
                        (b"referrer-policy", b"strict-origin-when-cross-origin"),
                        (
                            b"permissions-policy",
                            b"camera=(), geolocation=(), microphone=()",
                        ),
                        (b"x-frame-options", b"DENY"),
                    ]
                )
                if not settings.is_local_or_test:
                    headers.append(
                        (
                            b"strict-transport-security",
                            (
                                f"max-age={settings.security_hsts_max_age_seconds}; "
                                "includeSubDomains"
                            ).encode(),
                        )
                    )
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_headers)


class RequestBodyLimitMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_headers = _headers(scope)
        content_length = request_headers.get("content-length")
        if content_length is not None:
            try:
                declared_size = int(content_length)
            except ValueError:
                await _json(send, 400, {"detail": "Invalid Content-Length"})
                return
            if declared_size < 0:
                await _json(send, 400, {"detail": "Invalid Content-Length"})
                return
            if declared_size > settings.security_max_request_body_bytes:
                await _json(send, 413, {"detail": "Request body too large"})
                return

        received = 0
        exceeded = False

        async def limited_receive() -> Message:
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                exceeded = received > settings.security_max_request_body_bytes
            return message

        async def send_limited(message: Message) -> None:
            if exceeded and message["type"] == "http.response.start":
                await _json(send, 413, {"detail": "Request body too large"})
                return
            if not exceeded:
                await send(message)

        await self.app(scope, limited_receive, send_limited)


class EdgeOriginMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] in _HEALTH_PATHS:
            await self.app(scope, receive, send)
            return

        expected = settings.security_edge_shared_secret
        if expected:
            provided = _headers(scope).get("x-hms-edge-secret", "")
            if not hmac.compare_digest(provided, expected):
                await _json(
                    send,
                    403,
                    {"detail": "Request must use the configured edge"},
                )
                return
        await self.app(scope, receive, send)


class ApiRateLimitMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            await self.app(scope, receive, send)
            return

        headers = _headers(scope)
        # Forwarded client addresses are accepted only after EdgeOriginMiddleware
        # has checked the CloudFront-only shared secret.
        forwarded = headers.get("x-forwarded-for", "")
        client = (
            forwarded.split(",", 1)[0].strip()
            if settings.security_edge_shared_secret
            else ""
        )
        if not client:
            client = (scope.get("client") or ("unknown", 0))[0]
        key = f"{_RATE_KEY_PREFIX}{client}"
        try:
            redis = get_redis()
            count = int(await redis.incr(key))
            if count == 1:
                await redis.expire(key, settings.security_api_rate_limit_window_seconds)
            if count > settings.security_api_rate_limit_max_requests:
                ttl = await redis.ttl(key)
                retry_after = max(1, int(ttl))
                await _json(
                    send,
                    429,
                    {"detail": "Too many requests; please try again later."},
                    {"retry-after": str(retry_after)},
                )
                return
        except (RedisError, RuntimeError, OSError):
            if not settings.is_local_or_test:
                await _json(
                    send,
                    503,
                    {"detail": "Request protection is temporarily unavailable."},
                )
                return
        await self.app(scope, receive, send)
