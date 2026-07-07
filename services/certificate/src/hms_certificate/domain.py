"""Typed domain model and the canonical verification-hash algorithm.

The dataclasses here are a thin, test-friendly mirror of the protobuf messages so
the rendering and signing code never touches raw protobuf objects.

``compute_verification_hash`` defines the tamper-evidence contract. The SAME
algorithm is reimplemented in the backend (``modules/certificates/verification``)
so the public verify endpoint can recompute the hash from persisted data and
compare. The shared test vector in ``tests/test_verification.py`` (service) and
the backend test suite guard the two implementations against drift.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

from hms_certificate.proto import certificate_pb2 as pb


@dataclass(frozen=True)
class EndConfig:
    end: str
    nominal_bore: str = ""
    material: str = ""
    coupling: str = ""
    coupling_add_on: str = ""
    attach_method: str = ""


@dataclass(frozen=True)
class PressureTest:
    working_pressure_kpa: int = 0
    test_pressure_kpa: int = 0
    applied_pressure_kpa: int = 0
    hold_time_seconds: int = 0
    passed: bool = False
    medium: str = ""


@dataclass(frozen=True)
class Party:
    id: str = ""
    name: str = ""


@dataclass(frozen=True)
class Issuer:
    name: str = ""
    address: str = ""
    contact: str = ""
    identifier: str = ""


@dataclass(frozen=True)
class CertificateData:
    certificate_number: str
    certificate_version: int
    status: str
    issued_at: str
    valid_until: str = ""
    customer_code: str = ""
    customer_name: str = ""
    site_name: str = ""
    site_location: str = ""
    asset_number: str = ""
    asset_tag: str = ""
    customer_serial_no: str = ""
    manufacture_date: str = ""
    length_m: str = ""
    lifecycle_status: str = ""
    product_code: str = ""
    product_name: str = ""
    product_category: str = ""
    standard_code: str = ""
    standard_name: str = ""
    ends: tuple[EndConfig, ...] = ()
    pressure_test: PressureTest | None = None
    inspection_id: str = ""
    inspection_type: str = ""
    inspection_result: str = ""
    inspector: Party = field(default_factory=Party)
    reviewer: Party = field(default_factory=Party)
    submitted_at: str = ""
    approved_at: str = ""
    issued_by: Party = field(default_factory=Party)
    issuer: Issuer = field(default_factory=Issuer)
    public_token: str = ""
    verify_url: str = ""

    @classmethod
    def from_proto(cls, data: pb.CertificateData) -> CertificateData:
        pt = data.pressure_test
        has_pt = data.HasField("pressure_test")
        return cls(
            certificate_number=data.certificate_number,
            certificate_version=data.certificate_version,
            status=data.status,
            issued_at=data.issued_at,
            valid_until=data.valid_until,
            customer_code=data.customer_code,
            customer_name=data.customer_name,
            site_name=data.site_name,
            site_location=data.site_location,
            asset_number=data.asset_number,
            asset_tag=data.asset_tag,
            customer_serial_no=data.customer_serial_no,
            manufacture_date=data.manufacture_date,
            length_m=data.length_m,
            lifecycle_status=data.lifecycle_status,
            product_code=data.product_code,
            product_name=data.product_name,
            product_category=data.product_category,
            standard_code=data.standard_code,
            standard_name=data.standard_name,
            ends=tuple(
                EndConfig(
                    end=e.end,
                    nominal_bore=e.nominal_bore,
                    material=e.material,
                    coupling=e.coupling,
                    coupling_add_on=e.coupling_add_on,
                    attach_method=e.attach_method,
                )
                for e in data.ends
            ),
            pressure_test=(
                PressureTest(
                    working_pressure_kpa=pt.working_pressure_kpa,
                    test_pressure_kpa=pt.test_pressure_kpa,
                    applied_pressure_kpa=pt.applied_pressure_kpa,
                    hold_time_seconds=pt.hold_time_seconds,
                    passed=pt.passed,
                    medium=pt.medium,
                )
                if has_pt
                else None
            ),
            inspection_id=data.inspection_id,
            inspection_type=data.inspection_type,
            inspection_result=data.inspection_result,
            inspector=Party(id=data.inspector.id, name=data.inspector.name),
            reviewer=Party(id=data.reviewer.id, name=data.reviewer.name),
            submitted_at=data.submitted_at,
            approved_at=data.approved_at,
            issued_by=Party(id=data.issued_by.id, name=data.issued_by.name),
            issuer=Issuer(
                name=data.issuer.name,
                address=data.issuer.address,
                contact=data.issuer.contact,
                identifier=data.issuer.identifier,
            ),
            public_token=data.public_token,
            verify_url=data.verify_url,
        )


# --- Canonical verification hash -------------------------------------------------
#
# Canonicalisation rules (v1), kept deliberately explicit:
#   * Only immutable, content-bearing fields are included. Mutable lifecycle
#     state (``status``) and derived display values (``verify_url``) are excluded
#     so the hash stays stable across revoke/supersede.
#   * ``ends`` are sorted by end label so ordering cannot change the hash.
#   * The structure is serialised as compact JSON with sorted keys and hashed
#     with SHA-256. The scheme version is prefixed so future changes are
#     detectable.

_HASH_SCHEME = "hms-cert-v1"


def canonical_payload(data: CertificateData) -> dict[str, object]:
    """Return the ordered, content-only structure the hash is computed over."""
    pt = data.pressure_test
    return {
        "scheme": _HASH_SCHEME,
        "certificate_number": data.certificate_number,
        "certificate_version": data.certificate_version,
        "issued_at": data.issued_at,
        "valid_until": data.valid_until,
        "public_token": data.public_token,
        "customer": {"code": data.customer_code, "name": data.customer_name},
        "asset": {
            "asset_number": data.asset_number,
            "tag": data.asset_tag,
            "serial_no": data.customer_serial_no,
            "manufacture_date": data.manufacture_date,
            "length_m": data.length_m,
        },
        "product": {
            "code": data.product_code,
            "name": data.product_name,
            "category": data.product_category,
            "standard_code": data.standard_code,
        },
        "ends": [
            {
                "end": e.end,
                "nominal_bore": e.nominal_bore,
                "material": e.material,
                "coupling": e.coupling,
                "coupling_add_on": e.coupling_add_on,
                "attach_method": e.attach_method,
            }
            for e in sorted(data.ends, key=lambda e: e.end)
        ],
        "pressure_test": (
            None
            if pt is None
            else {
                "working_pressure_kpa": pt.working_pressure_kpa,
                "test_pressure_kpa": pt.test_pressure_kpa,
                "applied_pressure_kpa": pt.applied_pressure_kpa,
                "hold_time_seconds": pt.hold_time_seconds,
                "passed": pt.passed,
                "medium": pt.medium,
            }
        ),
        "inspection": {
            "id": data.inspection_id,
            "type": data.inspection_type,
            "result": data.inspection_result,
            "approved_at": data.approved_at,
        },
        "issuer": {"name": data.issuer.name, "identifier": data.issuer.identifier},
    }


def compute_verification_hash(data: CertificateData) -> str:
    """SHA-256 hex digest of the canonical payload."""
    encoded = json.dumps(
        canonical_payload(data),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
