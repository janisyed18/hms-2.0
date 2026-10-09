"""Regenerate a missing legacy certificate PDF without changing its identity.

Run only for a named certificate after reviewing the record. The command renders
the currently persisted certificate facts, replaces the missing object at its
existing key, updates the content hash and writes an immutable audit event.
"""

from __future__ import annotations

import argparse
import asyncio
import json

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from hms_backend.app.api.dependencies import SessionLocal
from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.certificates.issuance import regenerate_certificate_pdf
from hms_backend.app.modules.certificates.models import Certificate
from hms_backend.app.modules.inspections.models import Inspection
from hms_backend.app.modules.products.models import Product


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Regenerate a missing PDF for one issued legacy certificate."
    )
    parser.add_argument(
        "--certificate-number",
        required=True,
        help="Exact certificate number to regenerate.",
    )
    parser.add_argument(
        "--actor-id",
        default="system-certificate-repair",
        help="Audit actor recorded for the repair.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Inspect the certificate without rendering, writing or committing.",
    )
    return parser


async def _run(args: argparse.Namespace) -> dict[str, object]:
    async with SessionLocal() as session:
        statement = (
            select(Certificate)
            .where(
                Certificate.number == args.certificate_number,
                Certificate.deleted_at.is_(None),
            )
            .options(
                selectinload(Certificate.inspection)
                .selectinload(Inspection.asset)
                .selectinload(Asset.customer),
                selectinload(Certificate.inspection)
                .selectinload(Inspection.asset)
                .selectinload(Asset.location),
                selectinload(Certificate.inspection)
                .selectinload(Inspection.asset)
                .selectinload(Asset.product)
                .selectinload(Product.standard),
                selectinload(Certificate.inspection)
                .selectinload(Inspection.asset)
                .selectinload(Asset.ends),
            )
        )
        certificate = (await session.scalars(statement)).one_or_none()
        if certificate is None:
            raise RuntimeError("certificate not found")

        result: dict[str, object] = {
            "certificate_number": certificate.number,
            "object_key": certificate.pdf_object_key,
            "status": certificate.status,
            "dry_run": args.dry_run,
        }
        if args.dry_run:
            return result

        repaired = await regenerate_certificate_pdf(
            session,
            certificate,
            actor_id=args.actor_id,
        )
        await session.commit()
        result["verification_hash"] = repaired.verification_hash
        result["dry_run"] = False
        return result


def main() -> None:
    args = _parser().parse_args()
    print(json.dumps(asyncio.run(_run(args)), sort_keys=True))


if __name__ == "__main__":
    main()
