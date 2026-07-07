from __future__ import annotations

from pathlib import Path

import pytest

from hms_certificate.config import Settings
from hms_certificate.domain import (
    CertificateData,
    EndConfig,
    Issuer,
    Party,
    PressureTest,
)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    """Isolated settings whose dev signer lives under a per-test temp dir."""
    return Settings(key_dir=tmp_path / "signing")


@pytest.fixture
def sample_data() -> CertificateData:
    return CertificateData(
        certificate_number="CERT-2026-000123",
        certificate_version=1,
        status="ISSUED",
        issued_at="2026-07-07T04:15:00Z",
        valid_until="2027-07-07",
        customer_code="ACME",
        customer_name="Acme Mining Pty Ltd",
        site_name="North Pit Workshop",
        site_location="Kalgoorlie, WA, Australia",
        asset_number="HA-00123",
        asset_tag="TAG-88",
        customer_serial_no="SN-55A",
        manufacture_date="2025-01-10",
        length_m="3.500",
        lifecycle_status="IN_SERVICE",
        product_code="HP-2W",
        product_name="2-Wire Hydraulic Hose",
        product_category="Hydraulic",
        standard_code="AS3862",
        standard_name="Hydraulic hose",
        ends=(
            EndConfig("A", "DN12", "Steel", 'BSP 1/2"', "", "Crimped"),
            EndConfig("B", "DN12", "Steel", 'JIC 3/4"', "Guard", "Crimped"),
        ),
        pressure_test=PressureTest(21000, 42000, 42000, 120, True, "water"),
        inspection_id="INS-9001",
        inspection_type="SERVICE",
        inspection_result="PASS",
        inspector=Party("u1", "Jane Field"),
        reviewer=Party("u2", "Sam Reviewer"),
        submitted_at="2026-07-06T22:00:00Z",
        approved_at="2026-07-07T03:00:00Z",
        issued_by=Party("u3", "Alex Admin"),
        issuer=Issuer(
            "BAT Engineering Pty Ltd",
            "Melbourne, VIC",
            "certs@bat.example",
            "ABN 12 345",
        ),
        public_token="tok_abc123",
        verify_url="https://hms.bat.example/verify/tok_abc123",
    )
