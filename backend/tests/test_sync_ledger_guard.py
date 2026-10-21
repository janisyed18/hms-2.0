"""Every ``SyncChange`` row must be created through ``stage_sync_change``.

The sync cursor is only correct if a change's sequence number is allocated while the
global ledger lock is held (see ``core/sync_ledger.py``). A direct ``SyncChange(...)``
anywhere else would allocate its number before that lock and reopen the lost-update
race, so construction outside the helper is a test failure.
"""

from __future__ import annotations

import re
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "src" / "hms_backend"
ALLOWED = {Path("app/core/sync_ledger.py")}
CONSTRUCTION = re.compile(r"(?<!class )\bSyncChange\s*\(")


def test_sync_changes_are_only_constructed_by_the_ledger_helper() -> None:
    offenders = [
        str(path.relative_to(SOURCE))
        for path in sorted(SOURCE.rglob("*.py"))
        if path.relative_to(SOURCE) not in ALLOWED
        and CONSTRUCTION.search(path.read_text(encoding="utf-8"))
    ]
    assert offenders == [], (
        "construct SyncChange via stage_sync_change, not directly: "
        + ", ".join(offenders)
    )


def test_the_helper_takes_the_lock_before_inserting() -> None:
    body = (SOURCE / "app/core/sync_ledger.py").read_text(encoding="utf-8")
    function = body[body.index("async def stage_sync_change") :]
    assert (
        function.index("acquire_ledger_lock")
        < function.index("SyncChange(")
        < function.rindex("session.flush()")
    )
