"""Browser-auth and password-reset migration up/down/up cycle tests.

Runs the real Alembic chain against a throwaway SQLite database so the migration
is exercised as a genuine second source of truth alongside the ORM models. Drift
between the models and the migration — or a broken upgrade/downgrade — surfaces
here rather than only in a manually run ``alembic check``. Also pins the D1/D2
fixes (unique ``lower(email)`` index, cascading security-table foreign keys) into
the migrated schema, not just the model metadata.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from alembic import command
from hms_backend.app.core.config import settings

BACKEND_ROOT = Path(__file__).resolve().parents[1]
DOWN_REVISION = "20260712_0009"
BROWSER_AUTH_TABLES = {
    "browser_auth_challenges",
    "browser_refresh_sessions",
    "mfa_recovery_codes",
}
PASSWORD_RESET_TABLES = {
    "password_reset_tokens",
    "password_reset_deliveries",
}
NEW_USER_COLUMNS = {
    "account_status",
    "must_change_password",
    "password_changed_at",
    "mfa_enabled",
    "mfa_secret_ciphertext",
    "mfa_secret_key_version",
    "mfa_last_accepted_step",
    "failed_password_attempts",
    "failed_mfa_attempts",
    "locked_until",
    "last_login_at",
}


def _alembic_config(db_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    # env.py builds the engine from settings.database_url; point the whole chain
    # at an isolated temp SQLite database (async driver, as env.py expects).
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{db_path}")
    cfg = Config(str(BACKEND_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    return cfg


def _schema(db_path: Path) -> tuple[set[str], set[str]]:
    engine = create_engine(f"sqlite:///{db_path}")
    try:
        inspector = inspect(engine)
        tables = set(inspector.get_table_names())
        user_columns = (
            {column["name"] for column in inspector.get_columns("users")}
            if "users" in tables
            else set()
        )
        return tables, user_columns
    finally:
        engine.dispose()


def _sqlite_ddl(db_path: Path, object_type: str, name: str) -> str | None:
    engine = create_engine(f"sqlite:///{db_path}")
    try:
        with engine.connect() as connection:
            row = connection.execute(
                text(
                    "SELECT sql FROM sqlite_master "
                    "WHERE type = :object_type AND name = :name"
                ),
                {"object_type": object_type, "name": name},
            ).first()
        return row[0] if row else None
    finally:
        engine.dispose()


def test_migration_0010_upgrades_downgrades_and_reupgrades(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "migration.db"
    config = _alembic_config(db_path, monkeypatch)

    command.upgrade(config, "head")

    tables, user_columns = _schema(db_path)
    assert BROWSER_AUTH_TABLES | PASSWORD_RESET_TABLES <= tables
    assert NEW_USER_COLUMNS <= user_columns

    # D1: the case-insensitive email lookup index is UNIQUE in the real schema.
    email_index_ddl = _sqlite_ddl(db_path, "index", "ix_users_email_lower")
    assert email_index_ddl is not None
    assert "UNIQUE" in email_index_ddl.upper()
    assert "LOWER" in email_index_ddl.upper()

    # D2: security-table foreign keys cascade (and the rotation self-ref nulls).
    for table in BROWSER_AUTH_TABLES | PASSWORD_RESET_TABLES:
        assert "ON DELETE CASCADE" in (_sqlite_ddl(db_path, "table", table) or "")
    assert "ON DELETE SET NULL" in (
        _sqlite_ddl(db_path, "table", "browser_refresh_sessions") or ""
    )

    engine = create_engine(f"sqlite:///{db_path}")
    try:
        inspector = inspect(engine)
        token_uniques = {
            frozenset(constraint["column_names"])
            for constraint in inspector.get_unique_constraints("password_reset_tokens")
        }
        token_indexes = {
            index["name"]: (index["unique"], index["column_names"])
            for index in inspector.get_indexes("password_reset_tokens")
        }
        delivery_indexes = {
            index["name"]: (index["unique"], index["column_names"])
            for index in inspector.get_indexes("password_reset_deliveries")
        }
        delivery_columns = {
            column["name"]: column
            for column in inspector.get_columns("password_reset_deliveries")
        }
        token_foreign_keys = inspector.get_foreign_keys("password_reset_tokens")
        delivery_foreign_keys = inspector.get_foreign_keys("password_reset_deliveries")
    finally:
        engine.dispose()

    assert frozenset({"token_hash"}) in token_uniques
    assert token_indexes == {
        "ix_password_reset_tokens_user_id": (0, ["user_id"]),
    }
    assert delivery_indexes == {
        "ix_password_reset_deliveries_reset_id": (1, ["reset_id"]),
        "ix_password_reset_deliveries_scheduled_for": (
            0,
            ["scheduled_for"],
        ),
        "ix_password_reset_deliveries_status": (0, ["status"]),
    }
    assert delivery_columns["ciphertext"]["nullable"] is True
    assert token_foreign_keys == [
        {
            "name": None,
            "constrained_columns": ["user_id"],
            "referred_schema": None,
            "referred_table": "users",
            "referred_columns": ["id"],
            "options": {"ondelete": "CASCADE"},
        }
    ]
    assert delivery_foreign_keys == [
        {
            "name": None,
            "constrained_columns": ["reset_id"],
            "referred_schema": None,
            "referred_table": "password_reset_tokens",
            "referred_columns": ["id"],
            "options": {"ondelete": "CASCADE"},
        }
    ]

    command.downgrade(config, DOWN_REVISION)

    tables_after, user_columns_after = _schema(db_path)
    assert not (PASSWORD_RESET_TABLES & tables_after)
    assert BROWSER_AUTH_TABLES <= tables_after
    assert NEW_USER_COLUMNS <= user_columns_after
    assert _sqlite_ddl(db_path, "index", "ix_users_email_lower") is not None

    # The up/down cycle is idempotent: re-upgrading rebuilds the schema cleanly.
    command.upgrade(config, "head")
    tables_final, _ = _schema(db_path)
    assert BROWSER_AUTH_TABLES | PASSWORD_RESET_TABLES <= tables_final
