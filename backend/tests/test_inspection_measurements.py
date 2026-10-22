"""The structured inspection measurements stored on a pressure test.

The customer's inspection form needs working and test pressure, a selectable test
duration, three resistance readings, seven pass/fail condition checks, a certificate
result and notes. They live in ``PressureTestResult.measurements`` under a versioned,
validated schema, so the staff app, the offline inspector app and sync all store and
read the same shape without a database migration.
"""

from __future__ import annotations

from typing import Any

import pytest

from hms_backend.app.modules.inspections.measurements import (
    CONDITION_KEYS,
    INSPECTION_RESULTS,
    MeasurementsError,
    missing_for_submission,
    normalize_measurements,
    validate_inspection_result,
)


def _complete() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "working_pressure_kpa": 1500,
        "rated_working_pressure_kpa": 1500,
        "rated_test_pressure_kpa": 2250,
        "test_duration_minutes": 5,
        "ohms_end_a": 0.1,
        "ohms_end_b": 0.2,
        "ohms_total": 0.3,
        "conditions": {key: "PASS" for key in CONDITION_KEYS},
        "certificate_result": "PASS",
        "notes": "No leaks.",
    }


def test_the_seven_conditions_from_the_customer_form_are_present() -> None:
    assert len(CONDITION_KEYS) == 7
    assert len(set(CONDITION_KEYS)) == 7


def test_a_complete_record_round_trips_unchanged() -> None:
    assert normalize_measurements(_complete()) == _complete()


def test_legacy_free_form_measurements_are_left_exactly_as_stored() -> None:
    assert normalize_measurements({"leak": "none"}) == {"leak": "none"}
    assert normalize_measurements({"note": "all good"}) == {"note": "all good"}
    assert normalize_measurements(None) is None
    assert normalize_measurements({}) == {}


def test_the_old_required_pressure_key_becomes_the_working_pressure() -> None:
    legacy = {"required_pressure_kpa": 1500}
    assert normalize_measurements(legacy) == {"working_pressure_kpa": 1500}
    # An explicit working pressure wins and the alias is dropped.
    mixed = {"required_pressure_kpa": 1000, "working_pressure_kpa": 1500}
    assert normalize_measurements(mixed) == {"working_pressure_kpa": 1500}


@pytest.mark.parametrize("minutes", [1, 5, 10])
def test_only_the_three_offered_durations_are_accepted(minutes: int) -> None:
    out = normalize_measurements(
        {"schema_version": 1, "test_duration_minutes": minutes}
    )
    assert out is not None and out["test_duration_minutes"] == minutes


@pytest.mark.parametrize("minutes", [0, 2, 3, 15, -1, "5", 5.5, True])
def test_other_durations_are_rejected(minutes: object) -> None:
    with pytest.raises(MeasurementsError):
        normalize_measurements({"schema_version": 1, "test_duration_minutes": minutes})


@pytest.mark.parametrize("field", ["ohms_end_a", "ohms_end_b", "ohms_total"])
def test_resistance_readings_are_non_negative_finite_numbers(field: str) -> None:
    assert normalize_measurements({"schema_version": 1, field: 0})[field] == 0  # type: ignore[index]
    assert normalize_measurements({"schema_version": 1, field: 12.5})[field] == 12.5  # type: ignore[index]
    for bad in (-0.1, "0.1", float("inf"), float("nan"), True, 1_000_001):
        with pytest.raises(MeasurementsError):
            normalize_measurements({"schema_version": 1, field: bad})


@pytest.mark.parametrize(
    "field", ["working_pressure_kpa", "rated_working_pressure_kpa"]
)
def test_pressures_are_positive_whole_kilopascals(field: str) -> None:
    assert normalize_measurements({"schema_version": 1, field: 1500})[field] == 1500  # type: ignore[index]
    for bad in (0, -5, 15.5, "1500", True, 10_000_001):
        with pytest.raises(MeasurementsError):
            normalize_measurements({"schema_version": 1, field: bad})


def test_a_missing_rating_is_recorded_as_null_not_zero() -> None:
    out = normalize_measurements(
        {
            "schema_version": 1,
            "rated_working_pressure_kpa": None,
            "rated_test_pressure_kpa": None,
        }
    )
    assert out == {
        "schema_version": 1,
        "rated_working_pressure_kpa": None,
        "rated_test_pressure_kpa": None,
    }


def test_conditions_must_be_known_and_pass_or_fail() -> None:
    ok = normalize_measurements(
        {"schema_version": 1, "conditions": {"kink_or_dent": "FAIL"}}
    )
    assert ok == {"schema_version": 1, "conditions": {"kink_or_dent": "FAIL"}}
    with pytest.raises(MeasurementsError):
        normalize_measurements(
            {"schema_version": 1, "conditions": {"made_up_check": "PASS"}}
        )
    for bad in ("pass", "OK", "", None, True):
        with pytest.raises(MeasurementsError):
            normalize_measurements(
                {"schema_version": 1, "conditions": {"kink_or_dent": bad}}
            )
    with pytest.raises(MeasurementsError):
        normalize_measurements({"schema_version": 1, "conditions": ["kink_or_dent"]})


def test_certificate_result_is_pass_or_fail_and_distinct_from_the_instruction() -> None:
    assert normalize_measurements({"schema_version": 1, "certificate_result": "FAIL"})
    with pytest.raises(MeasurementsError):
        normalize_measurements({"schema_version": 1, "certificate_result": "REPAIR"})


def test_notes_are_bounded_text() -> None:
    assert normalize_measurements({"schema_version": 1, "notes": "x" * 2000})
    with pytest.raises(MeasurementsError):
        normalize_measurements({"schema_version": 1, "notes": "x" * 2001})
    with pytest.raises(MeasurementsError):
        normalize_measurements({"schema_version": 1, "notes": 5})


def test_an_unsupported_schema_version_is_rejected() -> None:
    with pytest.raises(MeasurementsError):
        normalize_measurements({"schema_version": 2})


def test_the_instruction_values_are_pass_and_repair_with_legacy_values_kept() -> None:
    assert {"PASS", "REPAIR"} <= INSPECTION_RESULTS
    assert {"FAIL", "REVIEW"} <= INSPECTION_RESULTS  # records already stored
    assert validate_inspection_result(None) is None
    assert validate_inspection_result("REPAIR") == "REPAIR"
    for bad in ("pass", "MAYBE"):
        with pytest.raises(MeasurementsError):
            validate_inspection_result(bad)


def test_submission_needs_every_field_of_a_current_record() -> None:
    assert missing_for_submission(_complete(), "PASS", hold_time_seconds=300) == []
    assert missing_for_submission(_complete(), "REPAIR", hold_time_seconds=300) == []

    incomplete = _complete()
    incomplete.pop("ohms_total")
    incomplete["conditions"].pop("kink_or_dent")
    incomplete.pop("certificate_result")
    missing = missing_for_submission(incomplete, "PASS", hold_time_seconds=300)
    assert "Ohms total" in missing
    assert "Evidence of kink or dent damage" in " ".join(missing)
    assert "Certificate result" in missing


def test_submission_needs_an_instruction_of_pass_or_repair() -> None:
    assert "Instruction" in missing_for_submission(
        _complete(), None, hold_time_seconds=300
    )
    assert "Instruction" in missing_for_submission(
        _complete(), "REVIEW", hold_time_seconds=300
    )


def test_the_test_duration_must_match_the_recorded_hold_time() -> None:
    assert missing_for_submission(_complete(), "PASS", hold_time_seconds=600) == [
        "Test time does not match the recorded hold time"
    ]


def test_legacy_records_have_no_extra_submission_requirements() -> None:
    assert missing_for_submission({"leak": "none"}, "PASS", hold_time_seconds=300) == []
    assert missing_for_submission(None, None, hold_time_seconds=300) == []


def test_the_staff_and_inspector_apps_use_the_same_condition_checks_as_the_api() -> (
    None
):
    """The apps keep their own copy of the form definition; this keeps them in step."""
    import re
    from pathlib import Path

    from hms_backend.app.modules.inspections.measurements import (
        CONDITION_LABELS,
        TEST_DURATION_MINUTES,
    )

    apps = Path(__file__).resolve().parents[2] / "web" / "apps"
    for app in ("staff", "inspector"):
        source = (apps / app / "src" / "domain" / "inspectionForm.ts").read_text()
        block = source[source.index("export const CONDITION_CHECKS") :]
        block = block[: block.index("] as const;")]
        found = dict(
            re.findall(r'key:\s*"([a-z_]+)",\s*label:\s*"([^"]+)"', block, re.DOTALL)
        )
        assert list(found) == list(CONDITION_LABELS), app
        # The apps ask the question; the API names the finding. Same words, bar the "?".
        assert {key: label.rstrip("?") for key, label in found.items()} == (
            CONDITION_LABELS
        ), app
        durations = re.search(r"TEST_DURATION_MINUTES = \[([\d, ]+)\]", source)
        assert durations is not None, app
        assert tuple(int(n) for n in durations.group(1).split(",")) == (
            TEST_DURATION_MINUTES
        ), app
