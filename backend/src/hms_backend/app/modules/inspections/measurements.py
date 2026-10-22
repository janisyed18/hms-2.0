"""The structured measurements stored with an inspection's pressure test.

The customer's inspection form needs more than a pass/fail and a pressure. They are kept
in ``PressureTestResult.measurements`` (an existing JSON column, so no migration) under
this versioned schema. Every write path (the staff API, the sync push from the offline
inspector app) normalises through :func:`normalize_measurements`, so all of them store
and return the same shape.

Version 1 (``schema_version: 1``):

``working_pressure_kpa``
    The working pressure used for the test, in kPa. It defaults to the product's rating
    for the asset's nominal bore and may be overridden.
``rated_working_pressure_kpa`` / ``rated_test_pressure_kpa``
    The product rating the defaults came from (``null`` when the product has no rating
    for that bore). Keeping them beside the used value makes an override visible: the
    used value differs from the rating.
``test_duration_minutes``
    1, 5 or 10. ``PressureTestResult.hold_time_seconds`` is this times 60.
``ohms_end_a`` / ``ohms_end_b`` / ``ohms_total``
    Resistance readings as entered.
``conditions``
    Pass or fail for each physical-condition check in :data:`CONDITION_LABELS`.
    ``PASS`` means no defect was found.
``certificate_result``
    ``PASS`` or ``FAIL``: the outcome printed on the certificate. It is separate from
    both the pressure test's own ``passed`` flag and the inspection's instruction.
``notes``
    Free-text inspection notes.

The instruction (Pass or Repair) is the inspection's ``result`` column, not part of
this document. Records written before this schema (``{"leak": "none"}`` and the
inspector app's ``{"required_pressure_kpa": ...}``) carry no ``schema_version`` and are
returned as stored, apart from ``required_pressure_kpa`` becoming
``working_pressure_kpa``.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

SCHEMA_VERSION = 1
TEST_DURATION_MINUTES = (1, 5, 10)
INSPECTION_RESULTS = frozenset({"PASS", "REPAIR", "FAIL", "REVIEW"})
# What a current (schema version 1) inspection may be submitted with.
SUBMITTABLE_INSTRUCTIONS = ("PASS", "REPAIR")
PASS_FAIL = ("PASS", "FAIL")
MAX_NOTES_LENGTH = 2000
MAX_PRESSURE_KPA = 10_000_000
MAX_OHMS = 1_000_000

# The customer's seven condition questions. A ``PASS`` answers "no" to the question.
CONDITION_LABELS: dict[str, str] = {
    "chemical_attack": "Chemical attack or damage to outer carcass",
    "rust_in_fittings": "Excessive rust inside or outside the fittings",
    "end_fitting_damage": "End fittings show signs of damage or displacement",
    "kink_or_dent": "Evidence of kink or dent damage",
    "fitting_seal_damage": (
        "Fitting ends damaged or deformed in a way that they may not form a good seal"
    ),
    "wire_corrosion": "Outer wire shows signs of abrasion or corroding",
    "bend_at_fitting": "Signs of hose being bent or kinked just before the fitting",
}
CONDITION_KEYS = tuple(CONDITION_LABELS)

_V1_KEYS = frozenset(
    {
        "schema_version",
        "working_pressure_kpa",
        "rated_working_pressure_kpa",
        "rated_test_pressure_kpa",
        "test_duration_minutes",
        "ohms_end_a",
        "ohms_end_b",
        "ohms_total",
        "conditions",
        "certificate_result",
        "notes",
    }
)
_OHMS_LABELS = {
    "ohms_end_a": "Ohms end A",
    "ohms_end_b": "Ohms end B",
    "ohms_total": "Ohms total",
}


class MeasurementsError(ValueError):
    """The measurements or result do not follow the schema."""


def _whole(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _pressure(name: str, value: object, *, nullable: bool = False) -> int | None:
    if value is None and nullable:
        return None
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 0 < value <= MAX_PRESSURE_KPA
    ):
        raise MeasurementsError(
            f"{name} must be a whole number of kPa between 1 and {MAX_PRESSURE_KPA}"
        )
    return value


def _ohms(name: str, value: object) -> int | float:
    if (
        isinstance(value, bool)
        or not isinstance(value, int | float)
        or not math.isfinite(value)
        or not 0 <= value <= MAX_OHMS
    ):
        raise MeasurementsError(f"{name} must be a number between 0 and {MAX_OHMS}")
    return value


def validate_inspection_result(value: str | None) -> str | None:
    """The inspection's result/instruction must be one of the known values."""
    if value is not None and value not in INSPECTION_RESULTS:
        raise MeasurementsError(
            f"result must be one of {', '.join(sorted(INSPECTION_RESULTS))}"
        )
    return value


def normalize_measurements(raw: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Validate and normalise measurements; pass legacy free-form records through."""
    if raw is None:
        return None
    data = dict(raw)
    if "required_pressure_kpa" in data:
        legacy = data.pop("required_pressure_kpa")
        data.setdefault("working_pressure_kpa", legacy)
    if not _V1_KEYS & data.keys():
        return data  # a legacy record: kept exactly as stored

    version = data.get("schema_version", SCHEMA_VERSION)
    if version != SCHEMA_VERSION or isinstance(version, bool):
        raise MeasurementsError(f"schema_version must be {SCHEMA_VERSION}")

    if "working_pressure_kpa" in data:
        data["working_pressure_kpa"] = _pressure(
            "working_pressure_kpa", data["working_pressure_kpa"]
        )
    for name in ("rated_working_pressure_kpa", "rated_test_pressure_kpa"):
        if name in data:
            data[name] = _pressure(name, data[name], nullable=True)
    if "test_duration_minutes" in data:
        minutes = data["test_duration_minutes"]
        if not _whole(minutes) or minutes not in TEST_DURATION_MINUTES:
            raise MeasurementsError(
                "test_duration_minutes must be one of "
                + ", ".join(str(option) for option in TEST_DURATION_MINUTES)
            )
    for name in _OHMS_LABELS:
        if name in data:
            data[name] = _ohms(name, data[name])
    if "conditions" in data:
        conditions = data["conditions"]
        if not isinstance(conditions, Mapping):
            raise MeasurementsError("conditions must be an object")
        for key, answer in conditions.items():
            if key not in CONDITION_LABELS:
                raise MeasurementsError(f"unknown condition check: {key}")
            if answer not in PASS_FAIL or isinstance(answer, bool):
                raise MeasurementsError(f"{key} must be PASS or FAIL")
        data["conditions"] = dict(conditions)
    if "certificate_result" in data and data["certificate_result"] not in PASS_FAIL:
        raise MeasurementsError("certificate_result must be PASS or FAIL")
    if "notes" in data:
        notes = data["notes"]
        if notes is not None and (
            not isinstance(notes, str) or len(notes) > MAX_NOTES_LENGTH
        ):
            raise MeasurementsError(
                f"notes must be text of at most {MAX_NOTES_LENGTH} characters"
            )
    return data


def missing_for_submission(
    measurements: Mapping[str, Any] | None,
    result: str | None,
    *,
    hold_time_seconds: int,
) -> list[str]:
    """What a current-schema inspection still lacks before it can be submitted.

    Records without ``schema_version`` predate the form and have no extra
    requirements, so they submit exactly as before.
    """
    if not measurements or measurements.get("schema_version") != SCHEMA_VERSION:
        return []
    missing: list[str] = []
    if result not in SUBMITTABLE_INSTRUCTIONS:
        missing.append("Instruction")
    if measurements.get("working_pressure_kpa") is None:
        missing.append("Working pressure")
    minutes = measurements.get("test_duration_minutes")
    if minutes is None:
        missing.append("Test time")
    elif hold_time_seconds != minutes * 60:
        missing.append("Test time does not match the recorded hold time")
    for name, label in _OHMS_LABELS.items():
        if measurements.get(name) is None:
            missing.append(label)
    conditions = measurements.get("conditions") or {}
    missing.extend(
        label for key, label in CONDITION_LABELS.items() if key not in conditions
    )
    if measurements.get("certificate_result") is None:
        missing.append("Certificate result")
    return missing
