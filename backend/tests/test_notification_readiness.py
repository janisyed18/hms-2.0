"""The notification readiness report: gating logic and the command's exit contract."""

from __future__ import annotations

import json
from typing import Any

import pytest

import hms_backend.app.tooling.notification_readiness as readiness


def _report(**overrides: dict[str, Any]) -> dict[str, Any]:
    report: dict[str, Any] = {
        "notifications": {"by_status": {}, "due_pending": 0, "expired_sending": 0},
        "outbox": {
            "unprocessed": 0,
            "unprocessed_with_error": 0,
            "processed_with_error": 0,
        },
        "password_resets": {
            "by_status": {},
            "due_pending": 0,
            "expired_sending": 0,
            "finished_retaining_ciphertext": 0,
        },
    }
    for section, values in overrides.items():
        report[section] = {**report[section], **values}
    return report


def test_a_clean_database_has_no_blockers_or_warnings() -> None:
    assert readiness.evaluate(_report()) == ([], [])


@pytest.mark.parametrize(
    ("section", "field"),
    [
        ("notifications", "expired_sending"),
        ("password_resets", "expired_sending"),
        ("password_resets", "finished_retaining_ciphertext"),
    ],
)
def test_each_unexpected_state_blocks_activation(section: str, field: str) -> None:
    blockers, _ = readiness.evaluate(_report(**{section: {field: 1}}))
    assert len(blockers) == 1


@pytest.mark.parametrize(
    ("section", "field"),
    [
        ("notifications", "due_pending"),
        ("password_resets", "due_pending"),
        ("outbox", "unprocessed"),
        ("outbox", "unprocessed_with_error"),
    ],
)
def test_pending_work_is_a_warning_not_a_blocker(section: str, field: str) -> None:
    blockers, warnings = readiness.evaluate(_report(**{section: {field: 3}}))
    assert blockers == []
    assert len(warnings) == 1


def test_status_keys_are_restricted_to_status_shaped_values() -> None:
    assert readiness._status_key("SENDING") == "SENDING"
    assert readiness._status_key("DEAD_LETTER") == "DEAD_LETTER"
    assert readiness._status_key("a@b.example sent") == "OTHER"
    assert readiness._status_key(None) == "OTHER"


def test_exit_status_is_zero_when_ready(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fake_run() -> dict[str, Any]:
        return {"ready": True, "blockers": []}

    monkeypatch.setattr(readiness, "run", fake_run)
    with pytest.raises(SystemExit) as exit_info:
        readiness.main()
    assert exit_info.value.code == 0
    assert json.loads(capsys.readouterr().out)["ready"] is True


def test_exit_status_is_one_when_blocked(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fake_run() -> dict[str, Any]:
        return {"ready": False, "blockers": ["x"]}

    monkeypatch.setattr(readiness, "run", fake_run)
    with pytest.raises(SystemExit) as exit_info:
        readiness.main()
    assert exit_info.value.code == 1
    assert json.loads(capsys.readouterr().out)["ready"] is False


def test_a_failed_check_exits_two_and_prints_only_the_error_class(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fake_run() -> dict[str, Any]:
        raise ConnectionError("postgresql://user:hunter2@db.internal/hms")

    monkeypatch.setattr(readiness, "run", fake_run)
    with pytest.raises(SystemExit) as exit_info:
        readiness.main()
    out = capsys.readouterr().out
    assert exit_info.value.code == 2
    assert json.loads(out) == {"error": "ConnectionError", "ready": False}
    assert "hunter2" not in out


def test_processed_outbox_events_carrying_an_error_never_block_or_warn() -> None:
    assert readiness.evaluate(_report(outbox={"processed_with_error": 9})) == ([], [])


def test_type_names_are_restricted_to_identifier_shaped_values() -> None:
    assert readiness._type_key("DELIVERY_RECEIPT") == "DELIVERY_RECEIPT"
    assert readiness._type_key("Asset") == "Asset"
    assert readiness._type_key("a@b.example") == "OTHER"
    assert readiness._type_key("x" * 81) == "OTHER"
    assert readiness._type_key(None) == "OTHER"
