import httpx
import pytest

from hms_backend.app.main import create_app


@pytest.mark.asyncio
async def test_health_endpoint_reports_ok() -> None:
    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        response = await client.get("/health")

        assert response.status_code == 200
        assert response.json() == {"status": "ok", "service": "hms-backend"}


@pytest.mark.asyncio
async def test_runtime_metadata_reports_pinned_timezone_data() -> None:
    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        response = await client.get("/health/metadata")

    assert response.status_code == 200
    assert response.json() == {
        "tzdata_package_version": "2026.5",
        "iana_timezone_version": "2026e",
        "timezone_data_source": "tzdata",
    }
