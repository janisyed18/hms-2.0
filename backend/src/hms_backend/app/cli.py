import uvicorn


def main() -> None:
    uvicorn.run(
        "hms_backend.app.main:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
    )
