"""The readiness report against real PostgreSQL: counts, read-only enforcement, secrecy.

The database is shared with other test modules, so every assertion is a delta against
a baseline taken before the fixture rows are committed.
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import delete, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncEngine,
    AsyncSession,
    create_async_engine,
)

import hms_backend.app.main  # noqa: F401  (registers every ORM model)
import hms_backend.app.tooling.notification_readiness as readiness
from hms_backend.app.modules.identity.models import (
    PasswordResetDelivery,
    PasswordResetToken,
    User,
)
from hms_backend.app.modules.notifications.models import Notification, OutboxEvent
from hms_backend.app.modules.notifications.outbox import RECEIPT_EVENT_TYPE

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)

SECRET_ADDRESS = "secret-recipient@readiness.example"
SECRET_BODY = "secret-body-text-7731"
SECRET_ERROR = "secret-error-text-5520"
SECRET_CIPHERTEXT = "secret-ciphertext-9914"


@pytest_asyncio.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    assert POSTGRES_URL is not None
    if not POSTGRES_URL.startswith("postgresql+asyncpg://"):
        raise ValueError("These tests require a dedicated async PostgreSQL database")
    database_name = make_url(POSTGRES_URL).database
    if database_name is None or not database_name.endswith("_test"):
        raise ValueError("These tests require a database name ending in _test")
    db = create_async_engine(POSTGRES_URL)
    try:
        async with db.connect() as connection:
            version = await connection.scalar(
                text("SELECT version_num FROM alembic_version")
            )
            head = ScriptDirectory.from_config(Config("alembic.ini")).get_current_head()
            assert version == head, "Migrate the test database first"
        yield db
    finally:
        await db.dispose()


async def _report(engine: AsyncEngine) -> dict[str, Any]:
    async with engine.connect() as conn:
        try:
            await readiness.begin_read_only(conn)
            return await readiness.collect(conn)
        finally:
            await conn.rollback()


def _notification(
    status: str, scheduled_for: datetime | None, **extra: object
) -> Notification:
    return Notification(
        event_ref=f"event-{uuid4().hex[:8]}",
        category="CERTIFICATE_ISSUED",
        tier="IMPORTANT",
        recipient_type="USER",
        recipient_id=str(uuid4()),
        recipient_address=SECRET_ADDRESS,
        channel="EMAIL",
        template_key="certificate_issued",
        subject="Certificate issued",
        body=SECRET_BODY,
        status=status,
        idempotency_key=uuid4().hex + uuid4().hex,
        scheduled_for=scheduled_for,
        **extra,
    )


def _outbox(*, processed: bool, error: str | None) -> OutboxEvent:
    return OutboxEvent(
        event_type="ReadinessProbe",
        aggregate_type="Probe",
        aggregate_id=str(uuid4()),
        payload={"secret": SECRET_BODY},
        dedupe_key=uuid4().hex,
        processed_at=datetime.now(UTC) if processed else None,
        error=error,
    )


def _reset_delivery(
    user: User, *, status: str, scheduled_for: datetime, ciphertext: str | None
) -> tuple[PasswordResetToken, PasswordResetDelivery]:
    token = PasswordResetToken(
        token_hash=uuid4().hex + uuid4().hex,
        user_id=user.id,
        expires_at=datetime.now(UTC) + timedelta(minutes=15),
    )
    delivery = PasswordResetDelivery(
        reset_id=token.id,
        recipient_email=SECRET_ADDRESS,
        ciphertext=ciphertext,
        key_version=1,
        status=status,
        scheduled_for=scheduled_for,
        error=SECRET_ERROR,
    )
    return token, delivery


@pytest_asyncio.fixture
async def seeded(engine: AsyncEngine) -> AsyncIterator[dict[str, Any]]:
    """Commit one row of every interesting kind; yield the baseline taken before."""
    baseline = await _report(engine)
    now = datetime.now(UTC)
    past, future = now - timedelta(hours=1), now + timedelta(hours=1)
    notifications = [
        _notification("SENDING", past),  # expired claim
        _notification("SENDING", future),  # live claim: a send in progress is fine
        _notification("PENDING", past),  # due
        _notification("PENDING", future),  # not yet due
        _notification("SENT", None),
    ]
    outbox = [
        _outbox(processed=True, error=SECRET_ERROR),  # recovered or retired: legitimate
        _outbox(processed=False, error=None),
        _outbox(processed=False, error=SECRET_ERROR),
    ]
    user = User(
        oidc_subject=f"readiness-{uuid4().hex}",
        email=f"readiness-{uuid4().hex[:8]}@example.com",
        role="HMS_ADMIN",
        password_hash="x",
    )
    async with AsyncSession(engine, expire_on_commit=False) as session:
        session.add_all([*notifications, *outbox, user])
        await session.flush()
        token_a, expired_reset = _reset_delivery(
            user, status="SENDING", scheduled_for=past, ciphertext=SECRET_CIPHERTEXT
        )
        token_b, sent_reset = _reset_delivery(
            user, status="SENT", scheduled_for=past, ciphertext=SECRET_CIPHERTEXT
        )
        session.add_all([token_a, token_b])
        await session.flush()
        expired_reset.reset_id, sent_reset.reset_id = token_a.id, token_b.id
        session.add_all([expired_reset, sent_reset])
        await session.commit()
    try:
        yield baseline
    finally:
        async with AsyncSession(engine) as session:
            await session.execute(
                delete(Notification).where(
                    Notification.id.in_([n.id for n in notifications])
                )
            )
            await session.execute(
                delete(OutboxEvent).where(OutboxEvent.id.in_([o.id for o in outbox]))
            )
            await session.execute(delete(User).where(User.id == user.id))
            await session.commit()


def _delta(after: dict[str, Any], before: dict[str, Any], *path: str) -> int:
    def dig(report: dict[str, Any]) -> int:
        node: Any = report
        for key in path:
            # A status with no rows is simply absent from by_status.
            node = node.get(key, 0) if isinstance(node, dict) else node
        return int(node)

    return dig(after) - dig(before)


@pytest.mark.asyncio
async def test_report_counts_each_kind_of_row(
    engine: AsyncEngine, seeded: dict[str, Any]
) -> None:
    after = await _report(engine)

    assert _delta(after, seeded, "notifications", "expired_sending") == 1
    assert _delta(after, seeded, "notifications", "by_status", "SENDING") == 2
    assert _delta(after, seeded, "notifications", "due_pending") == 1
    assert _delta(after, seeded, "notifications", "by_status", "PENDING") == 2
    assert _delta(after, seeded, "notifications", "by_status", "SENT") == 1
    assert _delta(after, seeded, "outbox", "unprocessed") == 2
    assert _delta(after, seeded, "outbox", "unprocessed_with_error") == 1
    assert _delta(after, seeded, "outbox", "processed_with_error") == 1
    assert _delta(after, seeded, "password_resets", "expired_sending") == 1
    assert (
        _delta(after, seeded, "password_resets", "finished_retaining_ciphertext") == 1
    )
    assert after["ready"] is False
    assert "notifications: expired SENDING claims" in after["blockers"]


@pytest.mark.asyncio
async def test_report_contains_no_addresses_bodies_errors_or_ciphertext(
    engine: AsyncEngine, seeded: dict[str, Any]
) -> None:
    del seeded
    rendered = json.dumps(await _report(engine))

    for secret in (SECRET_ADDRESS, SECRET_BODY, SECRET_ERROR, SECRET_CIPHERTEXT):
        assert secret not in rendered
    assert "@" not in rendered


@pytest.mark.asyncio
async def test_the_check_writes_nothing(
    engine: AsyncEngine, seeded: dict[str, Any]
) -> None:
    del seeded

    async def snapshot() -> tuple[object, ...]:
        async with engine.connect() as conn:
            return tuple(
                [
                    (
                        await conn.execute(
                            select(func.count(), func.coalesce(func.sum(m.attempts), 0))
                        )
                    ).one()
                    for m in (Notification, OutboxEvent, PasswordResetDelivery)
                ]
            )

    before = await snapshot()
    await _report(engine)
    assert await snapshot() == before


@pytest.mark.asyncio
async def test_the_transaction_rejects_writes(engine: AsyncEngine) -> None:
    async with engine.connect() as conn:
        await readiness.begin_read_only(conn)
        with pytest.raises(DBAPIError, match="read-only transaction"):
            await conn.execute(
                text("UPDATE notifications SET attempts = attempts WHERE false")
            )
        await conn.rollback()


class _IgnoresReadOnly:
    """A connection whose ``SET TRANSACTION READ ONLY`` silently does nothing."""

    def __init__(self, conn: AsyncConnection) -> None:
        self._conn = conn

    async def execute(self, statement: Any, *args: Any, **kwargs: Any) -> Any:
        if str(statement) == "SET TRANSACTION READ ONLY":
            statement = text("SELECT 1")
        return await self._conn.execute(statement, *args, **kwargs)


@pytest.mark.asyncio
async def test_a_connection_that_is_not_read_only_is_refused(
    engine: AsyncEngine,
) -> None:
    async with engine.connect() as conn:
        with pytest.raises(RuntimeError, match="read-only"):
            await readiness.begin_read_only(_IgnoresReadOnly(conn))  # type: ignore[arg-type]
        await conn.rollback()


async def _blockers_with(engine: AsyncEngine, event: OutboxEvent) -> int:
    before = await _report(engine)
    async with AsyncSession(engine, expire_on_commit=False) as session:
        session.add(event)
        await session.commit()
    try:
        after = await _report(engine)
    finally:
        async with AsyncSession(engine) as session:
            await session.execute(delete(OutboxEvent).where(OutboxEvent.id == event.id))
            await session.commit()
    # The shared database may hold unrelated rows; the event must change nothing.
    assert before["blockers"] == after["blockers"]
    # Outbox contents are only ever warnings (pending work), never blockers.
    assert not any(b.startswith("outbox") for b in after["blockers"])
    assert before["warnings"] == after["warnings"]
    return _delta(after, before, "outbox", "processed_with_error")


@pytest.mark.asyncio
async def test_a_retired_unmatched_receipt_does_not_make_readiness_false(
    engine: AsyncEngine,
) -> None:
    receipt = OutboxEvent(
        event_type=RECEIPT_EVENT_TYPE,
        aggregate_type="Notification",
        aggregate_id=str(uuid4()),
        payload={"provider_message_id": uuid4().hex},
        dedupe_key=uuid4().hex,
        processed_at=datetime.now(UTC),
        error="no matching notification",
    )
    delta = await _blockers_with(engine, receipt)
    assert delta == 1


@pytest.mark.asyncio
async def test_a_recovered_business_event_does_not_make_readiness_false(
    engine: AsyncEngine,
) -> None:
    recovered = _outbox(processed=True, error="failed once, then relayed")
    delta = await _blockers_with(engine, recovered)
    assert delta == 1


def _preview_user(*, deleted: bool = False) -> User:
    return User(
        oidc_subject=f"preview-{uuid4().hex}",
        email=f"preview-{uuid4().hex[:8]}@example.com",
        role="HMS_ADMIN",
        password_hash="x",
        deleted_at=datetime.now(UTC) if deleted else None,
    )


@pytest_asyncio.fixture
async def preview_rows(engine: AsyncEngine) -> AsyncIterator[dict[str, Any]]:
    """Unprocessed outbox rows and one due reset per dispatcher outcome."""
    baseline = await _report(engine)
    now = datetime.now(UTC)
    past, future = now - timedelta(hours=1), now + timedelta(hours=1)
    ids = [str(uuid4()) for _ in range(3)]
    events = [
        OutboxEvent(
            event_type="PreviewTypeA",
            aggregate_type="PreviewAggregateX",
            aggregate_id=ids[0],
            payload={"secret": SECRET_BODY},
            dedupe_key=uuid4().hex,
            occurred_at=now - timedelta(days=3),
        ),
        OutboxEvent(
            event_type="PreviewTypeA",
            aggregate_type="PreviewAggregateY",
            aggregate_id=ids[1],
            payload={},
            dedupe_key=uuid4().hex,
            occurred_at=now - timedelta(days=1),
        ),
        OutboxEvent(
            event_type="PreviewTypeB",
            aggregate_type="PreviewAggregateX",
            aggregate_id=ids[2],
            payload={},
            dedupe_key=uuid4().hex,
            occurred_at=now - timedelta(hours=2),
        ),
        OutboxEvent(  # processed rows are not part of the backlog
            event_type="PreviewTypeProcessed",
            aggregate_type="PreviewAggregateX",
            aggregate_id=str(uuid4()),
            payload={},
            dedupe_key=uuid4().hex,
            processed_at=now,
        ),
    ]
    live, gone = _preview_user(), _preview_user(deleted=True)
    plans: list[tuple[User, dict[str, Any], str | None]] = [
        (live, {}, SECRET_CIPHERTEXT),  # valid
        (live, {"superseded_at": past}, SECRET_CIPHERTEXT),  # superseded
        # Superseded is checked before the user, so this is superseded, not
        # user_unavailable (the dispatcher's order).
        (gone, {"superseded_at": past}, SECRET_CIPHERTEXT),
        (live, {"consumed_at": past}, SECRET_CIPHERTEXT),  # consumed
        (live, {"expires_at": past}, SECRET_CIPHERTEXT),  # expired
        (gone, {}, SECRET_CIPHERTEXT),  # user_unavailable
        (live, {}, None),  # not_selected_ciphertext_missing: never picked up
    ]
    async with AsyncSession(engine, expire_on_commit=False) as session:
        session.add_all([*events, live, gone])
        await session.flush()
        deliveries: list[PasswordResetDelivery] = []
        for user, token_fields, ciphertext in plans:
            token = PasswordResetToken(
                token_hash=uuid4().hex + uuid4().hex,
                user_id=user.id,
                **{"expires_at": future, **token_fields},
            )
            session.add(token)
            await session.flush()
            deliveries.append(
                PasswordResetDelivery(
                    reset_id=token.id,
                    recipient_email=SECRET_ADDRESS,
                    ciphertext=ciphertext,
                    key_version=1,
                    status="PENDING",
                    scheduled_for=past,
                )
            )
        session.add_all(deliveries)
        await session.commit()
    try:
        yield {"baseline": baseline, "ids": ids}
    finally:
        async with AsyncSession(engine) as session:
            await session.execute(
                delete(OutboxEvent).where(OutboxEvent.id.in_([e.id for e in events]))
            )
            await session.execute(delete(User).where(User.id.in_([live.id, gone.id])))
            await session.commit()


@pytest.mark.asyncio
async def test_activation_preview_classifies_the_backlog(
    engine: AsyncEngine, preview_rows: dict[str, Any]
) -> None:
    before, after = preview_rows["baseline"], await _report(engine)

    by_event = after["outbox"]["unprocessed_by_event_type"]
    assert by_event["PreviewTypeA"]["count"] == 2
    assert by_event["PreviewTypeB"]["count"] == 1
    assert "PreviewTypeProcessed" not in by_event
    assert (
        3 * 86400 - 60
        <= by_event["PreviewTypeA"]["oldest_age_seconds"]
        <= 3 * 86400 + 600
    )
    assert 86400 - 60 <= by_event["PreviewTypeA"]["newest_age_seconds"] <= 86400 + 600
    by_aggregate = after["outbox"]["unprocessed_by_aggregate_type"]
    assert by_aggregate["PreviewAggregateX"] == 2
    assert by_aggregate["PreviewAggregateY"] == 1
    pairs = {
        (p["event_type"], p["aggregate_type"]): p["count"]
        for p in after["outbox"]["unprocessed_by_event_and_aggregate_type"]
    }
    assert pairs[("PreviewTypeA", "PreviewAggregateX")] == 1
    assert pairs[("PreviewTypeA", "PreviewAggregateY")] == 1
    assert pairs[("PreviewTypeB", "PreviewAggregateX")] == 1

    for outcome in (
        "valid",
        "consumed",
        "expired",
        "user_unavailable",
        "not_selected_ciphertext_missing",
    ):
        assert (
            _delta(after, before, "password_resets", "due_by_outcome", outcome) == 1
        ), outcome
    assert _delta(after, before, "password_resets", "due_by_outcome", "superseded") == 2
    assert _delta(after, before, "password_resets", "due_pending") == 7


@pytest.mark.asyncio
async def test_activation_preview_never_gates_activation(
    engine: AsyncEngine, preview_rows: dict[str, Any]
) -> None:
    before, after = preview_rows["baseline"], await _report(engine)
    assert after["blockers"] == before["blockers"]


@pytest.mark.asyncio
async def test_activation_preview_exposes_no_identifiers_or_content(
    engine: AsyncEngine, preview_rows: dict[str, Any]
) -> None:
    rendered = json.dumps(await _report(engine))
    for leaked in (
        *preview_rows["ids"],
        SECRET_ADDRESS,
        SECRET_BODY,
        SECRET_CIPHERTEXT,
        "preview-",
    ):
        assert leaked not in rendered
    assert "@" not in rendered
