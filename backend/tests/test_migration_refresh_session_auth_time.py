"""The refresh-session auth_time migration: additive, nullable, reversible."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from alembic.config import Config
from sqlalchemy import create_engine, inspect

from alembic import command
from hms_backend.app.core.config import settings

BACKEND_ROOT = Path(__file__).resolve().parents[1]
BEFORE = "20261113_0030"
AFTER = "20261113_0031"


def _config(db_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{db_path}")
    cfg = Config(str(BACKEND_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    return cfg


def _auth_time_column(db_path: Path) -> Mapping[str, Any] | None:
    engine = create_engine(f"sqlite:///{db_path}")
    try:
        columns = inspect(engine).get_columns("browser_refresh_sessions")
    finally:
        engine.dispose()
    return next((c for c in columns if c["name"] == "auth_time"), None)


def test_auth_time_is_added_nullable_and_can_be_removed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "auth-time.db"
    config = _config(db_path, monkeypatch)

    command.upgrade(config, BEFORE)
    assert _auth_time_column(db_path) is None

    command.upgrade(config, AFTER)
    column = _auth_time_column(db_path)
    assert column is not None and column["nullable"] is True

    command.downgrade(config, BEFORE)
    assert _auth_time_column(db_path) is None
