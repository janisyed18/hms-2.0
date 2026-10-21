"""Report (and optionally delete) certificate PDFs no certificate references.

Dry run by default: it lists orphaned objects and deletes nothing. Pass ``--apply`` to
delete what it listed. Objects younger than ``--older-than-minutes`` are never
considered, so an in-flight issuance is safe. Objects superseded by a PDF
regeneration are unreferenced too and are included; review the list before applying.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from datetime import timedelta

from hms_backend.app.api.dependencies import SessionLocal
from hms_backend.app.core.object_storage import get_object_storage
from hms_backend.app.modules.certificates.reconcile import (
    delete_artifacts,
    find_unreferenced_artifacts,
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Find certificate PDFs that no certificate row references."
    )
    parser.add_argument(
        "--older-than-minutes",
        type=int,
        default=60,
        help="Only consider objects at least this old (default 60).",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Delete the listed objects. Without it nothing is deleted.",
    )
    return parser


async def _run(args: argparse.Namespace) -> dict[str, object]:
    if args.older_than_minutes < 5:
        raise SystemExit("--older-than-minutes must be at least 5")
    storage = get_object_storage()
    async with SessionLocal() as session:
        orphans = await find_unreferenced_artifacts(
            session,
            storage,
            older_than=timedelta(minutes=args.older_than_minutes),
        )
    result: dict[str, object] = {
        "unreferenced": [
            {"key": o.key, "last_modified": o.last_modified.isoformat(), "size": o.size}
            for o in orphans
        ],
        "applied": args.apply,
        "deleted": 0,
    }
    if args.apply:
        result["deleted"] = await delete_artifacts(storage, orphans)
    return result


def main() -> None:
    print(json.dumps(asyncio.run(_run(_parser().parse_args())), sort_keys=True))


if __name__ == "__main__":
    main()
