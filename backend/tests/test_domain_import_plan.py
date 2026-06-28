from datetime import date

import pytest

from hms_backend.app.tooling.migration import (
    DomainImportPlanError,
    build_domain_import_plan,
)
from hms_backend.app.tooling.synthetic import generate_clean_dataset


def test_clean_fixture_maps_to_domain_import_plan() -> None:
    plan = build_domain_import_plan(
        generate_clean_dataset(),
        today=date(2026, 6, 28),
    )

    assert plan.table_counts == {
        "customers": 3,
        "customer_locations": 3,
        "customer_contacts": 3,
        "products": 2,
        "assets": 2,
        "retest_schedules": 2,
    }
    assert [customer.code for customer in plan.customers] == ["VOPA", "ORIC", "LINFOX"]
    assert plan.products[0].code == "1000GY"
    assert plan.products[0].standard_code == "AS2683"
    assert plan.assets[0].asset_number == "997950"
    assert plan.assets[0].customer_code == "VOPA"
    assert plan.assets[0].product_code == "1000GY"
    assert plan.assets[0].lifecycle_status == "OVERDUE"
    assert plan.assets[0].next_retest_due_at == date(2023, 11, 2)
    assert plan.assets[1].lifecycle_status == "CONDEMNED"
    assert plan.assets[1].condemned_at == date(2019, 7, 8)
    assert plan.retest_schedules[0].status == "OVERDUE"
    assert plan.to_dict()["assets"][0]["next_retest_due_at"] == "2023-11-02"


def test_import_plan_rejects_assets_with_unknown_customer_reference() -> None:
    dataset = generate_clean_dataset()
    dataset["assets"][0]["customer_code"] = "UNKNOWN"

    with pytest.raises(DomainImportPlanError, match="assets\\[0\\].customer_code"):
        build_domain_import_plan(dataset, today=date(2026, 6, 28))
