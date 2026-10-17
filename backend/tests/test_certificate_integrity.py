"""Certificate integrity: issuance atomicity, immutable evidence, public verification.

Uses a really signed PDF (see ``certificate_support``) so signature, digest, expiry
and snapshot checks are exercised against genuine cryptography rather than flags.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
import pytest_asyncio
from certificate_support import (
    Pki,
    SigningFakeEngine,
    blank_pdf,
    build_pki,
    sign_pdf,
)
from certificate_support import (
    seed_approved_inspection as seed,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import hms_backend.app.api.records as records_module
import hms_backend.app.core.object_storage as storage_module
from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.config import settings as app_settings
from hms_backend.app.core.object_storage import LocalObjectStorage
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets.models import (
    Asset,
)
from hms_backend.app.modules.certificates.integrity import (
    IntegrityStatus,
    assess_certificate,
    is_expired,
    pdf_sha256,
)
from hms_backend.app.modules.certificates.issuance import (
    CertificateConflictError,
    CertificateSignatureError,
    generate_and_store_certificate,
    regenerate_certificate_pdf,
)
from hms_backend.app.modules.certificates.mapping import (
    EndFacts,
    PressureFacts,
    facts_from_snapshot,
    facts_to_snapshot,
)
from hms_backend.app.modules.certificates.models import Certificate, CertificateStatus
from hms_backend.app.modules.customers.models import Customer, CustomerLocation
from hms_backend.app.modules.inspections.models import (
    Inspection,
)
from hms_backend.app.modules.products.models import Product

_REVIEWER = Principal(
    user_id="reviewer-1", roles=frozenset({Role.REVIEWER}), customer_ids=frozenset()
)


@pytest.fixture(scope="module")
def pki(tmp_path_factory) -> Pki:
    return build_pki(tmp_path_factory.mktemp("pki"))


@pytest.fixture(scope="module")
def other_pki(tmp_path_factory) -> Pki:
    return build_pki(tmp_path_factory.mktemp("other-pki"), label="Untrusted")


@pytest.fixture(autouse=True)
def _trust_anchor(pki, monkeypatch) -> None:
    monkeypatch.setattr(
        app_settings, "certificate_trust_anchor_path", str(pki.anchor_path)
    )


@pytest.fixture
def storage(tmp_path, monkeypatch) -> LocalObjectStorage:
    store = LocalObjectStorage(tmp_path / "objects")
    monkeypatch.setattr(storage_module, "_storage", store)
    return store


@pytest.fixture
def engine(pki, monkeypatch) -> SigningFakeEngine:
    fake = SigningFakeEngine(pki.signer)
    monkeypatch.setattr(records_module, "get_certificate_engine", lambda: fake)
    return fake


@pytest_asyncio.fixture
async def factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    db = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with db.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(db, expire_on_commit=False)
    await db.dispose()


@asynccontextmanager
async def api(
    factory: async_sessionmaker[AsyncSession],
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_principal] = lambda: _REVIEWER
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        yield client


async def issue(client: httpx.AsyncClient, inspection_id: str, **body: object):
    return await client.post(
        f"/api/v1/inspections/{inspection_id}/certificate", json=body
    )


async def load(factory: async_sessionmaker[AsyncSession], number: str) -> Certificate:
    async with factory() as session:
        return (
            await session.scalars(
                select(Certificate).where(Certificate.number == number)
            )
        ).one()


async def verify(client: httpx.AsyncClient, token: str) -> dict[str, Any]:
    response = await client.get(f"/api/v1/certificates/verify/{token}")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def stored_objects(store: LocalObjectStorage) -> list[Path]:
    return sorted(p for p in Path(store._root).rglob("*.pdf"))  # noqa: SLF001


async def issued(client, factory, tag: str, **body):
    inspection_id = await seed(factory, tag)
    response = await issue(client, inspection_id, **body)
    assert response.status_code == 201, response.text
    return inspection_id, await load(factory, response.json()["number"])


# --------------------------------------------------------------------- issuance


@pytest.mark.asyncio
async def test_issuance_records_evidence_and_opaque_key(
    factory, storage, engine
) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, "A1", number="CERT-HUMAN-0001")

    assert cert.pdf_object_key == f"certificates/{cert.id}/v1.pdf"
    assert "CERT-HUMAN-0001" not in cert.pdf_object_key
    pdf = storage.get(cert.pdf_object_key)
    assert cert.pdf_sha256 == pdf_sha256(pdf)
    assert cert.signer_common_name == "HMS Test Certificate Signer"
    assert cert.signed_at is not None
    assert cert.issuance_facts["customer_name"] == "Acme Mining Pty Ltd"
    # The snapshot is plain JSON (it is persisted in a JSON column).
    json.dumps(cert.issuance_facts)


@pytest.mark.asyncio
async def test_duplicate_number_never_touches_existing_artifact(
    factory, storage, engine
) -> None:
    async with api(factory) as client:
        _, first = await issued(client, factory, "B1", number="CERT-DUP")
        before = storage.get(first.pdf_object_key)
        before_objects = stored_objects(storage)

        second_inspection = await seed(factory, "B2")
        response = await issue(client, second_inspection, number="CERT-DUP")

    assert response.status_code == 409
    assert storage.get(first.pdf_object_key) == before
    assert stored_objects(storage) == before_objects
    # Rejected before any render work was wasted.
    assert engine.calls == 1


@pytest.mark.asyncio
async def test_concurrent_same_number_loses_at_db_before_any_storage_write(
    factory, storage, engine
) -> None:
    """A rival commits the same number while we render; we must not write storage."""
    first_id = await seed(factory, "C1")
    second_id = await seed(factory, "C2")

    async def rival_wins() -> None:
        engine.on_render = None
        async with factory() as session:
            inspection = await session.get(Inspection, second_id)
            await generate_and_store_certificate(
                session, inspection, actor_id="rival", number="CERT-RACE", engine=engine
            )
            await session.commit()

    engine.on_render = rival_wins
    async with factory() as session:
        inspection = await session.get(Inspection, first_id)
        with pytest.raises(CertificateConflictError):
            await generate_and_store_certificate(
                session, inspection, actor_id="loser", number="CERT-RACE", engine=engine
            )
        await session.rollback()

    winner = await load(factory, "CERT-RACE")
    assert winner.issued_by_user_id == "rival"
    assert stored_objects(storage) == [Path(storage._root) / winner.pdf_object_key]  # noqa: SLF001
    assert pdf_sha256(storage.get(winner.pdf_object_key)) == winner.pdf_sha256


@pytest.mark.asyncio
async def test_concurrent_issue_for_same_inspection_creates_one_certificate(
    factory, storage, engine
) -> None:
    inspection_id = await seed(factory, "D1")

    async def rival_wins() -> None:
        engine.on_render = None
        async with factory() as session:
            inspection = await session.get(Inspection, inspection_id)
            await generate_and_store_certificate(
                session, inspection, actor_id="rival", number="CERT-WIN", engine=engine
            )
            await session.commit()

    engine.on_render = rival_wins
    async with factory() as session:
        inspection = await session.get(Inspection, inspection_id)
        with pytest.raises(CertificateConflictError):
            await generate_and_store_certificate(
                session, inspection, actor_id="loser", number="CERT-LOSE", engine=engine
            )
        await session.rollback()

    async with factory() as session:
        certificates = (await session.scalars(select(Certificate))).all()
    assert [c.number for c in certificates] == ["CERT-WIN"]
    assert len(stored_objects(storage)) == 1


@pytest.mark.asyncio
async def test_storage_failure_leaves_no_certificate(factory, storage, engine) -> None:
    class FailingStorage(LocalObjectStorage):
        def put(self, key, data, *, content_type="application/pdf"):
            raise OSError("disk full")

    failing = FailingStorage(Path(storage._root))  # noqa: SLF001
    inspection_id = await seed(factory, "E1")
    async with factory() as session:
        inspection = await session.get(Inspection, inspection_id)
        with pytest.raises(OSError):
            await generate_and_store_certificate(
                session, inspection, actor_id="a", engine=engine, storage=failing
            )
        await session.rollback()

    async with factory() as session:
        assert (await session.scalars(select(Certificate))).all() == []
    assert stored_objects(storage) == []


@pytest.mark.asyncio
async def test_unsigned_engine_output_is_refused(factory, storage, monkeypatch) -> None:
    unsigned = SigningFakeEngine(None)
    monkeypatch.setattr(records_module, "get_certificate_engine", lambda: unsigned)
    inspection_id = await seed(factory, "F1")
    async with api(factory) as client:
        response = await issue(client, inspection_id)
    assert response.status_code == 503
    assert stored_objects(storage) == []
    async with factory() as session:
        assert (await session.scalars(select(Certificate))).all() == []


@pytest.mark.asyncio
async def test_untrusted_signer_is_refused(
    factory, storage, other_pki, monkeypatch
) -> None:
    rogue = SigningFakeEngine(other_pki.signer)
    monkeypatch.setattr(records_module, "get_certificate_engine", lambda: rogue)
    inspection_id = await seed(factory, "F2")
    async with factory() as session:
        inspection = await session.get(Inspection, inspection_id)
        with pytest.raises(CertificateSignatureError):
            await generate_and_store_certificate(
                session, inspection, actor_id="a", engine=rogue
            )
    assert stored_objects(storage) == []


@pytest.mark.asyncio
async def test_issuance_fails_closed_without_trust_anchor(
    factory, storage, engine, monkeypatch
) -> None:
    monkeypatch.setattr(app_settings, "certificate_trust_anchor_path", "")
    inspection_id = await seed(factory, "F3")
    async with api(factory) as client:
        response = await issue(client, inspection_id)
    assert response.status_code == 503
    assert stored_objects(storage) == []


# ------------------------------------------------------------------ verification


@pytest.mark.asyncio
async def test_verified_certificate_reports_every_check(
    factory, storage, engine
) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, "G1")
        body = await verify(client, cert.public_token)
    assert body["valid"] is True
    assert body["integrity"] == "VERIFIED"
    assert (body["hash_matches"], body["artifact_verified"], body["signed"]) == (
        True,
        True,
        True,
    )
    assert body["expired"] is False


@pytest.mark.asyncio
async def test_tampered_pdf_fails(factory, storage, engine) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, "H1")
        path = Path(storage._root) / cert.pdf_object_key  # noqa: SLF001
        data = bytearray(path.read_bytes())
        data[len(data) // 3] ^= 0xFF
        path.write_bytes(bytes(data))
        body = await verify(client, cert.public_token)
    assert body["valid"] is False
    assert body["integrity"] == "FAILED"
    assert body["artifact_verified"] is False
    assert body["signed"] is False


@pytest.mark.asyncio
async def test_missing_pdf_fails(factory, storage, engine) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, "H2")
        (Path(storage._root) / cert.pdf_object_key).unlink()  # noqa: SLF001
        body = await verify(client, cert.public_token)
    assert body["valid"] is False
    assert body["artifact_verified"] is False
    assert "missing" in body["message"]


async def _replace_artifact(factory, storage, cert: Certificate, pdf: bytes) -> None:
    """Swap the stored PDF AND its recorded digest, as a thorough attacker would."""
    storage.put(cert.pdf_object_key, pdf)
    async with factory() as session:
        row = await session.get(Certificate, cert.id)
        row.pdf_sha256 = pdf_sha256(pdf)
        await session.commit()


@pytest.mark.asyncio
async def test_unsigned_pdf_fails_even_with_matching_digest(
    factory, storage, engine
) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, "I1")
        await _replace_artifact(factory, storage, cert, blank_pdf("unsigned"))
        body = await verify(client, cert.public_token)
    assert body["valid"] is False
    assert body["artifact_verified"] is True
    assert body["signed"] is False


@pytest.mark.asyncio
async def test_untrusted_signature_fails(factory, storage, engine, other_pki) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, "I2")
        forged = await asyncio.to_thread(
            sign_pdf, blank_pdf("forged"), other_pki.signer
        )
        await _replace_artifact(factory, storage, cert, forged)
        body = await verify(client, cert.public_token)
    assert body["valid"] is False
    assert body["signed"] is False


@pytest.mark.asyncio
async def test_content_appended_after_signing_fails(factory, storage, engine) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, "I3")
        original = storage.get(cert.pdf_object_key)
        await _replace_artifact(factory, storage, cert, original + b"\n%appended\n")
        body = await verify(client, cert.public_token)
    assert body["valid"] is False
    assert body["signed"] is False


@pytest.mark.asyncio
async def test_missing_trust_anchor_never_reports_signed(
    factory, storage, engine, monkeypatch
) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, "I4")
        monkeypatch.setattr(app_settings, "certificate_trust_anchor_path", "")
        body = await verify(client, cert.public_token)
    assert body["valid"] is False
    assert body["signed"] is False


@pytest.mark.asyncio
async def test_renamed_master_data_does_not_invalidate_historic_certificate(
    factory, storage, engine
) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, "J1")
        async with factory() as session:
            asset = await session.get(Asset, cert.asset_id)
            customer = await session.get(Customer, asset.customer_id)
            product = await session.get(Product, asset.product_id)
            location = await session.get(CustomerLocation, asset.location_id)
            customer.name = "Acme Mining Renamed Ltd"
            asset.asset_number = "HA-RENUMBERED"
            product.name = "Renamed Hose"
            location.name = "South Pit"
            await session.commit()
        body = await verify(client, cert.public_token)

    assert body["valid"] is True
    # Reports what was issued, not today's master data.
    assert body["customer_name"] == "Acme Mining Pty Ltd"
    assert body["asset_number"] == "HA-J1"
    assert body["product_name"] == "2-Wire Hose"


@pytest.mark.asyncio
async def test_tampered_issuance_snapshot_fails(factory, storage, engine) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, "J2")
        async with factory() as session:
            row = await session.get(Certificate, cert.id)
            facts = dict(row.issuance_facts)
            facts["inspection_result"] = "FAIL"
            row.issuance_facts = facts
            await session.commit()
        body = await verify(client, cert.public_token)
    assert body["valid"] is False
    assert body["hash_matches"] is False


@pytest.mark.parametrize(
    ("offset_days", "expect_valid"), [(-1, False), (0, True), (1, True)]
)
@pytest.mark.asyncio
async def test_valid_until_boundaries(
    factory, storage, engine, offset_days, expect_valid
) -> None:
    today = datetime.now(UTC).date()
    async with api(factory) as client:
        _, cert = await issued(client, factory, f"K{offset_days + 1}")
        # valid_until is deliberately outside the hash (renewal metadata), so it
        # can be set directly; expiry is enforced from the column.
        async with factory() as session:
            row = await session.get(Certificate, cert.id)
            row.valid_until = today + timedelta(days=offset_days)
            await session.commit()
        body = await verify(client, cert.public_token)
    assert body["valid"] is expect_valid
    assert body["expired"] is (not expect_valid)
    if not expect_valid:
        assert body["signed"] is True and "expired" in body["message"]


# --------------------------------------------------------------- public download


async def _download(client: httpx.AsyncClient, token: str) -> httpx.Response:
    return await client.get(f"/api/v1/certificates/verify/{token}/pdf")


@pytest.mark.asyncio
async def test_download_serves_verified_artifact(factory, storage, engine) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, "P1")
        response = await _download(client, cert.public_token)
    assert response.status_code == 200
    assert response.content == storage.get(cert.pdf_object_key)


@pytest.mark.asyncio
async def test_download_refused_for_tampered_pdf(factory, storage, engine) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, "P2")
        path = Path(storage._root) / cert.pdf_object_key  # noqa: SLF001
        data = bytearray(path.read_bytes())
        data[len(data) // 3] ^= 0xFF
        path.write_bytes(bytes(data))
        response = await _download(client, cert.public_token)
    assert response.status_code == 409
    assert not response.content.startswith(b"%PDF")


@pytest.mark.asyncio
async def test_download_404_for_missing_pdf(factory, storage, engine) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, "P3")
        (Path(storage._root) / cert.pdf_object_key).unlink()  # noqa: SLF001
        response = await _download(client, cert.public_token)
    assert response.status_code == 404


@pytest.mark.parametrize("kind", ["unsigned", "untrusted", "appended"])
@pytest.mark.asyncio
async def test_download_refused_when_signature_fails_despite_matching_digest(
    factory, storage, engine, other_pki, kind
) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, f"P4{kind[:2]}")
        if kind == "unsigned":
            pdf = blank_pdf("unsigned")
        elif kind == "untrusted":
            pdf = await asyncio.to_thread(
                sign_pdf, blank_pdf("forged"), other_pki.signer
            )
        else:
            pdf = storage.get(cert.pdf_object_key) + b"\n%appended\n"
        await _replace_artifact(factory, storage, cert, pdf)
        response = await _download(client, cert.public_token)
    assert response.status_code == 409
    assert not response.content.startswith(b"%PDF")


@pytest.mark.asyncio
async def test_download_refused_without_trust_anchor(
    factory, storage, engine, monkeypatch
) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, "P5")
        monkeypatch.setattr(app_settings, "certificate_trust_anchor_path", "")
        response = await _download(client, cert.public_token)
    assert response.status_code == 409


@pytest.mark.parametrize("state", ["expired", "REVOKED", "SUPERSEDED"])
@pytest.mark.asyncio
async def test_authentic_artifact_stays_downloadable_when_no_longer_valid(
    factory, storage, engine, state
) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, f"P6{state[:3]}")
        async with factory() as session:
            row = await session.get(Certificate, cert.id)
            if state == "expired":
                row.valid_until = datetime.now(UTC).date() - timedelta(days=1)
            else:
                row.status = state
            await session.commit()
        verified = await verify(client, cert.public_token)
        response = await _download(client, cert.public_token)
    assert verified["valid"] is False
    assert response.status_code == 200
    assert response.content == storage.get(cert.pdf_object_key)


def test_is_expired_boundary() -> None:
    last_day = date(2027, 7, 7)
    assert is_expired(None, last_day) is False
    assert is_expired(last_day, last_day - timedelta(days=1)) is False
    assert is_expired(last_day, last_day) is False
    assert is_expired(last_day, last_day + timedelta(days=1)) is True


@pytest.mark.asyncio
async def test_assess_with_explicit_today(factory, storage, engine) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, "K9", valid_until="2027-07-07")
    async with factory() as session:
        row = await session.get(Certificate, cert.id)
        on_last_day = await assess_certificate(
            row, storage=storage, settings=app_settings, today=date(2027, 7, 7)
        )
        day_after = await assess_certificate(
            row, storage=storage, settings=app_settings, today=date(2027, 7, 8)
        )
    assert on_last_day.valid is True
    assert day_after.valid is False and day_after.expired is True


@pytest.mark.parametrize("new_status", ["REVOKED", "SUPERSEDED"])
@pytest.mark.asyncio
async def test_revoked_or_superseded_is_not_valid(
    factory, storage, engine, new_status
) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, f"L-{new_status[:3]}")
        async with factory() as session:
            row = await session.get(Certificate, cert.id)
            row.status = CertificateStatus[new_status].value
            await session.commit()
        body = await verify(client, cert.public_token)
    assert body["valid"] is False
    assert body["status"] == new_status
    assert body["signed"] is True
    assert new_status.lower() in body["message"]


@pytest.mark.asyncio
async def test_legacy_certificate_is_unverified_but_downloadable(
    factory, storage, engine
) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, "M1")
        async with factory() as session:
            row = await session.get(Certificate, cert.id)
            row.issuance_facts = None
            row.pdf_sha256 = None
            await session.commit()
        body = await verify(client, cert.public_token)
        pdf = await client.get(f"/api/v1/certificates/verify/{cert.public_token}/pdf")

    assert body["valid"] is False
    assert body["integrity"] == IntegrityStatus.LEGACY_UNVERIFIED.value
    assert body["signed"] is False
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")


@pytest.mark.asyncio
async def test_certificate_with_evidence_cannot_be_regenerated(
    factory, storage, engine
) -> None:
    async with api(factory) as client:
        _, cert = await issued(client, factory, "N1")
    async with factory() as session:
        row = await session.get(Certificate, cert.id)
        with pytest.raises(ValueError, match="cannot be regenerated"):
            await regenerate_certificate_pdf(
                session, row, actor_id="repair", engine=engine, storage=storage
            )


def test_snapshot_round_trips_nested_facts() -> None:
    from hms_backend.app.modules.certificates.mapping import CertificateFacts

    facts = CertificateFacts(
        **{
            name: "x"
            for name in CertificateFacts.__dataclass_fields__
            if name not in {"ends", "pressure", "certificate_version"}
        },
        certificate_version=1,
        ends=(EndFacts(end="A", nominal_bore="DN25"), EndFacts(end="B")),
        pressure=PressureFacts(applied_pressure_kpa=42000, passed=True),
    )
    restored = facts_from_snapshot(json.loads(json.dumps(facts_to_snapshot(facts))))
    assert restored == facts
