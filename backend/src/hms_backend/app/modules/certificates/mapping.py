"""Map ORM inspection/asset data into the certificate engine proto and the
verification-hash input.

A single :class:`CertificateFacts` intermediate is produced first, then rendered
into *both* the gRPC request and the ``VerificationInput``. Because both consume
the identical formatted values, the hash the engine stamps and the hash the
public verify endpoint recomputes are guaranteed to agree — as long as every
timestamp/date passes through :func:`format_ts` / :func:`format_date`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal

from hms_backend.app.modules.certificates.enginepb import certificate_pb2 as pb
from hms_backend.app.modules.certificates.verification import (
    EndInput,
    PressureInput,
    VerificationInput,
)
from hms_backend.app.modules.inspections.models import Inspection


def format_ts(value: datetime | None) -> str:
    """Canonical second-resolution UTC timestamp: ``YYYY-MM-DDTHH:MM:SSZ``.

    Naive datetimes (e.g. read back from SQLite) are treated as UTC so the string
    is stable across a persistence round-trip.
    """
    if value is None:
        return ""
    if value.tzinfo is None:
        aware = value.replace(tzinfo=UTC)
    else:
        aware = value.astimezone(UTC)
    return aware.replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def format_date(value: date | None) -> str:
    return value.isoformat() if value is not None else ""


def format_decimal(value: Decimal | None) -> str:
    return format(value, "f") if value is not None else ""


@dataclass(frozen=True)
class EndFacts:
    end: str
    nominal_bore: str = ""
    material: str = ""
    coupling: str = ""
    coupling_add_on: str = ""
    attach_method: str = ""


@dataclass(frozen=True)
class PressureFacts:
    working_pressure_kpa: int = 0
    test_pressure_kpa: int = 0
    applied_pressure_kpa: int = 0
    hold_time_seconds: int = 0
    passed: bool = False
    medium: str = ""


@dataclass(frozen=True)
class CertificateFacts:
    certificate_number: str
    certificate_version: int
    status: str
    issued_at: str
    valid_until: str
    public_token: str
    verify_url: str
    customer_code: str
    customer_name: str
    site_name: str
    site_location: str
    asset_number: str
    asset_tag: str
    customer_serial_no: str
    manufacture_date: str
    length_m: str
    lifecycle_status: str
    product_code: str
    product_name: str
    product_category: str
    standard_code: str
    standard_name: str
    inspection_id: str
    inspection_type: str
    inspection_result: str
    inspector_id: str
    inspector_name: str
    reviewer_id: str
    reviewer_name: str
    submitted_at: str
    approved_at: str
    issued_by_id: str
    issued_by_name: str
    issuer_name: str
    issuer_identifier: str
    ends: tuple[EndFacts, ...] = ()
    pressure: PressureFacts | None = None


def _lookup_name(obj: object | None, *attrs: str) -> str:
    if obj is None:
        return ""
    for attr in attrs:
        value = getattr(obj, attr, None)
        if value:
            return str(value)
    return ""


def build_facts(
    inspection: Inspection,
    *,
    certificate_number: str,
    certificate_version: int,
    status: str,
    issued_at: datetime,
    valid_until: date | None,
    public_token: str,
    verify_url: str,
    issued_by_name: str,
    issuer_name: str,
    issuer_identifier: str,
) -> CertificateFacts:
    asset = inspection.asset
    customer = asset.customer
    product = asset.product
    location = asset.location
    standard = getattr(product, "standard", None)
    pt = inspection.pressure_test

    ends: list[EndFacts] = []
    for end in sorted(getattr(asset, "ends", []) or [], key=lambda e: e.end):
        ends.append(
            EndFacts(
                end=end.end,
                nominal_bore=_lookup_name(
                    getattr(end, "nominal_bore", None), "label", "code"
                ),
                material=_lookup_name(getattr(end, "material", None), "name", "code"),
                coupling=_lookup_name(getattr(end, "coupling", None), "name", "code"),
                coupling_add_on=_lookup_name(
                    getattr(end, "coupling_add_on", None), "name", "code"
                ),
                attach_method=_lookup_name(
                    getattr(end, "attach_method", None), "name", "code"
                ),
            )
        )

    location_bits = [
        getattr(location, "city", None),
        getattr(location, "state", None),
        getattr(location, "country", None),
    ]
    site_location = ", ".join(bit for bit in location_bits if bit)

    return CertificateFacts(
        certificate_number=certificate_number,
        certificate_version=certificate_version,
        status=status,
        issued_at=format_ts(issued_at),
        valid_until=format_date(valid_until),
        public_token=public_token,
        verify_url=verify_url,
        customer_code=customer.code,
        customer_name=customer.name,
        site_name=getattr(location, "name", "") or "",
        site_location=site_location,
        asset_number=asset.asset_number,
        asset_tag=asset.tag or "",
        customer_serial_no=asset.customer_serial_no or "",
        manufacture_date=format_date(asset.manufacture_date),
        length_m=format_decimal(asset.length_m),
        lifecycle_status=asset.lifecycle_status,
        product_code=product.code,
        product_name=product.name,
        product_category=product.category,
        standard_code=_lookup_name(standard, "code"),
        standard_name=_lookup_name(standard, "name"),
        inspection_id=inspection.id,
        inspection_type=inspection.inspection_type,
        inspection_result=inspection.result or "",
        inspector_id=inspection.inspector_user_id or "",
        inspector_name=inspection.inspector_user_id or "",
        reviewer_id=inspection.reviewer_user_id or "",
        reviewer_name=inspection.reviewer_user_id or "",
        submitted_at=format_ts(inspection.submitted_at),
        approved_at=format_ts(inspection.approved_at),
        issued_by_id=issued_by_name,
        issued_by_name=issued_by_name,
        issuer_name=issuer_name,
        issuer_identifier=issuer_identifier,
        ends=tuple(ends),
        pressure=(
            None
            if pt is None
            else PressureFacts(
                working_pressure_kpa=getattr(pt, "working_pressure_kpa", 0) or 0,
                test_pressure_kpa=getattr(pt, "test_pressure_kpa", 0) or 0,
                applied_pressure_kpa=pt.applied_pressure_kpa,
                hold_time_seconds=pt.hold_time_seconds,
                passed=pt.passed,
                medium=getattr(pt, "medium", "") or "",
            )
        ),
    )


def to_proto(facts: CertificateFacts) -> pb.CertificateData:
    msg = pb.CertificateData(
        certificate_number=facts.certificate_number,
        certificate_version=facts.certificate_version,
        status=facts.status,
        issued_at=facts.issued_at,
        valid_until=facts.valid_until,
        customer_code=facts.customer_code,
        customer_name=facts.customer_name,
        site_name=facts.site_name,
        site_location=facts.site_location,
        asset_number=facts.asset_number,
        asset_tag=facts.asset_tag,
        customer_serial_no=facts.customer_serial_no,
        manufacture_date=facts.manufacture_date,
        length_m=facts.length_m,
        lifecycle_status=facts.lifecycle_status,
        product_code=facts.product_code,
        product_name=facts.product_name,
        product_category=facts.product_category,
        standard_code=facts.standard_code,
        standard_name=facts.standard_name,
        inspection_id=facts.inspection_id,
        inspection_type=facts.inspection_type,
        inspection_result=facts.inspection_result,
        submitted_at=facts.submitted_at,
        approved_at=facts.approved_at,
        public_token=facts.public_token,
        verify_url=facts.verify_url,
    )
    msg.inspector.id = facts.inspector_id
    msg.inspector.name = facts.inspector_name
    msg.reviewer.id = facts.reviewer_id
    msg.reviewer.name = facts.reviewer_name
    msg.issued_by.id = facts.issued_by_id
    msg.issued_by.name = facts.issued_by_name
    msg.issuer.name = facts.issuer_name
    msg.issuer.identifier = facts.issuer_identifier
    for end in facts.ends:
        msg.ends.add(
            end=end.end,
            nominal_bore=end.nominal_bore,
            material=end.material,
            coupling=end.coupling,
            coupling_add_on=end.coupling_add_on,
            attach_method=end.attach_method,
        )
    if facts.pressure is not None:
        p = facts.pressure
        msg.pressure_test.working_pressure_kpa = p.working_pressure_kpa
        msg.pressure_test.test_pressure_kpa = p.test_pressure_kpa
        msg.pressure_test.applied_pressure_kpa = p.applied_pressure_kpa
        msg.pressure_test.hold_time_seconds = p.hold_time_seconds
        msg.pressure_test.passed = p.passed
        msg.pressure_test.medium = p.medium
    return msg


def to_verification_input(facts: CertificateFacts) -> VerificationInput:
    return VerificationInput(
        certificate_number=facts.certificate_number,
        certificate_version=facts.certificate_version,
        issued_at=facts.issued_at,
        valid_until=facts.valid_until,
        public_token=facts.public_token,
        customer_code=facts.customer_code,
        customer_name=facts.customer_name,
        asset_number=facts.asset_number,
        asset_tag=facts.asset_tag,
        customer_serial_no=facts.customer_serial_no,
        manufacture_date=facts.manufacture_date,
        length_m=facts.length_m,
        product_code=facts.product_code,
        product_name=facts.product_name,
        product_category=facts.product_category,
        standard_code=facts.standard_code,
        ends=tuple(
            EndInput(
                end=e.end,
                nominal_bore=e.nominal_bore,
                material=e.material,
                coupling=e.coupling,
                coupling_add_on=e.coupling_add_on,
                attach_method=e.attach_method,
            )
            for e in facts.ends
        ),
        pressure_test=(
            None
            if facts.pressure is None
            else PressureInput(
                working_pressure_kpa=facts.pressure.working_pressure_kpa,
                test_pressure_kpa=facts.pressure.test_pressure_kpa,
                applied_pressure_kpa=facts.pressure.applied_pressure_kpa,
                hold_time_seconds=facts.pressure.hold_time_seconds,
                passed=facts.pressure.passed,
                medium=facts.pressure.medium,
            )
        ),
        inspection_id=facts.inspection_id,
        inspection_type=facts.inspection_type,
        inspection_result=facts.inspection_result,
        approved_at=facts.approved_at,
        issuer_name=facts.issuer_name,
        issuer_identifier=facts.issuer_identifier,
    )
