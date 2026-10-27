"""The inspection lifecycle migration: additive, nullable, safe for existing rows."""

from __future__ import annotations

from pathlib import Path

import pytest
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from alembic import command
from hms_backend.app.core.config import settings

BACKEND_ROOT = Path(__file__).resolve().parents[1]
BEFORE = "20261023_0023"
AFTER = "20261026_0024"


def _config(db_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{db_path}")
    cfg = Config(str(BACKEND_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    return cfg


def _columns(db_path: Path) -> dict[str, bool]:
    engine = create_engine(f"sqlite:///{db_path}")
    try:
        return {
            column["name"]: bool(column["nullable"])
            for column in inspect(engine).get_columns("inspections")
        }
    finally:
        engine.dispose()


def test_the_new_columns_are_nullable_and_existing_rows_survive_both_ways(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "lifecycle.db"
    config = _config(db_path, monkeypatch)

    command.upgrade(config, BEFORE)
    assert "started_at" not in _columns(db_path)

    # One existing inspection per old status, written the way the previous release did.
    engine = create_engine(f"sqlite:///{db_path}")
    try:
        with engine.begin() as connection:
            connection.execute(text("PRAGMA foreign_keys=OFF"))
            for index, status in enumerate(
                ("DRAFT", "SUBMITTED", "APPROVED", "REJECTED")
            ):
                connection.execute(
                    text(
                        "INSERT INTO inspections (id, version, created_at, updated_at, "
                        "asset_id, inspection_type, status) VALUES "
                        "(:id, 1, '2026-01-01', '2026-01-01', "
                        "'asset', 'SERVICE', :status)"
                    ),
                    {"id": f"old-{index}", "status": status},
                )
    finally:
        engine.dispose()

    command.upgrade(config, AFTER)
    columns = _columns(db_path)
    assert columns["started_at"] is True and columns["rejection_reason"] is True

    engine = create_engine(f"sqlite:///{db_path}")
    try:
        with engine.connect() as connection:
            rows = connection.execute(
                text(
                    "SELECT status, started_at, rejection_reason "
                    "FROM inspections ORDER BY id"
                )
            ).all()
    finally:
        engine.dispose()
    # Nothing was backfilled: no historical start time or reason is invented.
    assert [tuple(row) for row in rows] == [
        ("DRAFT", None, None),
        ("SUBMITTED", None, None),
        ("APPROVED", None, None),
        ("REJECTED", None, None),
    ]

    command.downgrade(config, BEFORE)
    assert "started_at" not in _columns(db_path)
    assert "rejection_reason" not in _columns(db_path)
    engine = create_engine(f"sqlite:///{db_path}")
    try:
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT count(*) FROM inspections")) == 4
    finally:
        engine.dispose()

    command.upgrade(config, "head")
    assert _columns(db_path)["started_at"] is True
