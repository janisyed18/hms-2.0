from fastapi import FastAPI

from hms_backend.app.api.records import router as records_router
from hms_backend.app.api.sync import router as sync_router


def create_app() -> FastAPI:
    app = FastAPI(
        title="BAT Engineering HMS 2.0 API",
        version="0.1.0",
        openapi_url="/api/v1/openapi.json",
        docs_url="/api/v1/docs",
    )

    @app.get("/health", tags=["health"])
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "hms-backend"}

    app.include_router(records_router, prefix="/api/v1", tags=["core-records"])
    app.include_router(sync_router, prefix="/api/v1", tags=["sync"])

    return app


app = create_app()
