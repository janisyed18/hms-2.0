"""The customer inspection form end to end through the API and sync.

Covers the structured fields (pressures, test time, resistance, condition checks,
certificate result, notes), the Pass/Repair instruction, draft persistence and reload,
submission completeness, the offline inspector's sync push (including a real submit),
the reviewer reading the same data, and what reaches the certificate.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

# Fixtures and helpers are shared with the sync API tests.
from test_sync_api import (  # noqa: F401
    api_client,
    assigned_inspector_booking,
    seeded_sync_session,
    session_factory,
    sync_headers,
)

from hms_backend.app.core.audit import verify_audit_chain
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.models.foundation import AuditEvent
from hms_backend.app.modules.certificates.mapping import build_facts
from hms_backend.app.modules.inspections.measurements import CONDITION_KEYS
from hms_backend.app.modules.inspections.models import Inspection
from hms_backend.app.modules.notifications.models import OutboxEvent

INSPECTOR = Principal(
    user_id="inspector-1", roles=frozenset({Role.INSPECTOR}), customer_ids=frozenset()
)
REVIEWER = Principal(
    user_id="reviewer-1", roles=frozenset({Role.REVIEWER}), customer_ids=frozenset()
)


def complete(**overrides: Any) -> dict[str, Any]:
    measurements: dict[str, Any] = {
        "schema_version": 1,
        "working_pressure_kpa": 1500,
        "rated_working_pressure_kpa": 1500,
        "rated_test_pressure_kpa": 2250,
        "test_duration_minutes": 5,
        "ohms_end_a": 0.1,
        "ohms_end_b": 0.2,
        "ohms_total": 0.3,
        "conditions": {key: "PASS" for key in CONDITION_KEYS},
        "certificate_result": "PASS",
        "notes": "No leaks seen.",
    }
    measurements.update(overrides)
    return measurements


def pressure_test(measurements: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "applied_pressure_kpa": 2250,
        "hold_time_seconds": 300,
        "passed": True,
        "measurements": measurements,
    }
    body.update(overrides)
    return body


async def create_draft(
    client: Any,
    asset_id: str,
    *,
    result: str | None = "PASS",
    test: dict[str, Any] | None,
) -> Any:
    body: dict[str, Any] = {"inspection_type": "SERVICE", "result": result}
    if test is not None:
        body["pressure_test"] = test
    return await client.post(f"/api/v1/assets/{asset_id}/inspections", json=body)


@pytest.mark.asyncio
async def test_a_draft_keeps_every_field_and_reloads_identically(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    asset_id = seeded_sync_session["vopak_asset_id"]
    async with api_client(session_factory, INSPECTOR) as client:
        created = await create_draft(
            client, asset_id, result="REPAIR", test=pressure_test(complete())
        )
        assert created.status_code == 201, created.text
        reloaded = await client.get(f"/api/v1/inspections/{created.json()['id']}")

    for body in (created.json(), reloaded.json()):
        assert body["result"] == "REPAIR"  # the instruction: Pass or Repair
        assert body["pressure_test"]["passed"] is True  # the pressure test's own result
        assert body["pressure_test"]["hold_time_seconds"] == 300
        assert body["pressure_test"]["measurements"] == complete()
        assert body["status"] == "DRAFT"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad",
    [
        {"test_duration_minutes": 7},
        {"ohms_total": -1},
        {"working_pressure_kpa": 0},
        {"certificate_result": "REPAIR"},
        {"conditions": {"made_up": "PASS"}},
        {"conditions": {"kink_or_dent": "MAYBE"}},
        {"schema_version": 9},
    ],
)
async def test_invalid_measurements_are_rejected_with_a_validation_error(
    bad: dict[str, Any],
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        response = await create_draft(
            client,
            seeded_sync_session["vopak_asset_id"],
            test=pressure_test(complete(**bad)),
        )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_an_unknown_instruction_is_rejected_and_pass_and_repair_are_accepted(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        bad = await create_draft(
            client, seeded_sync_session["vopak_asset_id"], result="MAYBE", test=None
        )
    assert bad.status_code == 422, bad.text


@pytest.mark.asyncio
async def test_the_test_time_must_match_the_hold_time(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        response = await create_draft(
            client,
            seeded_sync_session["vopak_asset_id"],
            test=pressure_test(
                complete(test_duration_minutes=10), hold_time_seconds=300
            ),
        )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_the_old_required_pressure_key_is_stored_as_the_working_pressure(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        response = await create_draft(
            client,
            seeded_sync_session["vopak_asset_id"],
            test=pressure_test({"required_pressure_kpa": 1500}),
        )
    assert response.status_code == 201, response.text
    assert response.json()["pressure_test"]["measurements"] == {
        "working_pressure_kpa": 1500
    }


@pytest.mark.asyncio
async def test_submission_needs_a_complete_form_then_review_and_approval_follow(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    partial = complete()
    partial.pop("ohms_total")
    partial["conditions"].pop("kink_or_dent")
    async with api_client(session_factory, INSPECTOR) as client:
        created = await create_draft(
            client,
            seeded_sync_session["vopak_asset_id"],
            test=pressure_test(partial),
        )
        inspection_id = created.json()["id"]
        refused = await client.post(f"/api/v1/inspections/{inspection_id}/submit")
        # Fill the gaps on the same draft, as the form does.
        patched = await client.patch(
            f"/api/v1/inspections/{inspection_id}",
            json={"pressure_test": pressure_test(complete())},
        )
        submitted = await client.post(f"/api/v1/inspections/{inspection_id}/submit")

    assert refused.status_code == 422, refused.text
    assert "Ohms total" in refused.json()["detail"]
    assert "Evidence of kink or dent damage" in refused.json()["detail"]
    assert patched.status_code == 200, patched.text
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["status"] == "SUBMITTED"

    async with api_client(session_factory, REVIEWER) as client:
        review = await client.get(f"/api/v1/inspections/{inspection_id}")
        approved = await client.post(f"/api/v1/inspections/{inspection_id}/approve")
    assert review.json()["pressure_test"]["measurements"] == complete()
    assert review.json()["result"] == "PASS"
    assert approved.status_code == 200, approved.text

    async with session_factory() as session:
        actions = set(
            (
                await session.scalars(
                    select(AuditEvent.action).where(
                        AuditEvent.entity_id == inspection_id
                    )
                )
            ).all()
        )
        assert {"inspection.submitted", "inspection.approved"} <= actions
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_a_legacy_inspection_still_submits_without_the_new_fields(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        created = await create_draft(
            client,
            seeded_sync_session["vopak_asset_id"],
            result="REVIEW",
            test=pressure_test({"leak": "none"}),
        )
        submitted = await client.post(
            f"/api/v1/inspections/{created.json()['id']}/submit"
        )
    assert submitted.status_code == 200, submitted.text


async def push(
    client: Any, context: dict[str, Any], *operations: dict[str, Any]
) -> list[dict[str, Any]]:
    response = await client.post(
        "/api/v1/sync/push",
        headers=sync_headers(),
        json={
            "operations": [
                {"work_context": context, "op": "create", **operation}
                for operation in operations
            ]
        },
    )
    assert response.status_code == 200, response.text
    results: list[dict[str, Any]] = response.json()["results"]
    return results


async def work_context(client: Any) -> dict[str, Any]:
    bootstrap = await client.get("/api/v1/sync/bootstrap", headers=sync_headers())
    context: dict[str, Any] = bootstrap.json()["work_contexts"][0]
    return context


def inspection_op(
    op_id: str, entity_id: str, context: dict[str, Any], **payload: Any
) -> dict[str, Any]:
    return {
        "op_id": op_id,
        "idempotency_key": op_id,
        "entity": "Inspection",
        "entity_id": entity_id,
        "payload": {
            "asset_id": context["asset_id"],
            "inspection_type": "SERVICE",
            **payload,
        },
    }


@pytest.mark.asyncio
async def test_the_offline_inspector_pushes_the_whole_form_and_it_is_stored_as_sent(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        results = await push(
            client,
            context,
            inspection_op(
                "form-1",
                "sync-form-1",
                context,
                result="REPAIR",
                pressure_test=pressure_test(complete()),
            ),
        )
        reloaded = await client.get("/api/v1/inspections/sync-form-1")
    assert results[0]["status"] == "applied", results
    assert reloaded.json()["result"] == "REPAIR"
    assert reloaded.json()["pressure_test"]["measurements"] == complete()


@pytest.mark.asyncio
async def test_bad_measurements_in_a_sync_push_are_rejected_and_leave_nothing(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        results = await push(
            client,
            context,
            inspection_op(
                "bad-1",
                "sync-bad-1",
                context,
                pressure_test=pressure_test(complete(test_duration_minutes=3)),
            ),
        )
    assert results[0]["status"] == "rejected"
    assert "test_duration_minutes" in results[0]["error"]
    async with session_factory() as session:
        assert await session.get(Inspection, "sync-bad-1") is None


@pytest.mark.asyncio
async def test_a_sync_push_can_submit_a_complete_inspection_for_review(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        results = await push(
            client,
            context,
            inspection_op(
                "sub-1",
                "sync-sub-1",
                context,
                status="SUBMITTED",
                result="PASS",
                pressure_test=pressure_test(complete()),
            ),
        )
    assert results[0]["status"] == "applied", results
    async with session_factory() as session:
        inspection = await session.get(Inspection, "sync-sub-1")
        assert inspection is not None
        assert inspection.status == "SUBMITTED"
        assert inspection.submitted_at is not None
        events = (
            await session.scalars(
                select(OutboxEvent.event_type).where(
                    OutboxEvent.aggregate_id == "sync-sub-1"
                )
            )
        ).all()
        assert list(events) == ["INSPECTION_SUBMITTED"]
        audit = set(
            (
                await session.scalars(
                    select(AuditEvent.action).where(
                        AuditEvent.entity_id == "sync-sub-1"
                    )
                )
            ).all()
        )
        assert "inspection.submitted" in audit
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_a_sync_submit_of_an_incomplete_form_is_rejected_and_stays_a_draft(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    partial = complete()
    partial.pop("ohms_end_a")
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        results = await push(
            client,
            context,
            inspection_op(
                "inc-1",
                "sync-inc-1",
                context,
                status="SUBMITTED",
                result="PASS",
                pressure_test=pressure_test(partial),
            ),
        )
    assert results[0]["status"] == "rejected"
    assert "Ohms end A" in results[0]["error"]
    async with session_factory() as session:
        assert await session.get(Inspection, "sync-inc-1") is None


@pytest.mark.asyncio
async def test_a_draft_saved_offline_can_be_updated_then_submitted_by_sync(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    partial = complete()
    partial.pop("certificate_result")
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        created = await push(
            client,
            context,
            inspection_op(
                "d-1",
                "sync-d-1",
                context,
                result="PASS",
                pressure_test=pressure_test(partial),
            ),
        )
        version = created[0]["version"]
        refused = await client.post(
            "/api/v1/sync/push",
            headers=sync_headers(),
            json={
                "operations": [
                    {
                        "op_id": "d-2",
                        "idempotency_key": "d-2",
                        "entity": "Inspection",
                        "entity_id": "sync-d-1",
                        "op": "update",
                        "base_version": version,
                        "work_context": context,
                        "payload": {"status": "SUBMITTED"},
                    }
                ]
            },
        )
        accepted = await client.post(
            "/api/v1/sync/push",
            headers=sync_headers(),
            json={
                "operations": [
                    {
                        "op_id": "d-3",
                        "idempotency_key": "d-3",
                        "entity": "Inspection",
                        "entity_id": "sync-d-1",
                        "op": "update",
                        "base_version": version,
                        "work_context": context,
                        "payload": {
                            "status": "SUBMITTED",
                            "pressure_test": pressure_test(complete()),
                        },
                    }
                ]
            },
        )
    assert created[0]["status"] == "applied"
    assert refused.json()["results"][0]["status"] == "rejected"
    assert "Certificate result" in refused.json()["results"][0]["error"]
    assert accepted.json()["results"][0]["status"] == "applied", accepted.text
    async with session_factory() as session:
        inspection = await session.get(Inspection, "sync-d-1")
        assert inspection is not None and inspection.status == "SUBMITTED"


@pytest.mark.asyncio
async def test_the_certificate_carries_the_working_and_test_pressure_and_its_own_result(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    from datetime import UTC, datetime

    async with api_client(session_factory, INSPECTOR) as client:
        created = await create_draft(
            client,
            seeded_sync_session["vopak_asset_id"],
            result="REPAIR",
            test=pressure_test(complete(certificate_result="FAIL")),
        )
    async with session_factory() as session:
        inspection = await session.get(Inspection, created.json()["id"])
        assert inspection is not None
        facts = build_facts(
            inspection,
            certificate_number="C-1",
            certificate_version=1,
            status="ISSUED",
            issued_at=datetime(2026, 1, 1, tzinfo=UTC),
            valid_until=None,
            public_token="t",
            verify_url="https://example.test/v/t",
            issued_by_name="Reviewer",
            issuer_name="Issuer",
            issuer_identifier="ABN",
        )
    assert facts.pressure is not None
    assert facts.pressure.working_pressure_kpa == 1500
    assert facts.pressure.test_pressure_kpa == 2250
    assert facts.pressure.applied_pressure_kpa == 2250
    # The certificate prints the certificate result, not the inspection instruction.
    assert facts.inspection_result == "FAIL"


@pytest.mark.asyncio
async def test_an_asset_reports_the_product_rating_for_its_own_bore(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
) -> None:
    from hms_backend.app.modules.assets.models import AssetEndConfiguration
    from hms_backend.app.modules.products.models import ProductPressureRating
    from hms_backend.app.modules.reference.models import NominalBore

    async with session_factory() as session:
        two_inch = NominalBore(code="2IN", label="2 inch")
        four_inch = NominalBore(code="4IN", label="4 inch")
        session.add_all([two_inch, four_inch])
        await session.flush()
        session.add_all(
            [
                ProductPressureRating(
                    product_id=seeded_sync_session["product_id"],
                    nominal_bore_id=two_inch.id,
                    working_pressure_kpa=1500,
                    test_pressure_kpa=2250,
                ),
                ProductPressureRating(
                    product_id=seeded_sync_session["product_id"],
                    nominal_bore_id=four_inch.id,
                    working_pressure_kpa=1000,
                    test_pressure_kpa=1500,
                ),
            ]
        )
        session.add(
            AssetEndConfiguration(
                asset_id=seeded_sync_session["vopak_asset_id"],
                end="A",
                nominal_bore_id=four_inch.id,
            )
        )
        await session.commit()
        four_inch_id = four_inch.id

    admin = Principal(
        user_id="admin-1", roles=frozenset({Role.HMS_ADMIN}), customer_ids=frozenset()
    )
    async with api_client(session_factory, admin) as client:
        detail = await client.get(
            f"/api/v1/assets/{seeded_sync_session['vopak_asset_id']}"
        )
        listed = await client.get("/api/v1/assets", params={"limit": 100})
        unrated = await client.get(
            f"/api/v1/assets/{seeded_sync_session['orica_asset_id']}"
        )

    expected = {
        "nominal_bore_id": four_inch_id,
        "working_pressure_kpa": 1000,  # the 4 inch rating, not the 2 inch one
        "test_pressure_kpa": 1500,
    }
    assert detail.json()["pressure_rating"] == expected
    rated = next(
        item
        for item in listed.json()["items"]
        if item["id"] == seeded_sync_session["vopak_asset_id"]
    )
    assert rated["pressure_rating"] == expected
    # No rating for this asset: null, so the form asks for the value instead of
    # inventing a default.
    assert unrated.json()["pressure_rating"] is None


@pytest.mark.asyncio
async def test_the_offline_inspector_receives_the_rating_inside_the_asset_record(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    from hms_backend.app.modules.assets.models import AssetEndConfiguration
    from hms_backend.app.modules.products.models import ProductPressureRating
    from hms_backend.app.modules.reference.models import NominalBore

    async with session_factory() as session:
        bore = NominalBore(code="2IN", label="2 inch")
        session.add(bore)
        await session.flush()
        session.add_all(
            [
                ProductPressureRating(
                    product_id=seeded_sync_session["product_id"],
                    nominal_bore_id=bore.id,
                    working_pressure_kpa=1500,
                    test_pressure_kpa=2250,
                ),
                AssetEndConfiguration(
                    asset_id=seeded_sync_session["vopak_asset_id"],
                    end="B",
                    nominal_bore_id=bore.id,
                ),
            ]
        )
        await session.commit()
        bore_id = bore.id

    async with api_client(session_factory, INSPECTOR) as client:
        bootstrap = await client.get("/api/v1/sync/bootstrap", headers=sync_headers())
    asset_record = next(
        record
        for record in bootstrap.json()["records"]
        if record["entity"] == "Asset"
        and record["entity_id"] == seeded_sync_session["vopak_asset_id"]
    )
    # End B is used when end A has no bore recorded.
    assert asset_record["payload"]["pressure_rating"] == {
        "nominal_bore_id": bore_id,
        "working_pressure_kpa": 1500,
        "test_pressure_kpa": 2250,
    }


async def _approve_and_events(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    asset_id: str,
    *,
    result: str,
    measurements: dict[str, Any],
) -> list[str]:
    async with api_client(session_factory, INSPECTOR) as client:
        created = await create_draft(
            client, asset_id, result=result, test=pressure_test(measurements)
        )
        inspection_id = created.json()["id"]
        submitted = await client.post(f"/api/v1/inspections/{inspection_id}/submit")
        assert submitted.status_code == 200, submitted.text
    async with api_client(session_factory, REVIEWER) as client:
        approved = await client.post(f"/api/v1/inspections/{inspection_id}/approve")
        assert approved.status_code == 200, approved.text
    async with session_factory() as session:
        return list(
            (
                await session.scalars(
                    select(OutboxEvent.event_type)
                    .where(OutboxEvent.aggregate_id == inspection_id)
                    .order_by(OutboxEvent.occurred_at)
                )
            ).all()
        )


@pytest.mark.asyncio
async def test_a_failed_certificate_result_still_raises_the_failed_inspection_alert(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    # On the customer's form the instruction is Pass or Repair and the failure is the
    # certificate result, so the alert cannot key on the instruction alone.
    events = await _approve_and_events(
        session_factory,
        seeded_sync_session["vopak_asset_id"],
        result="REPAIR",
        measurements=complete(certificate_result="FAIL"),
    )
    assert events == [
        "INSPECTION_SUBMITTED",
        "INSPECTION_APPROVED",
        "INSPECTION_FAILED",
    ]


@pytest.mark.asyncio
async def test_a_passing_certificate_result_raises_no_failed_inspection_alert(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    events = await _approve_and_events(
        session_factory,
        seeded_sync_session["vopak_asset_id"],
        result="REPAIR",
        measurements=complete(certificate_result="PASS"),
    )
    assert "INSPECTION_FAILED" not in events


@pytest.mark.asyncio
async def test_a_legacy_failed_result_still_raises_the_alert(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    events = await _approve_and_events(
        session_factory,
        seeded_sync_session["vopak_asset_id"],
        result="FAIL",
        measurements={"leak": "yes"},
    )
    assert "INSPECTION_FAILED" in events


@pytest.mark.asyncio
async def test_a_draft_with_no_pressure_test_cannot_be_submitted(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        created = await create_draft(
            client, seeded_sync_session["vopak_asset_id"], result="PASS", test=None
        )
        inspection_id = created.json()["id"]
        refused = await client.post(f"/api/v1/inspections/{inspection_id}/submit")
        reloaded = await client.get(f"/api/v1/inspections/{inspection_id}")

    assert refused.status_code == 422, refused.text
    assert "Pressure test" in refused.json()["detail"]
    assert reloaded.json()["status"] == "DRAFT"
    assert reloaded.json()["submitted_at"] is None
    async with session_factory() as session:
        events = (
            await session.scalars(
                select(OutboxEvent.event_type).where(
                    OutboxEvent.aggregate_id == inspection_id
                )
            )
        ).all()
    assert list(events) == []  # no reviewer notification for a refused submission


@pytest.mark.asyncio
async def test_a_sync_create_that_submits_with_no_pressure_test_is_rejected(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        results = await push(
            client,
            context,
            inspection_op(
                "np-1", "sync-np-1", context, status="SUBMITTED", result="PASS"
            ),
        )
    assert results[0]["status"] == "rejected"
    assert "Pressure test" in results[0]["error"]
    async with session_factory() as session:
        assert await session.get(Inspection, "sync-np-1") is None


@pytest.mark.asyncio
async def test_a_sync_update_cannot_submit_a_draft_that_has_no_pressure_test(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        created = await push(
            client,
            context,
            inspection_op("np-2", "sync-np-2", context, result="PASS"),
        )
        refused = await client.post(
            "/api/v1/sync/push",
            headers=sync_headers(),
            json={
                "operations": [
                    {
                        "op_id": "np-3",
                        "idempotency_key": "np-3",
                        "entity": "Inspection",
                        "entity_id": "sync-np-2",
                        "op": "update",
                        "base_version": created[0]["version"],
                        "work_context": context,
                        "payload": {"status": "SUBMITTED"},
                    }
                ]
            },
        )
    assert created[0]["status"] == "applied"
    result = refused.json()["results"][0]
    assert result["status"] == "rejected"
    assert "Pressure test" in result["error"]
    async with session_factory() as session:
        inspection = await session.get(Inspection, "sync-np-2")
        assert inspection is not None
        assert inspection.status == "DRAFT"
        assert inspection.submitted_at is None
