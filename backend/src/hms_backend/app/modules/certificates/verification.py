"""Verification-hash algorithm — the backend mirror of the certificate engine's
``hms_certificate.domain.compute_verification_hash``.

This MUST stay byte-for-byte identical to the engine implementation so the public
verify endpoint recomputes the same digest an issued certificate was stamped
with. The pinned test vector in ``tests/test_certificate_verification.py`` guards
against drift (it matches the engine's ``KNOWN_VECTOR_HASH``).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

_HASH_SCHEME = "hms-cert-v1"


@dataclass(frozen=True)
class EndInput:
    end: str
    nominal_bore: str = ""
    material: str = ""
    coupling: str = ""
    coupling_add_on: str = ""
    attach_method: str = ""


@dataclass(frozen=True)
class PressureInput:
    working_pressure_kpa: int = 0
    test_pressure_kpa: int = 0
    applied_pressure_kpa: int = 0
    hold_time_seconds: int = 0
    passed: bool = False
    medium: str = ""


@dataclass(frozen=True)
class VerificationInput:
    """Content-bearing fields the hash is computed over."""

    certificate_number: str
    certificate_version: int
    issued_at: str
    valid_until: str = ""
    public_token: str = ""
    customer_code: str = ""
    customer_name: str = ""
    asset_number: str = ""
    asset_tag: str = ""
    customer_serial_no: str = ""
    manufacture_date: str = ""
    length_m: str = ""
    product_code: str = ""
    product_name: str = ""
    product_category: str = ""
    standard_code: str = ""
    ends: tuple[EndInput, ...] = ()
    pressure_test: PressureInput | None = None
    inspection_id: str = ""
    inspection_type: str = ""
    inspection_result: str = ""
    approved_at: str = ""
    issuer_name: str = ""
    issuer_identifier: str = ""


def canonical_payload(data: VerificationInput) -> dict[str, object]:
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
        "issuer": {"name": data.issuer_name, "identifier": data.issuer_identifier},
    }


def compute_verification_hash(data: VerificationInput) -> str:
    encoded = json.dumps(
        canonical_payload(data),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
