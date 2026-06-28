from hms_backend.app.tooling.migration import dry_run_import
from hms_backend.app.tooling.synthetic import (
    generate_clean_dataset,
    generate_dirty_legacy_dataset,
)


def test_dry_run_import_accepts_clean_customers() -> None:
    report = dry_run_import(generate_clean_dataset())

    assert report.total_customers == 3
    assert report.accepted_customers == 3
    assert report.rejected_customers == 0
    assert report.errors == []
    assert report.warnings == []
    assert report.normalised_customer_codes == ["LINFOX", "ORIC", "VOPA"]


def test_dry_run_import_reports_dirty_legacy_customer_issues() -> None:
    report = dry_run_import(generate_dirty_legacy_dataset())

    assert report.total_customers == 5
    assert report.accepted_customers == 2
    assert report.rejected_customers == 3
    assert report.normalised_customer_codes == ["ORIC", "VOPA"]
    assert "customers[1].code duplicates customers[0].code: VOPA" in report.errors
    assert "customers[2].name is required" in report.errors
    assert "customers[4].code is required" in report.errors
    assert "customers[0].code normalised from ' vopa ' to 'VOPA'" in report.warnings


def test_dry_run_import_report_serialises_to_dict() -> None:
    report = dry_run_import(generate_dirty_legacy_dataset())

    assert report.to_dict()["rejected_customers"] == 3
    assert report.to_dict()["errors"][0] == (
        "customers[1].code duplicates customers[0].code: VOPA"
    )
