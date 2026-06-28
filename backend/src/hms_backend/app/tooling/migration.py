from __future__ import annotations

from dataclasses import dataclass
from typing import TypedDict

from hms_backend.app.tooling.types import CustomerFixture, SyntheticDataset


class ImportReportDict(TypedDict):
    total_customers: int
    accepted_customers: int
    rejected_customers: int
    normalised_customer_codes: list[str]
    warnings: list[str]
    errors: list[str]


@dataclass(frozen=True)
class ImportReport:
    total_customers: int
    accepted_customers: int
    rejected_customers: int
    normalised_customer_codes: list[str]
    warnings: list[str]
    errors: list[str]

    def to_dict(self) -> ImportReportDict:
        return {
            "total_customers": self.total_customers,
            "accepted_customers": self.accepted_customers,
            "rejected_customers": self.rejected_customers,
            "normalised_customer_codes": self.normalised_customer_codes,
            "warnings": self.warnings,
            "errors": self.errors,
        }


def _normalise_code(value: str | None) -> str:
    return (value or "").strip().upper()


def _normalise_name(value: str | None) -> str:
    return (value or "").strip()


def _validate_customer(
    index: int,
    customer: CustomerFixture,
    seen_codes: dict[str, int],
) -> tuple[str | None, list[str], list[str]]:
    warnings: list[str] = []
    errors: list[str] = []
    raw_code = customer.get("code", "")
    raw_name = customer.get("name", "")
    code = _normalise_code(raw_code)
    name = _normalise_name(raw_name)

    if code and code != raw_code:
        warnings.append(
            f"customers[{index}].code normalised from {raw_code!r} to {code!r}"
        )
    if not code:
        errors.append(f"customers[{index}].code is required")
    if not name:
        errors.append(f"customers[{index}].name is required")
    if code and code in seen_codes:
        errors.append(
            f"customers[{index}].code duplicates customers[{seen_codes[code]}].code: "
            f"{code}"
        )

    if errors:
        return None, warnings, errors

    seen_codes[code] = index
    return code, warnings, errors


def dry_run_import(dataset: SyntheticDataset) -> ImportReport:
    warnings: list[str] = []
    errors: list[str] = []
    accepted_codes: list[str] = []
    seen_codes: dict[str, int] = {}

    for index, customer in enumerate(dataset["customers"]):
        code, customer_warnings, customer_errors = _validate_customer(
            index,
            customer,
            seen_codes,
        )
        warnings.extend(customer_warnings)
        errors.extend(customer_errors)
        if code is not None:
            accepted_codes.append(code)

    total_customers = len(dataset["customers"])
    accepted_customers = len(accepted_codes)

    return ImportReport(
        total_customers=total_customers,
        accepted_customers=accepted_customers,
        rejected_customers=total_customers - accepted_customers,
        normalised_customer_codes=sorted(accepted_codes),
        warnings=warnings,
        errors=errors,
    )
