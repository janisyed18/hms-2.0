from __future__ import annotations

from dataclasses import dataclass, fields
from datetime import date
from typing import TypedDict, cast

from hms_backend.app.modules.assets.models import AssetLifecycleStatus
from hms_backend.app.modules.scheduling.models import RetestScheduleStatus
from hms_backend.app.tooling.types import (
    AssetFixture,
    CustomerFixture,
    ProductFixture,
    SyntheticDataset,
)


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


class DomainImportPlanError(ValueError):
    pass


@dataclass(frozen=True)
class CustomerImportRow:
    legacy_id: str | None
    code: str
    name: str
    retest_enabled: bool
    default_retest_months: int | None


@dataclass(frozen=True)
class CustomerLocationImportRow:
    customer_code: str
    name: str
    address_1: str | None
    address_2: str | None
    city: str | None
    state: str | None
    country: str | None


@dataclass(frozen=True)
class CustomerContactImportRow:
    customer_code: str
    name: str
    email: str | None
    receives_retest_reminders: bool


@dataclass(frozen=True)
class ProductImportRow:
    legacy_id: str | None
    category: str
    sub_category: str | None
    code: str
    name: str
    standard_code: str | None
    enabled: bool


@dataclass(frozen=True)
class AssetImportRow:
    legacy_id: str | None
    customer_code: str
    product_code: str
    asset_number: str
    customer_serial_no: str | None
    tag: str
    location_name: str | None
    lifecycle_status: str
    manufacture_date: date | None
    next_retest_due_at: date | None
    condemned_at: date | None
    length_m: str | None
    nominal_bore_code: str | None


@dataclass(frozen=True)
class RetestScheduleImportRow:
    customer_code: str
    asset_number: str
    due_at: date
    status: str
    reminder_interval_days: int
    escalation_interval_days: int


type RowScalar = str | int | bool | None
type RowDict = dict[str, RowScalar]
type DomainImportRow = (
    CustomerImportRow
    | CustomerLocationImportRow
    | CustomerContactImportRow
    | ProductImportRow
    | AssetImportRow
    | RetestScheduleImportRow
)


class DomainImportPlanDict(TypedDict):
    table_counts: dict[str, int]
    customers: list[RowDict]
    customer_locations: list[RowDict]
    customer_contacts: list[RowDict]
    products: list[RowDict]
    assets: list[RowDict]
    retest_schedules: list[RowDict]


@dataclass(frozen=True)
class DomainImportPlan:
    customers: list[CustomerImportRow]
    customer_locations: list[CustomerLocationImportRow]
    customer_contacts: list[CustomerContactImportRow]
    products: list[ProductImportRow]
    assets: list[AssetImportRow]
    retest_schedules: list[RetestScheduleImportRow]

    @property
    def table_counts(self) -> dict[str, int]:
        return {
            "customers": len(self.customers),
            "customer_locations": len(self.customer_locations),
            "customer_contacts": len(self.customer_contacts),
            "products": len(self.products),
            "assets": len(self.assets),
            "retest_schedules": len(self.retest_schedules),
        }

    def to_dict(self) -> DomainImportPlanDict:
        return {
            "table_counts": self.table_counts,
            "customers": [_row_to_dict(customer) for customer in self.customers],
            "customer_locations": [
                _row_to_dict(location) for location in self.customer_locations
            ],
            "customer_contacts": [
                _row_to_dict(contact) for contact in self.customer_contacts
            ],
            "products": [_row_to_dict(product) for product in self.products],
            "assets": [_row_to_dict(asset) for asset in self.assets],
            "retest_schedules": [
                _row_to_dict(schedule) for schedule in self.retest_schedules
            ],
        }


def _normalise_code(value: str | None) -> str:
    return (value or "").strip().upper()


def _normalise_name(value: str | None) -> str:
    return (value or "").strip()


def _row_to_dict(row: DomainImportRow) -> RowDict:
    values: RowDict = {}
    for field in fields(row):
        value = cast(object, getattr(row, field.name))
        if isinstance(value, date):
            values[field.name] = value.isoformat()
        elif isinstance(value, str | int | bool) or value is None:
            values[field.name] = value
        else:
            raise TypeError(f"Unsupported import row value: {field.name}")
    return values


def _parse_date(value: str | None, path: str) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise DomainImportPlanError(f"{path} must be an ISO date") from exc


def _add_months(value: date, months: int) -> date:
    target_month = value.month - 1 + months
    year = value.year + target_month // 12
    month = target_month % 12 + 1
    month_lengths = {
        1: 31,
        2: 29 if _is_leap_year(year) else 28,
        3: 31,
        4: 30,
        5: 31,
        6: 30,
        7: 31,
        8: 31,
        9: 30,
        10: 31,
        11: 30,
        12: 31,
    }
    return date(year, month, min(value.day, month_lengths[month]))


def _is_leap_year(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


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


def _customer_to_import_row(customer: CustomerFixture, index: int) -> CustomerImportRow:
    code = _normalise_code(customer.get("code"))
    name = _normalise_name(customer.get("name"))
    if not code:
        raise DomainImportPlanError(f"customers[{index}].code is required")
    if not name:
        raise DomainImportPlanError(f"customers[{index}].name is required")

    retest_enabled = bool(customer.get("hms_retest", False))
    retest_month = customer.get("retest_month")

    return CustomerImportRow(
        legacy_id=customer.get("legacy_id"),
        code=code,
        name=name,
        retest_enabled=retest_enabled,
        default_retest_months=retest_month if retest_enabled else None,
    )


def _customer_location_to_import_row(
    customer: CustomerFixture,
    row: CustomerImportRow,
) -> CustomerLocationImportRow:
    city = _normalise_name(customer.get("city")) or None
    return CustomerLocationImportRow(
        customer_code=row.code,
        name=city or row.code,
        address_1=_normalise_name(customer.get("address_1")) or None,
        address_2=_normalise_name(customer.get("address_2")) or None,
        city=city,
        state=_normalise_name(customer.get("state")) or None,
        country=_normalise_name(customer.get("country")) or None,
    )


def _customer_contact_to_import_row(
    customer: CustomerFixture,
    row: CustomerImportRow,
) -> CustomerContactImportRow:
    return CustomerContactImportRow(
        customer_code=row.code,
        name=f"{row.name} Retest Contact",
        email=_normalise_name(customer.get("email")) or None,
        receives_retest_reminders=row.retest_enabled,
    )


def _product_to_import_row(product: ProductFixture, index: int) -> ProductImportRow:
    code = _normalise_code(product.get("code"))
    name = _normalise_name(product.get("name"))
    category = _normalise_name(product.get("category"))
    if not code:
        raise DomainImportPlanError(f"products[{index}].code is required")
    if not name:
        raise DomainImportPlanError(f"products[{index}].name is required")
    if not category:
        raise DomainImportPlanError(f"products[{index}].category is required")

    return ProductImportRow(
        legacy_id=product.get("legacy_id"),
        category=category,
        sub_category=_normalise_name(product.get("sub_category")) or None,
        code=code,
        name=name,
        standard_code=_normalise_code(product.get("standard")) or None,
        enabled=True,
    )


def _asset_to_import_row(
    asset: AssetFixture,
    index: int,
    customers_by_code: dict[str, CustomerImportRow],
    products_by_code: dict[str, ProductImportRow],
    *,
    today: date,
) -> tuple[AssetImportRow, RetestScheduleImportRow | None]:
    customer_code = _normalise_code(asset.get("customer_code"))
    product_code = _normalise_code(asset.get("product_code"))
    asset_number = _normalise_name(asset.get("asset_id"))

    if customer_code not in customers_by_code:
        raise DomainImportPlanError(
            f"assets[{index}].customer_code references unknown customer: "
            f"{customer_code or '<blank>'}"
        )
    if product_code not in products_by_code:
        raise DomainImportPlanError(
            f"assets[{index}].product_code references unknown product: "
            f"{product_code or '<blank>'}"
        )
    if not asset_number:
        raise DomainImportPlanError(f"assets[{index}].asset_id is required")

    manufacture_date = _parse_date(
        asset.get("manufacture_date"),
        f"assets[{index}].manufacture_date",
    )
    grave_date = _parse_date(asset.get("grave_date"), f"assets[{index}].grave_date")
    customer = customers_by_code[customer_code]
    next_retest_due_at = (
        _add_months(manufacture_date, customer.default_retest_months)
        if manufacture_date is not None and customer.default_retest_months is not None
        else None
    )
    lifecycle_status = _asset_lifecycle_status(
        grave_date=grave_date,
        next_retest_due_at=next_retest_due_at,
        today=today,
    )
    condemned_at = (
        grave_date
        if lifecycle_status == AssetLifecycleStatus.CONDEMNED.value
        else None
    )

    asset_row = AssetImportRow(
        legacy_id=asset.get("legacy_id"),
        customer_code=customer_code,
        product_code=product_code,
        asset_number=asset_number,
        customer_serial_no=_normalise_name(asset.get("customer_serial_no")) or None,
        tag=f"HMS-{asset_number}",
        location_name=_normalise_name(asset.get("location")) or None,
        lifecycle_status=lifecycle_status,
        manufacture_date=manufacture_date,
        next_retest_due_at=next_retest_due_at,
        condemned_at=condemned_at,
        length_m=_normalise_name(asset.get("length_m")) or None,
        nominal_bore_code=_normalise_code(asset.get("nominal_bore")) or None,
    )

    schedule_row = _retest_schedule_for_asset(
        asset_row,
        due_at=next_retest_due_at,
        today=today,
    )
    return asset_row, schedule_row


def _asset_lifecycle_status(
    *,
    grave_date: date | None,
    next_retest_due_at: date | None,
    today: date,
) -> str:
    if grave_date is not None and grave_date <= today:
        return AssetLifecycleStatus.CONDEMNED.value
    if next_retest_due_at is None:
        return AssetLifecycleStatus.IN_SERVICE.value
    if next_retest_due_at < today:
        return AssetLifecycleStatus.OVERDUE.value
    if next_retest_due_at == today:
        return AssetLifecycleStatus.DUE.value
    return AssetLifecycleStatus.IN_SERVICE.value


def _retest_schedule_for_asset(
    asset: AssetImportRow,
    *,
    due_at: date | None,
    today: date,
) -> RetestScheduleImportRow | None:
    if due_at is None:
        return None
    if asset.lifecycle_status == AssetLifecycleStatus.CONDEMNED.value:
        status = RetestScheduleStatus.SUSPENDED.value
    elif due_at < today:
        status = RetestScheduleStatus.OVERDUE.value
    elif due_at == today:
        status = RetestScheduleStatus.DUE.value
    else:
        status = RetestScheduleStatus.UPCOMING.value

    return RetestScheduleImportRow(
        customer_code=asset.customer_code,
        asset_number=asset.asset_number,
        due_at=due_at,
        status=status,
        reminder_interval_days=30,
        escalation_interval_days=7,
    )


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


def build_domain_import_plan(
    dataset: SyntheticDataset,
    *,
    today: date | None = None,
) -> DomainImportPlan:
    effective_today = today or date.today()
    customers = [
        _customer_to_import_row(customer, index)
        for index, customer in enumerate(dataset["customers"])
    ]
    customer_codes = [customer.code for customer in customers]
    duplicate_customer_codes = {
        code for code in customer_codes if customer_codes.count(code) > 1
    }
    if duplicate_customer_codes:
        raise DomainImportPlanError(
            "duplicate customer codes: " + ", ".join(sorted(duplicate_customer_codes))
        )

    customer_locations = [
        _customer_location_to_import_row(customer, row)
        for customer, row in zip(dataset["customers"], customers, strict=True)
    ]
    customer_contacts = [
        _customer_contact_to_import_row(customer, row)
        for customer, row in zip(dataset["customers"], customers, strict=True)
    ]
    products = [
        _product_to_import_row(product, index)
        for index, product in enumerate(dataset["products"])
    ]
    customers_by_code = {customer.code: customer for customer in customers}
    products_by_code = {product.code: product for product in products}

    assets: list[AssetImportRow] = []
    retest_schedules: list[RetestScheduleImportRow] = []
    for index, asset in enumerate(dataset["assets"]):
        asset_row, schedule_row = _asset_to_import_row(
            asset,
            index,
            customers_by_code,
            products_by_code,
            today=effective_today,
        )
        assets.append(asset_row)
        if schedule_row is not None:
            retest_schedules.append(schedule_row)

    return DomainImportPlan(
        customers=customers,
        customer_locations=customer_locations,
        customer_contacts=customer_contacts,
        products=products,
        assets=assets,
        retest_schedules=retest_schedules,
    )
