"""Request correlation and structured request logs.

Every HTTP request gets a server-generated request ID, returned as ``X-Request-ID``
and attached to one JSON log line when the request finishes (or fails). The log is
deliberately narrow so it can be shipped and retained without becoming a data leak:

* the path is the matched *route template* (``/api/v1/inspections/{id}``), never the
  raw URL, so identifiers and path-borne tokens are not recorded; unmatched requests
  log ``(unmatched)``;
* query strings, headers, cookies and bodies are never read into the log;
* failures log the exception class and the call-site frames, never the exception
  message, because database and library errors routinely embed parameter values;
* the client address comes from the shared trusted resolver in ``client_identity``.

An inbound ``X-Request-ID`` is ignored: IDs are server-generated so a caller cannot
pick or forge the identifier that ties logs together.
"""

from __future__ import annotations

import json
import logging
import sys
import time
import traceback
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from hms_backend.app.core.client_identity import client_address_from_scope

REQUEST_ID_HEADER = b"x-request-id"
REQUEST_ID_SCOPE_KEY = "hms.request_id"
UNMATCHED_PATH = "(unmatched)"
_MAX_FRAMES = 12

request_logger = logging.getLogger("hms_backend.request")


class JsonFormatter(logging.Formatter):
    """One JSON object per line: fixed envelope plus the record's ``fields``."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(
                timespec="milliseconds"
            ),
            "level": record.levelname,
            "logger": record.name,
            "event": record.getMessage(),
        }
        payload.update(getattr(record, "fields", {}))
        return json.dumps(payload, separators=(",", ":"), default=str)


class _StdoutHandler(logging.StreamHandler):  # type: ignore[type-arg]
    """Writes to the *current* ``sys.stdout`` (container log driver, test capture)."""

    def __init__(self) -> None:
        super().__init__(sys.stdout)

    @property
    def stream(self) -> Any:
        return sys.stdout

    @stream.setter
    def stream(self, _value: Any) -> None:
        return None


class _DropAll(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return False


def configure_logging() -> None:
    """Install the JSON request logger. Safe to call repeatedly."""
    if not any(isinstance(h, _StdoutHandler) for h in request_logger.handlers):
        handler = _StdoutHandler()
        handler.setFormatter(JsonFormatter())
        request_logger.addHandler(handler)
    request_logger.setLevel(logging.INFO)
    request_logger.propagate = False
    # logging.config.fileConfig (used by Alembic) disables pre-existing loggers.
    request_logger.disabled = False

    # uvicorn's access log prints the full request target including the query string.
    # The structured request log replaces it, so drop it rather than log both.
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, _DropAll) for f in access.filters):
        access.addFilter(_DropAll())


def request_id_from_scope(scope: Scope) -> str | None:
    value = scope.get(REQUEST_ID_SCOPE_KEY)
    return value if isinstance(value, str) else None


def _route_template(scope: Scope) -> str:
    route = scope.get("route")
    path = getattr(route, "path", None)
    return path if isinstance(path, str) else UNMATCHED_PATH


def _safe_frames(exc: BaseException) -> list[str]:
    frames = traceback.extract_tb(exc.__traceback__)[-_MAX_FRAMES:]
    return [f"{frame.filename}:{frame.lineno} in {frame.name}" for frame in frames]


class RequestContextMiddleware:
    """Outermost middleware, so it also covers edge/size/rate-limit rejections."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = uuid4().hex
        scope[REQUEST_ID_SCOPE_KEY] = request_id
        started = time.perf_counter()
        status = 0

        async def send_with_id(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = int(message["status"])
                headers = [
                    (k, v)
                    for k, v in message.get("headers", [])
                    if k.lower() != REQUEST_ID_HEADER
                ]
                headers.append((REQUEST_ID_HEADER, request_id.encode()))
                message = {**message, "headers": headers}
            await send(message)

        failure: BaseException | None = None
        try:
            await self.app(scope, receive, send_with_id)
        except Exception as exc:
            failure = exc
            raise
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 1)
            fields: dict[str, Any] = {
                "request_id": request_id,
                "method": scope["method"],
                "path": _route_template(scope),
                "status": status or (500 if failure else 0),
                "duration_ms": duration_ms,
                "client_ip": client_address_from_scope(scope),
            }
            if failure is not None:
                fields["error_type"] = type(failure).__name__
                fields["frames"] = _safe_frames(failure)
                request_logger.error("request.failed", extra={"fields": fields})
            else:
                request_logger.info("request.completed", extra={"fields": fields})
