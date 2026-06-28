from fastapi import FastAPI


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

    return app


app = create_app()
