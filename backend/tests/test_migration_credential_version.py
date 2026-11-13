"""The credential-version migration: additive, defaults to 0, reversible."""

from __future__ import annotations

from pathlib import Path

import pytest
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from alembic import command
from hms_backend.app.core.config import settings

BACKEND_ROOT = Path(__file__).resolve().parents[1]
BEFORE = "20261110_0029"
AFTER = "20261113_0030"


def _config(db_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{db_path}")
    cfg = Config(str(BACKEND_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    return cfg


def _columns(db_path: Path, table: str) -> set[str]:
    engine = create_engine(f"sqlite:///{db_path}")
    try:
        return {column["name"] for column in inspect(engine).get_columns(table)}
    finally:
        engine.dispose()


def test_existing_users_start_at_version_zero_and_the_column_can_be_removed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "credential-version.db"
    config = _config(db_path, monkeypatch)

    command.upgrade(config, BEFORE)
    assert "credential_version" not in _columns(db_path, "users")
    assert "credential_version" not in _columns(
        db_path, "browser_auth_challenges"
    )
    engine = create_engine(f"sqlite:///{db_path}")
    try:
        # A user row as the previous release wrote it: every required column filled.
        required: dict[str, object] = {}
        for column in inspect(engine).get_columns("users"):
            if column["nullable"] or column["default"] is not None:
                continue
            kind = str(column["type"]).upper()
            required[column["name"]] = (
                0 if "INT" in kind or "BOOL" in kind else f"x-{column['name']}"
            )
        required.update(id="u1", oidc_subject="s1", email="a@example.com")
        required.update(role="INSPECTOR", account_status="ACTIVE")
        with engine.begin() as connection:
            connection.execute(
                text(
                    f"INSERT INTO users ({', '.join(required)}) "
                    f"VALUES ({', '.join(':' + name for name in required)})"
                ),
                required,
            )
    finally:
        engine.dispose()

    command.upgrade(config, AFTER)
    engine = create_engine(f"sqlite:///{db_path}")
    try:
        with engine.connect() as connection:
            version = connection.execute(
                text("SELECT credential_version FROM users WHERE id = 'u1'")
            ).scalar_one()
    finally:
        engine.dispose()
    assert version == 0

    command.downgrade(config, BEFORE)
    assert "credential_version" not in _columns(db_path, "users")
    assert "credential_version" not in _columns(
        db_path, "browser_auth_challenges"
    )
