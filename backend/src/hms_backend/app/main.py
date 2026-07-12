from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text

from hms_backend.app.api.admin import router as admin_router
from hms_backend.app.api.auth import router as auth_router
from hms_backend.app.api.browser_auth import router as browser_auth_router
from hms_backend.app.api.dependencies import engine
from hms_backend.app.api.jobs import router as jobs_router
from hms_backend.app.api.notifications import router as notifications_router
from hms_backend.app.api.public import router as public_router
from hms_backend.app.api.records import router as records_router
from hms_backend.app.api.sync import router as sync_router
from hms_backend.app.core.config import settings
from hms_backend.app.core.redis import close_redis, ping_redis


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    settings.validate_browser_auth()
    yield
    # Release the Redis connection pool on shutdown.
    await close_redis()


async def _check_database() -> bool:
    try:
        async with engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
        return True
    except Exception:  # noqa: BLE001 - readiness must never raise
        return False


def create_app() -> FastAPI:
    app = FastAPI(
        title="BAT Engineering HMS 2.0 API",
        version="0.1.0",
        openapi_url="/api/v1/openapi.json",
        docs_url="/api/v1/docs",
        lifespan=lifespan,
    )

    @app.get("/health", tags=["health"])
    async def health() -> dict[str, str]:
        # Liveness: the process is up. No external dependencies checked.
        return {"status": "ok", "service": "hms-backend"}

    @app.get("/health/ready", tags=["health"])
    async def readiness() -> JSONResponse:
        # Readiness: the database is the hard dependency; Redis is reported but
        # degrades gracefully, so a Redis outage does not fail readiness.
        db_ok = await _check_database()
        redis_ok = await ping_redis()
        ready = db_ok
        return JSONResponse(
            status_code=200 if ready else 503,
            content={
                "status": "ready" if ready else "not_ready",
                "checks": {
                    "database": "ok" if db_ok else "down",
                    "redis": "ok" if redis_ok else "unavailable",
                },
            },
        )

    @app.exception_handler(HTTPException)
    async def http_exception_handler(
        _request: Request,
        exc: HTTPException,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_payload(
                _status_code_to_error_code(exc.status_code),
                str(exc.detail) if isinstance(exc.detail, str) else "Request failed",
                None if isinstance(exc.detail, str) else exc.detail,
            ),
            headers=exc.headers,
        )

    @app.exception_handler(PermissionError)
    async def permission_exception_handler(
        _request: Request,
        exc: PermissionError,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=403,
            content=_error_payload("forbidden", str(exc), None),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        _request: Request,
        exc: RequestValidationError,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=_error_payload(
                "validation_error",
                "Request validation failed",
                exc.errors(),
            ),
        )

    app.include_router(records_router, prefix="/api/v1", tags=["core-records"])
    app.include_router(sync_router, prefix="/api/v1", tags=["sync"])
    app.include_router(auth_router, prefix="/api/v1", tags=["auth"])
    app.include_router(browser_auth_router, prefix="/api/v1", tags=["auth-browser"])
    app.include_router(admin_router, prefix="/api/v1", tags=["admin"])
    app.include_router(jobs_router, prefix="/api/v1")
    app.include_router(notifications_router, prefix="/api/v1")
    # Public verification is unauthenticated by design (token-scoped).
    app.include_router(public_router, prefix="/api/v1")

    return app


app = create_app()


def _error_payload(
    code: str,
    message: str,
    details: object | None,
) -> dict[str, object]:
    legacy_detail = details if details is not None else message
    return {
        "detail": legacy_detail,
        "error": {
            "code": code,
            "message": message,
            "details": details,
        }
    }


def _status_code_to_error_code(status_code: int) -> str:
    return {
        400: "bad_request",
        401: "unauthorized",
        403: "forbidden",
        404: "not_found",
        409: "conflict",
        412: "precondition_failed",
        422: "validation_error",
    }.get(status_code, "http_error")
