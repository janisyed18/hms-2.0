"""Sync protocol 3: the native inspection lifecycle, and protocol 2 left as it was.

Protocol 2 means "paged bootstrap" and still does: an inspection in progress reads to it
as a draft on every surface, and its draft-to-submitted bridge still starts and submits.
Protocol 3 carries the real status and an operation's lifecycle actions, applied in one
deterministic order after the whole sequence has been checked.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from test_inspection_form import (  # noqa: F401
    INSPECTOR,
    complete,
    inspection_op,
    pressure_test,
    work_context,
)
from test_inspection_lifecycle import (  # noqa: F401
    draft,
    rejected,
    url,
)
from test_sync_api import (  # noqa: F401
    api_client,
    assigned_inspector_booking,
    seeded_sync_session,
    session_factory,
    sync_headers,
)

from hms_backend.app.core.audit import verify_audit_chain
from hms_backend.app.models.foundation import AuditEvent
from hms_backend.app.modules.inspections.models import Inspection, PressureTestResult


def headers(protocol: int | None) -> dict[str, str]:
    base = sync_headers()
    return base if protocol is None else {**base, "X-HMS-Sync-Protocol": str(protocol)}


async def push_as(
    client: Any,
    protocol: int | None,
    context: dict[str, Any],
    *operations: dict[str, Any],
) -> list[dict[str, Any]]:
    response = await client.post(
        "/api/v1/sync/push",
        headers=headers(protocol),
        json={
            "operations": [
                {"work_context": context, **operation} for operation in operations
            ]
        },
    )
    assert response.status_code == 200, response.text
    results: list[dict[str, Any]] = response.json()["results"]
    return results


def native(
    op_id: str,
    entity_id: str,
    context: dict[str, Any],
    actions: list[str],
    *,
    op: str = "create",
    base_version: int | None = None,
    **payload: Any,
) -> dict[str, Any]:
    operation = inspection_op(op_id, entity_id, context, **payload)
    operation.update(op=op, base_version=base_version, lifecycle_actions=actions)
    if op == "update":
        operation["payload"].pop("asset_id")
        operation["payload"].pop("inspection_type")
    return operation


def form(**extra: Any) -> dict[str, Any]:
    return {"result": "PASS", "pressure_test": pressure_test(complete()), **extra}


async def audit_actions(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    entity_id: str,
) -> list[str]:
    async with session_factory() as session:
        return list(
            (
                await session.scalars(
                    select(AuditEvent.action)
                    .where(AuditEvent.entity_id == entity_id)
                    .order_by(AuditEvent.sequence)
                )
            ).all()
        )


async def create_started(client: Any, context: dict[str, Any], entity_id: str) -> int:
    results = await push_as(
        client, 3, context, native(f"c-{entity_id}", entity_id, context, ["start"])
    )
    assert results[0]["status"] == "applied", results
    return int(results[0]["version"])


# --- negotiation: paging stays protocol 2 ---
@pytest.mark.asyncio
async def test_each_protocol_gets_its_own_bootstrap_shape(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        legacy = (
            await client.get("/api/v1/sync/bootstrap", headers=headers(None))
        ).json()
        one = (await client.get("/api/v1/sync/bootstrap", headers=headers(1))).json()
        two = (await client.get("/api/v1/sync/bootstrap", headers=headers(2))).json()
        three = (await client.get("/api/v1/sync/bootstrap", headers=headers(3))).json()
        future = (await client.get("/api/v1/sync/bootstrap", headers=headers(9))).json()
    assert legacy["protocol_version"] == one["protocol_version"] == 1
    assert legacy["next_page_token"] is None and legacy["has_more"] is False
    assert two["protocol_version"] == 2
    assert three["protocol_version"] == 3
    # A newer client than this server is served at what the server speaks, and told so.
    assert future["protocol_version"] == 3


@pytest.mark.asyncio
async def test_a_protocol_2_client_still_pages_and_its_tokens_keep_working(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        seen: set[tuple[str, str]] = set()
        token = None
        pages = 0
        while True:
            params: dict[str, Any] = {"limit": 2}
            if token:
                params["page_token"] = token
            page = (
                await client.get(
                    "/api/v1/sync/bootstrap", headers=headers(2), params=params
                )
            ).json()
            assert page["protocol_version"] == 2
            seen.update((r["entity"], r["entity_id"]) for r in page["records"])
            pages += 1
            token = page["next_page_token"]
            if not token:
                break
        # A page token issued to protocol 3 is the same paging format.
        first = (
            await client.get(
                "/api/v1/sync/bootstrap", headers=headers(3), params={"limit": 2}
            )
        ).json()
        assert first["has_more"] and first["protocol_version"] == 3
        resumed = await client.get(
            "/api/v1/sync/bootstrap",
            headers=headers(3),
            params={"limit": 2, "page_token": first["next_page_token"]},
        )
    assert pages > 1 and seen
    assert resumed.status_code == 200


# --- what each protocol sees ---
@pytest.mark.asyncio
async def test_in_progress_reads_as_draft_to_protocol_2_and_for_real_to_protocol_3(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        inspection_id = await draft(client, seeded_sync_session)
        assert (await client.post(url(inspection_id, "start"))).status_code == 200
        context = await work_context(client)

        def status_in(records: list[dict[str, Any]]) -> list[str]:
            return [
                r["payload"]["status"]
                for r in records
                if r["entity"] == "Inspection" and r["entity_id"] == inspection_id
            ]

        for protocol, expected in (
            (None, "DRAFT"),
            (1, "DRAFT"),
            (2, "DRAFT"),
            (3, "IN_PROGRESS"),
        ):
            boot = await client.get("/api/v1/sync/bootstrap", headers=headers(protocol))
            assert status_in(boot.json()["records"]) == [expected], protocol
            changes = await client.get(
                "/api/v1/sync/changes",
                headers=headers(protocol),
                params={"since": 0, "limit": 500},
            )
            assert status_in(changes.json()["changes"])[-1] == expected, protocol

        # A stale update is a conflict that carries the server's row, projected too.
        version = next(
            r["version"]
            for r in (
                await client.get("/api/v1/sync/bootstrap", headers=headers(3))
            ).json()["records"]
            if r["entity"] == "Inspection" and r["entity_id"] == inspection_id
        )
        for protocol, expected in ((2, "DRAFT"), (3, "IN_PROGRESS")):
            stale = {
                "op_id": f"stale-{protocol}",
                "idempotency_key": f"stale-{protocol}",
                "entity": "Inspection",
                "entity_id": inspection_id,
                "op": "update",
                "base_version": version - 1,
                "payload": {"result": "PASS"},
            }
            result = (await push_as(client, protocol, context, stale))[0]
            assert result["status"] == "conflict"
            assert result["payload"]["status"] == expected, protocol


@pytest.mark.asyncio
async def test_protocol_3_returns_rejected_with_its_reason(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    inspection_id = await rejected(session_factory, seeded_sync_session, "Hold longer")
    async with api_client(session_factory, INSPECTOR) as client:
        boot = (await client.get("/api/v1/sync/bootstrap", headers=headers(3))).json()
    payload = next(
        r["payload"]
        for r in boot["records"]
        if r["entity"] == "Inspection" and r["entity_id"] == inspection_id
    )
    assert payload["status"] == "REJECTED"
    assert payload["rejection_reason"] == "Hold longer"


# --- the protocol-2 bridge is untouched ---
@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", [None, 2, 3])
async def test_the_draft_to_submitted_bridge_still_starts_and_submits(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
    protocol: int | None,
) -> None:
    entity_id = f"bridge-{protocol}"
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        op = inspection_op(
            entity_id,
            entity_id,
            context,
            status="SUBMITTED",
            result="PASS",
            pressure_test=pressure_test(complete()),
        )
        results = await push_as(client, protocol, context, {"op": "create", **op})
    assert results[0]["status"] == "applied", results
    actions = await audit_actions(session_factory, entity_id)
    assert [
        a for a in actions if a in {"inspection.started", "inspection.submitted"}
    ] == [
        "inspection.started",
        "inspection.submitted",
    ]


# --- native operations ---
@pytest.mark.asyncio
async def test_create_and_start_makes_it_in_progress_with_a_real_start(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        version = await create_started(client, context, "n-start")
    assert version >= 1
    async with session_factory() as session:
        inspection = await session.get(Inspection, "n-start")
        assert inspection is not None
        assert inspection.status == "IN_PROGRESS"
        assert inspection.started_at is not None
    assert "inspection.started" in await audit_actions(session_factory, "n-start")


@pytest.mark.asyncio
async def test_a_draft_cannot_be_edited_before_start(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        # Creating a shell is fine; recording work on it is not.
        shell = await push_as(
            client, 3, context, native("shell", "n-shell", context, [])
        )
        assert shell[0]["status"] == "applied", shell
        edit = await push_as(
            client,
            3,
            context,
            native(
                "edit",
                "n-shell",
                context,
                [],
                op="update",
                base_version=shell[0]["version"],
                **form(),
            ),
        )
        with_content = await push_as(
            client, 3, context, native("born", "n-born", context, [], **form())
        )
    assert edit[0]["status"] == "rejected"
    assert "Start the inspection" in edit[0]["error"]
    assert with_content[0]["status"] == "rejected"
    async with session_factory() as session:
        shell_row = await session.get(Inspection, "n-shell")
        assert shell_row is not None and shell_row.status == "DRAFT"
        assert shell_row.result is None
        assert await session.get(Inspection, "n-born") is None


@pytest.mark.asyncio
async def test_save_progress_persists_and_submit_checks_completeness(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    partial = complete()
    partial.pop("ohms_end_a")
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        version = await create_started(client, context, "n-progress")
        saved = (
            await push_as(
                client,
                3,
                context,
                native(
                    "save",
                    "n-progress",
                    context,
                    [],
                    op="update",
                    base_version=version,
                    result="PASS",
                    pressure_test=pressure_test(partial),
                ),
            )
        )[0]
        assert saved["status"] == "applied", saved
        refused = (
            await push_as(
                client,
                3,
                context,
                native(
                    "sub-bad",
                    "n-progress",
                    context,
                    ["submit"],
                    op="update",
                    base_version=saved["version"],
                ),
            )
        )[0]
        done = (
            await push_as(
                client,
                3,
                context,
                native(
                    "sub-ok",
                    "n-progress",
                    context,
                    ["submit"],
                    op="update",
                    base_version=saved["version"],
                    **form(),
                ),
            )
        )[0]
    assert refused["status"] == "rejected" and "incomplete" in refused["error"].lower()
    assert done["status"] == "applied" and done["payload"]["status"] == "SUBMITTED"
    async with session_factory() as session:
        inspection = await session.get(Inspection, "n-progress")
        assert inspection is not None and inspection.submitted_at is not None


@pytest.mark.asyncio
async def test_rework_is_explicit_and_resubmit_clears_the_guidance(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    inspection_id = await rejected(session_factory, seeded_sync_session, "Retest it")
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        boot = (await client.get("/api/v1/sync/bootstrap", headers=headers(3))).json()
        version = next(
            r["version"]
            for r in boot["records"]
            if r["entity"] == "Inspection" and r["entity_id"] == inspection_id
        )
        # Rejected is read-only until rework is begun.
        blocked = (
            await push_as(
                client,
                3,
                context,
                native(
                    "rw-bad",
                    inspection_id,
                    context,
                    [],
                    op="update",
                    base_version=version,
                    result="PASS",
                ),
            )
        )[0]
        begun = (
            await push_as(
                client,
                3,
                context,
                native(
                    "rw",
                    inspection_id,
                    context,
                    ["rework"],
                    op="update",
                    base_version=version,
                ),
            )
        )[0]
        resubmitted = (
            await push_as(
                client,
                3,
                context,
                native(
                    "rw-sub",
                    inspection_id,
                    context,
                    ["submit"],
                    op="update",
                    base_version=begun["version"],
                    **form(),
                ),
            )
        )[0]
    assert blocked["status"] == "rejected" and "Begin rework" in blocked["error"]
    assert begun["status"] == "applied"
    assert begun["payload"]["status"] == "IN_PROGRESS"
    assert begun["payload"]["rejection_reason"] == "Retest it"  # active guidance
    assert begun["payload"]["reviewer_user_id"] is None  # previous reviewer cleared
    assert resubmitted["payload"]["status"] == "SUBMITTED"
    assert resubmitted["payload"]["rejection_reason"] is None


@pytest.mark.asyncio
async def test_rework_then_submit_in_one_offline_operation(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    inspection_id = await rejected(session_factory, seeded_sync_session)
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        boot = (await client.get("/api/v1/sync/bootstrap", headers=headers(3))).json()
        version = next(
            r["version"]
            for r in boot["records"]
            if r["entity"] == "Inspection" and r["entity_id"] == inspection_id
        )
        result = (
            await push_as(
                client,
                3,
                context,
                native(
                    "rw-both",
                    inspection_id,
                    context,
                    ["rework", "submit"],
                    op="update",
                    base_version=version,
                    **form(),
                ),
            )
        )[0]
    assert result["status"] == "applied", result
    actions = await audit_actions(session_factory, inspection_id)
    assert (
        actions[-3:-1] == ["inspection.rework_started", "inspection.updated"]
        or "inspection.rework_started" in actions
    )
    assert actions[-1] == "inspection.submitted"


@pytest.mark.asyncio
async def test_an_offline_start_edit_submit_arrives_in_the_audited_order(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        result = (
            await push_as(
                client,
                3,
                context,
                native("all", "n-all", context, ["start", "submit"], **form()),
            )
        )[0]
    assert result["status"] == "applied", result
    actions = [
        a
        for a in await audit_actions(session_factory, "n-all")
        if a.startswith("inspection.")
    ]
    assert actions == [
        "inspection.created",
        "inspection.started",
        "inspection.submitted",
    ]
    async with session_factory() as session:
        order = (
            await session.scalars(
                select(AuditEvent.action).order_by(AuditEvent.sequence)
            )
        ).all()
        # The work is written between the start and the submit.
        started = list(order).index("inspection.started")
        submitted = list(order).index("inspection.submitted")
        assert "pressure_test_result.created" in list(order)[started:submitted]
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_an_illegal_sequence_is_refused_whole_and_writes_nothing(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        # Submit straight from a draft; rework without a rejection; submit not last.
        a = (
            await push_as(
                client, 3, context, native("i1", "n-i1", context, ["submit"], **form())
            )
        )[0]
        b = (
            await push_as(client, 3, context, native("i2", "n-i2", context, ["rework"]))
        )[0]
        c = (
            await push_as(
                client, 3, context, native("i3", "n-i3", context, ["submit", "start"])
            )
        )[0]
        version = await create_started(client, context, "n-i4")
        before = await audit_actions(session_factory, "n-i4")
        d = (
            await push_as(
                client,
                3,
                context,
                native(
                    "i4",
                    "n-i4",
                    context,
                    ["start"],
                    op="update",
                    base_version=version,
                    **form(),
                ),
            )
        )[0]
        after = await audit_actions(session_factory, "n-i4")
    assert [x["status"] for x in (a, b, c, d)] == ["rejected"] * 4
    assert before == after
    async with session_factory() as session:
        for missing in ("n-i1", "n-i2", "n-i3"):
            assert await session.get(Inspection, missing) is None
        assert (await session.scalars(select(PressureTestResult))).all() == []


@pytest.mark.asyncio
async def test_a_stale_version_conflicts_before_any_transition(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        version = await create_started(client, context, "n-stale")
        result = (
            await push_as(
                client,
                3,
                context,
                native(
                    "stale",
                    "n-stale",
                    context,
                    ["submit"],
                    op="update",
                    base_version=version + 5,
                    **form(),
                ),
            )
        )[0]
    assert result["status"] == "conflict"
    async with session_factory() as session:
        inspection = await session.get(Inspection, "n-stale")
        assert inspection is not None and inspection.status == "IN_PROGRESS"


@pytest.mark.asyncio
async def test_a_retried_operation_does_not_repeat_its_transitions(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        op = native("retry", "n-retry", context, ["start", "submit"], **form())
        first = (await push_as(client, 3, context, op))[0]
        again = (await push_as(client, 3, context, op))[0]
        changed = (
            await push_as(client, 3, context, {**op, "lifecycle_actions": ["start"]})
        )[0]
    assert first == again
    assert (
        changed["status"] == "rejected"
        and changed["error_code"] == "IDEMPOTENCY_KEY_REUSED"
    )
    actions = await audit_actions(session_factory, "n-retry")
    assert actions.count("inspection.started") == 1
    assert actions.count("inspection.submitted") == 1


@pytest.mark.asyncio
async def test_lifecycle_actions_need_protocol_3_and_no_status_beside_them(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        old = (
            await push_as(client, 2, context, native("p2", "n-p2", context, ["start"]))
        )[0]
        mixed = (
            await push_as(
                client,
                3,
                context,
                native("mx", "n-mx", context, ["start"], status="DRAFT"),
            )
        )[0]
    assert (
        old["status"] == "rejected"
        and old["error_code"] == "LIFECYCLE_PROTOCOL_REQUIRED"
    )
    assert mixed["status"] == "rejected"


@pytest.mark.asyncio
async def test_a_stale_assignment_is_refused_for_native_operations_too(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    seeded_sync_session: dict[str, str],  # noqa: F811
    assigned_inspector_booking: str,  # noqa: F811
) -> None:
    async with api_client(session_factory, INSPECTOR) as client:
        context = await work_context(client)
        stale = {**context, "revision_id": "an-older-revision"}
        result = (
            await push_as(client, 3, stale, native("old", "n-old", stale, ["start"]))
        )[0]
    assert result["status"] == "rejected"
    assert result["error_code"] == "WORK_CONTEXT_STALE"
    async with session_factory() as session:
        assert await session.get(Inspection, "n-old") is None
