"""alembic/env.py must run each migration in its own transaction.

Migration 20261023_0023 uses ``autocommit_block()``, which commits whatever the run
has already done. With one run-wide transaction that commits earlier migrations'
work while later migrations stay uncommitted; ``transaction_per_migration=True`` is
Alembic's remedy.
"""

from __future__ import annotations

import ast
import asyncio
import os
import shutil
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

BACKEND = Path(__file__).resolve().parents[1]
ENV_PY = BACKEND / "alembic" / "env.py"
POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")


def test_env_py_configures_a_transaction_per_migration() -> None:
    calls = [
        node
        for node in ast.walk(ast.parse(ENV_PY.read_text()))
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "configure"
    ]
    assert calls, "env.py no longer calls context.configure"
    for call in calls:
        flag = {k.arg: k.value for k in call.keywords}.get("transaction_per_migration")
        assert isinstance(flag, ast.Constant) and flag.value is True


REVISIONS = {
    "a1": ("", "op.execute('CREATE TABLE t_a (id int)')"),
    "b2": (
        "a1",
        "op.execute('CREATE TABLE t_b_before (id int)')\n"
        "    with op.get_context().autocommit_block():\n"
        "        op.execute('SELECT 1')\n"
        "    op.execute('CREATE TABLE t_b_after (id int)')",
    ),
    "c3": ("b2", "raise RuntimeError('c3 fails')"),
}


@pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)
def test_work_after_an_autocommit_block_is_committed_with_its_own_migration(
    tmp_path: Path,
) -> None:
    """a1, then b2 (autocommit block mid-migration), then a failing c3.

    Per-migration transactions keep b2 whole: its post-block table and its version
    stamp are committed before c3 runs. A single run-wide transaction would roll
    back b2's post-block work and stamp when c3 fails.
    """
    assert POSTGRES_URL is not None
    scripts = tmp_path / "alembic"
    (scripts / "versions").mkdir(parents=True)
    shutil.copy(ENV_PY, scripts / "env.py")
    for revision, (parent, body) in REVISIONS.items():
        (scripts / "versions" / f"{revision}.py").write_text(
            "from alembic import op\n"
            f"revision = '{revision}'\n"
            f"down_revision = {parent!r} or None\n"
            "branch_labels = None\ndepends_on = None\n\n"
            f"def upgrade() -> None:\n    {body}\n\n"
            "def downgrade() -> None:\n    pass\n"
        )
    ini = tmp_path / "alembic.ini"
    # The real ini carries the logging sections env.py's fileConfig() requires.
    ini.write_text(
        (BACKEND / "alembic.ini")
        .read_text()
        .replace("script_location = alembic", f"script_location = {scripts}")
    )

    base = make_url(POSTGRES_URL)
    name = f"hms_txn_{uuid4().hex[:10]}_test"
    url = base.set(database=name)

    async def run(
        sql: str, database: str | None = None, autocommit: bool = False
    ) -> list[str]:
        engine = create_async_engine(
            base.set(database=database) if database else base,
            isolation_level="AUTOCOMMIT" if autocommit else None,
        )
        try:
            async with engine.connect() as connection:
                result = await connection.execute(text(sql))
                return [str(row[0]) for row in result] if result.returns_rows else []
        finally:
            await engine.dispose()

    asyncio.run(run(f'CREATE DATABASE "{name}"', autocommit=True))
    try:
        outcome = subprocess.run(
            [sys.executable, "-m", "alembic", "-c", str(ini), "upgrade", "head"],
            cwd=BACKEND,
            env={
                **os.environ,
                "DATABASE_URL": url.render_as_string(hide_password=False),
            },
            capture_output=True,
            text=True,
            timeout=300,
        )
        assert outcome.returncode != 0 and "c3 fails" in outcome.stderr
        assert asyncio.run(run("SELECT version_num FROM alembic_version", name)) == [
            "b2"
        ]
        tables = asyncio.run(
            run("SELECT tablename FROM pg_tables WHERE tablename LIKE 't\\_%'", name)
        )
        assert sorted(tables) == ["t_a", "t_b_after", "t_b_before"]
    finally:
        asyncio.run(
            run(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                f"WHERE datname = '{name}'",
                autocommit=True,
            )
        )
        asyncio.run(run(f'DROP DATABASE IF EXISTS "{name}"', autocommit=True))
