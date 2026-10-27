"""The inspection lifecycle: DRAFT -> IN_PROGRESS -> SUBMITTED -> APPROVED, with rework.

    SUBMITTED -> REJECTED -> IN_PROGRESS -> SUBMITTED -> APPROVED

Every step is one explicit, audited transition; an illegal one is a 409 and changes
nothing. The offline inspector, which predates IN_PROGRESS, still submits straight from
its draft: the server treats that as an atomic start and submit.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from test_inspection_form import (  # noqa: F401
    INSPECTOR,
    REVIEWER,
    complete,
    create_draft,
    inspection_op,
    pressure_test,
    push,
    work_context,
)
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
from hms_backend.app.modules.inspections.models import Inspection
from hms_backend.app.modules.notifications.models import OutboxEvent

OTHER_INSPECTOR = Principal(
    user_id="inspector-2", roles=frozenset({Role.INSPECTOR}), customer_ids=frozenset()
)
SUPER = Principal(
    user_id="super-1", roles=frozenset({Role.SUPER_ADMIN}), customer_ids=frozenset()
)
ADMIN = Principal(
    user_id="admin-1", roles=frozenset({Role.HMS_ADMIN}), customer_ids=frozenset()
)
CUSTOMER = Principal(
    user_id="customer-1",
    roles=frozenset({Role.CUSTOMER_USER}),
    customer_ids=frozenset({"someone"}),
)


def url(inspection_id: str, action: str = "") -> str:
    return f"/api/v1/inspections/{inspection_id}" + (f"/{action}" if action else "")


async def draft(client: Any, seeded: dict[str, str], **kwargs: Any) -> str:
    created = await create_draft(
        client,
        seeded["vopak_asset_id"],
        test=pressure_test(complete()),
        **kwargs,
    )
    assert created.status_code == 201, created.text
    assert created.json()["status"] == "DRAFT"
    inspection_id: str = created.json()["id"]
    return inspection_id


async def status_of(client: Any, inspection_id: str) -> str:
    response = await client.get(url(inspection_id))
    assert response.status_code == 200, response.text
    return str(response.json()["status"])


async def submitted(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded: dict[str, str],
) -> str:
    async with api_client(session_factory, INSPECTOR) as client:
        inspection_id = await draft(client, seeded)
        assert (await client.post(url(inspection_id, "start"))).status_code == 200
        assert (await client.post(url(inspection_id, "submit"))).status_code == 200
    return inspection_id


async def rejected(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded: dict[str, str],
    reason: str = "Re-test the hold time",
) -> str:
    inspection_id = await submitted(session_factory, seeded)
    async with api_client(session_factory, REVIEWER) as client:
        response = await client.post(
            url(inspection_id, "reject"), json={"reason": reason}
        )
        assert response.status_code == 200, response.text
    return inspection_id


# --- the forward path ---
@pytest.mark.asyncio
async def test_start_moves_a_draft_to_in_progress_and_sets_started_at(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        inspection_id = await draft(client, seeded_sync_session)
        started = await client.post(url(inspection_id, "start"))
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "IN_PROGRESS"
    assert started.json()["started_at"] is not None


@pytest.mark.asyncio
async def test_a_draft_cannot_be_submitted_or_edited_through_the_api(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        inspection_id = await draft(client, seeded_sync_session)
        submit = await client.post(url(inspection_id, "submit"))
        patch = await client.patch(url(inspection_id), json={"result": "PASS"})
        status = await status_of(client, inspection_id)
    assert submit.status_code == 409
    assert patch.status_code == 409
    assert status == "DRAFT"


@pytest.mark.asyncio
async def test_an_incomplete_in_progress_inspection_is_refused_and_stays_in_progress(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    partial = complete()
    partial.pop("ohms_total")
    async with api_client(session_factory, INSPECTOR) as client:
        created = await create_draft(
            client, seeded_sync_session["vopak_asset_id"], test=pressure_test(partial)
        )
        inspection_id = created.json()["id"]
        await client.post(url(inspection_id, "start"))
        refused = await client.post(url(inspection_id, "submit"))
        status = await status_of(client, inspection_id)
    assert refused.status_code == 422, refused.text
    assert status == "IN_PROGRESS"


@pytest.mark.asyncio
async def test_in_progress_submits_then_the_reviewer_approves(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    inspection_id = await submitted(session_factory, seeded_sync_session)
    async with api_client(session_factory, REVIEWER) as client:
        approved = await client.post(url(inspection_id, "approve"))
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "APPROVED"


@pytest.mark.asyncio
async def test_a_reviewer_can_reject_only_with_a_reason_and_it_is_kept(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    inspection_id = await submitted(session_factory, seeded_sync_session)
    async with api_client(session_factory, REVIEWER) as client:
        for body in ({}, {"reason": ""}, {"reason": "   "}):
            refused = await client.post(url(inspection_id, "reject"), json=body)
            assert refused.status_code == 422, body
        assert await status_of(client, inspection_id) == "SUBMITTED"
        rejected_response = await client.post(
            url(inspection_id, "reject"), json={"reason": "  Hold time too short  "}
        )
        reloaded = await client.get(url(inspection_id))
    assert rejected_response.status_code == 200
    for body in (rejected_response.json(), reloaded.json()):
        assert body["status"] == "REJECTED"
        assert body["rejection_reason"] == "Hold time too short"
        assert body["rejected_at"] is not None
        assert body["reviewer_user_id"] == "reviewer-1"


# --- rejection, rework and resubmission ---
@pytest.mark.asyncio
async def test_a_rejected_inspection_is_locked_until_rework_begins(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    inspection_id = await rejected(session_factory, seeded_sync_session)
    async with api_client(session_factory, INSPECTOR) as client:
        submit = await client.post(url(inspection_id, "submit"))
        patch = await client.patch(url(inspection_id), json={"result": "PASS"})
        start = await client.post(url(inspection_id, "start"))
        status = await status_of(client, inspection_id)
    assert (submit.status_code, patch.status_code, start.status_code) == (409, 409, 409)
    assert status == "REJECTED"


@pytest.mark.asyncio
async def test_rework_is_explicit_keeps_started_at_and_clears_the_round(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    inspection_id = await rejected(session_factory, seeded_sync_session)
    async with session_factory() as session:
        before = await session.get(Inspection, inspection_id)
        assert before is not None
        started_at = before.started_at
        assert started_at is not None
    async with api_client(session_factory, INSPECTOR) as client:
        reworked = await client.post(url(inspection_id, "rework"))
        edited = await client.patch(url(inspection_id), json={"result": "REPAIR"})
    assert reworked.status_code == 200, reworked.text
    body = reworked.json()
    assert body["status"] == "IN_PROGRESS"
    assert body["rejected_at"] is None and body["submitted_at"] is None
    assert body["rejection_reason"] is None
    assert edited.status_code == 200  # editable again, because rework began
    async with session_factory() as session:
        after = await session.get(Inspection, inspection_id)
        assert after is not None
        assert after.started_at == started_at  # set exactly once
        event = (
            await session.scalars(
                select(AuditEvent).where(
                    AuditEvent.entity_id == inspection_id,
                    AuditEvent.action == "inspection.rework_started",
                )
            )
        ).one()
        # What the round looked like is not lost: the audit event keeps it.
        assert event.before is not None
        assert event.before["status"] == "REJECTED"
        assert event.before["rejection_reason"] == "Re-test the hold time"
        assert event.before["rejected_at"] is not None


@pytest.mark.asyncio
async def test_a_reworked_inspection_resubmits_and_is_approved_with_a_full_audit_trail(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    inspection_id = await rejected(session_factory, seeded_sync_session)
    async with api_client(session_factory, INSPECTOR) as client:
        assert (await client.post(url(inspection_id, "rework"))).status_code == 200
        resubmitted = await client.post(url(inspection_id, "submit"))
    assert resubmitted.status_code == 200, resubmitted.text
    assert resubmitted.json()["status"] == "SUBMITTED"
    async with api_client(session_factory, REVIEWER) as client:
        approved = await client.post(url(inspection_id, "approve"))
    assert approved.status_code == 200
    async with session_factory() as session:
        actions = [
            action
            for action in (
                await session.scalars(
                    select(AuditEvent.action)
                    .where(AuditEvent.entity_id == inspection_id)
                    .order_by(AuditEvent.sequence)
                )
            ).all()
            if action != "inspection.created" and not action.startswith("pressure_test")
        ]
        assert actions == [
            "inspection.started",
            "inspection.submitted",
            "inspection.rejected",
            "inspection.rework_started",
            "inspection.submitted",
            "inspection.approved",
        ]
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_an_approved_inspection_is_final(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    inspection_id = await submitted(session_factory, seeded_sync_session)
    async with api_client(session_factory, REVIEWER) as client:
        assert (await client.post(url(inspection_id, "approve"))).status_code == 200
        again = await client.post(url(inspection_id, "approve"))
        reject = await client.post(url(inspection_id, "reject"), json={"reason": "x"})
    # The inspector's assignment ends with the approval, so for them it is gone (404);
    # someone who can still see it finds every step refused.
    async with api_client(session_factory, SUPER) as client:
        results = [
            (await client.post(url(inspection_id, action))).status_code
            for action in ("start", "rework", "submit")
        ]
        patch = await client.patch(url(inspection_id), json={"result": "PASS"})
    assert again.status_code == reject.status_code == patch.status_code == 409
    assert results == [409, 409, 409]


@pytest.mark.asyncio
async def test_repeating_a_step_conflicts_instead_of_applying_twice(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        inspection_id = await draft(client, seeded_sync_session)
        first = await client.post(url(inspection_id, "start"))
        second = await client.post(url(inspection_id, "start"))
        submit_one = await client.post(url(inspection_id, "submit"))
        submit_two = await client.post(url(inspection_id, "submit"))
    assert (first.status_code, second.status_code) == (200, 409)
    assert (submit_one.status_code, submit_two.status_code) == (200, 409)
    async with api_client(session_factory, REVIEWER) as client:
        approve_one = await client.post(url(inspection_id, "approve"))
        approve_two = await client.post(url(inspection_id, "approve"))
    assert (approve_one.status_code, approve_two.status_code) == (200, 409)
    async with session_factory() as session:
        actions = (
            await session.scalars(
                select(AuditEvent.action).where(AuditEvent.entity_id == inspection_id)
            )
        ).all()
        # Each transition left exactly one event: nothing was applied twice.
        for action in (
            "inspection.started",
            "inspection.submitted",
            "inspection.approved",
        ):
            assert list(actions).count(action) == 1, action


@pytest.mark.asyncio
async def test_a_duplicate_rework_conflicts(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    inspection_id = await rejected(session_factory, seeded_sync_session)
    async with api_client(session_factory, INSPECTOR) as client:
        first = await client.post(url(inspection_id, "rework"))
        second = await client.post(url(inspection_id, "rework"))
    assert (first.status_code, second.status_code) == (200, 409)


# --- who may do what, and to which inspection ---
@pytest.mark.asyncio
async def test_each_step_needs_its_own_permission(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        inspection_id = await draft(client, seeded_sync_session)
    # Everyone but an inspector-capable role is refused the working steps on a draft.
    for who in (REVIEWER, ADMIN, CUSTOMER):
        async with api_client(session_factory, who) as client:
            assert (await client.post(url(inspection_id, "start"))).status_code == 403
    async with api_client(session_factory, INSPECTOR) as client:
        assert (await client.post(url(inspection_id, "start"))).status_code == 200
        assert (await client.post(url(inspection_id, "submit"))).status_code == 200
        # An inspector does not review their own work.
        approve = await client.post(url(inspection_id, "approve"))
        reject = await client.post(url(inspection_id, "reject"), json={"reason": "no"})
    assert approve.status_code == reject.status_code == 403
    for who in (ADMIN, CUSTOMER):
        async with api_client(session_factory, who) as client:
            assert (await client.post(url(inspection_id, "approve"))).status_code == 403
    async with api_client(session_factory, REVIEWER) as client:
        # A reviewer reviews; they do not submit or rework.
        assert (await client.post(url(inspection_id, "submit"))).status_code == 403
        assert (
            await client.post(url(inspection_id, "reject"), json={"reason": "again"})
        ).status_code == 200
        assert (await client.post(url(inspection_id, "rework"))).status_code == 403
    for who in (ADMIN, CUSTOMER):
        async with api_client(session_factory, who) as client:
            assert (await client.post(url(inspection_id, "rework"))).status_code == 403


@pytest.mark.asyncio
async def test_an_inspector_acts_only_on_their_own_assignment(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        inspection_id = await draft(client, seeded_sync_session)
    async with api_client(session_factory, OTHER_INSPECTOR) as client:
        for action in ("start", "submit", "rework"):
            refused = await client.post(url(inspection_id, action))
            assert refused.status_code == 404, (
                action
            )  # not theirs: indistinguishable from absent
    async with api_client(session_factory, INSPECTOR) as client:
        assert await status_of(client, inspection_id) == "DRAFT"


# --- the offline inspector (compatibility bridge) ---
@pytest.mark.asyncio
async def test_an_offline_submit_from_a_draft_is_an_atomic_start_and_submit(
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
                "bridge-1",
                "sync-bridge-1",
                context,
                status="SUBMITTED",
                result="PASS",
                pressure_test=pressure_test(complete()),
            ),
        )
    assert results[0]["status"] == "applied", results
    async with session_factory() as session:
        inspection = await session.get(Inspection, "sync-bridge-1")
        assert inspection is not None
        assert inspection.status == "SUBMITTED"
        assert inspection.started_at is not None  # a real start, not a gap
        assert inspection.submitted_at is not None
        actions = [
            action
            for action in (
                await session.scalars(
                    select(AuditEvent.action)
                    .where(AuditEvent.entity_id == "sync-bridge-1")
                    .order_by(AuditEvent.sequence)
                )
            ).all()
            if action in {"inspection.started", "inspection.submitted"}
        ]
        assert actions == ["inspection.started", "inspection.submitted"]
        events = (
            await session.scalars(
                select(OutboxEvent.event_type).where(
                    OutboxEvent.aggregate_id == "sync-bridge-1"
                )
            )
        ).all()
        assert list(events) == ["INSPECTION_SUBMITTED"]
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_an_incomplete_offline_submit_is_rejected_and_leaves_no_bad_state(
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
                "bridge-2",
                "sync-bridge-2",
                context,
                status="SUBMITTED",
                result="PASS",
                pressure_test=pressure_test(partial),
            ),
        )
    assert results[0]["status"] == "rejected"
    async with session_factory() as session:
        assert await session.get(Inspection, "sync-bridge-2") is None


@pytest.mark.asyncio
async def test_the_offline_inspector_still_sees_and_edits_an_inspection_started_online(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    """It knows only DRAFT and SUBMITTED, so IN_PROGRESS reads to it as DRAFT."""
    async with api_client(session_factory, INSPECTOR) as client:
        inspection_id = await draft(client, seeded_sync_session)
        assert (await client.post(url(inspection_id, "start"))).status_code == 200
        bootstrap = await client.get("/api/v1/sync/bootstrap", headers=sync_headers())
        payloads = [
            record["payload"]
            for record in bootstrap.json()["records"]
            if record["entity"] == "Inspection" and record["entity_id"] == inspection_id
        ]
        assert [payload["status"] for payload in payloads] == ["DRAFT"]
        version = next(
            record["version"]
            for record in bootstrap.json()["records"]
            if record["entity"] == "Inspection" and record["entity_id"] == inspection_id
        )
        context = await work_context(client)
        update = await client.post(
            "/api/v1/sync/push",
            headers=sync_headers(),
            json={
                "operations": [
                    {
                        "op_id": "bridge-3",
                        "idempotency_key": "bridge-3",
                        "entity": "Inspection",
                        "entity_id": inspection_id,
                        "op": "update",
                        "base_version": version,
                        "work_context": context,
                        "payload": {"status": "SUBMITTED", "result": "PASS"},
                    }
                ]
            },
        )
    assert update.json()["results"][0]["status"] == "applied", update.text
    async with session_factory() as session:
        inspection = await session.get(Inspection, inspection_id)
        assert inspection is not None
        assert inspection.status == "SUBMITTED"
        started = (
            await session.scalars(
                select(AuditEvent.action).where(
                    AuditEvent.entity_id == inspection_id,
                    AuditEvent.action == "inspection.started",
                )
            )
        ).all()
        assert len(started) == 1  # already started online: not started a second time
