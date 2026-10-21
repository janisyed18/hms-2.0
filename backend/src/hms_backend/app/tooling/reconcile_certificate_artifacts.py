"""Report (and optionally delete) orphaned certificate PDFs.

Dry run by default: it lists unreferenced objects, classified, and deletes nothing.
Only ``orphan`` objects are ever deleted, and only with ``--apply``:

* ``orphan``: a leftover from a crashed or rolled-back issuance, or a failed
  regeneration attempt newer than the certificate's current revision;
* ``superseded``: an older revision of a successfully regenerated certificate. This is
  committed history. It is listed for information and never deleted;
* ``unclassified``: a key outside the certificate key scheme. Listed, never deleted.

Objects younger than ``--older-than-minutes`` are not considered. Each deletion
re-checks the object under the certificate row lock, so a regeneration that has
since adopted the key is never broken.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from datetime import timedelta

from hms_backend.app.api.dependencies import SessionLocal
from hms_backend.app.core.object_storage import get_object_storage
from hms_backend.app.modules.certificates.reconcile import (
    ORPHAN,
    SUPERSEDED,
    UNCLASSIFIED,
    ArtifactFinding,
    delete_orphans,
    find_unreferenced_artifacts,
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Find orphaned certificate PDFs that no certificate references."
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
        help="Delete the orphan objects. Without it nothing is deleted.",
    )
    return parser


def _describe(findings: list[ArtifactFinding], classification: str) -> list[object]:
    return [
        {
            "key": f.stored.key,
            "last_modified": f.stored.last_modified.isoformat(),
            "size": f.stored.size,
        }
        for f in findings
        if f.classification == classification
    ]


async def _run(args: argparse.Namespace) -> dict[str, object]:
    if args.older_than_minutes < 5:
        raise SystemExit("--older-than-minutes must be at least 5")
    storage = get_object_storage()
    async with SessionLocal() as session:
        findings = await find_unreferenced_artifacts(
            session, storage, older_than=timedelta(minutes=args.older_than_minutes)
        )
        result: dict[str, object] = {
            "orphan": _describe(findings, ORPHAN),
            "superseded": _describe(findings, SUPERSEDED),
            "unclassified": _describe(findings, UNCLASSIFIED),
            "applied": args.apply,
            "deleted": [],
            "skipped": [],
        }
        if args.apply:
            outcome = await delete_orphans(session, storage, findings)
            result["deleted"] = outcome.deleted
            result["skipped"] = [
                {"key": key, "reason": reason}
                for key, reason in outcome.skipped
                if not reason.startswith("not deletable")
            ]
    return result


def main() -> None:
    print(json.dumps(asyncio.run(_run(_parser().parse_args())), sort_keys=True))


if __name__ == "__main__":
    main()
