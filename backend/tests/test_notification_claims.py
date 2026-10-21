"""Notification claim, fencing and failure semantics (SQLite, deterministic).

Overlap is simulated by re-entering the dispatcher from inside ``send``: while one
dispatcher is mid-send, another starts. Commit failures are injected with a session
class whose ``commit`` fails on demand.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

import hms_backend.app.main  # noqa: F401  (registers every ORM model)
import hms_backend.app.modules.notifications.claims as claims_module
from hms_backend.app.core.config import Settings
from hms_backend.app.models.base import Base
from hms_backend.app.modules.notifications.channels.base import (
    ChannelAdapter,
    DeliveryResult,
    OutgoingMessage,
)
from hms_backend.app.modules.notifications.claims import (
    claim,
    finalise,
    requeue_expired_claims,
)
from hms_backend.app.modules.notifications.enums import (
    NotificationChannel,
    NotificationStatus,
)
from hms_backend.app.modules.notifications.models import Notification
from hms_backend.app.modules.notifications.service import dispatch_pending

NOW = datetime(2026, 10, 21, 12, 0, tzinfo=UTC)
LEASE = 300


class FlakySession(AsyncSession):
    """A session whose next ``commit_failures`` commits fail."""

    commit_failures = 0

    async def commit(self) -> None:
        if FlakySession.commit_failures > 0:
            FlakySession.commit_failures -= 1
            raise OperationalError("COMMIT", {}, Exception("connection lost"))
        await super().commit()


@pytest.fixture
def service_log() -> Iterator[list[str]]:
    """Capture the dispatcher's log output regardless of earlier tests' logging setup.

    Other tests in the suite reconfigure logging (Alembic's ``fileConfig`` disables
    existing loggers), so ``caplog`` alone can miss these records.
    """
    messages: list[str] = []

    class Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            messages.append(record.getMessage())

    logger = logging.getLogger("hms_backend.notifications.service")
    saved = (logger.disabled, logger.level, logger.propagate)
    handler = Collect()
    logger.disabled = False
    logger.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    yield messages
    logger.removeHandler(handler)
    logger.disabled, logger.level, logger.propagate = saved


@pytest_asyncio.fixture
async def factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    FlakySession.commit_failures = 0
    yield async_sessionmaker(engine, class_=FlakySession, expire_on_commit=False)
    FlakySession.commit_failures = 0
    await engine.dispose()


@pytest.fixture(autouse=True)
def _no_retry_delay(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(claims_module, "FINALISE_RETRY_DELAYS", (0.0, 0.0))


class Adapter:
    channel = NotificationChannel.EMAIL

    def __init__(self) -> None:
        self.sends: dict[str, int] = {}
        self.on_send: Any = None  # async callable(message), may raise
        self.raise_for: set[str] = set()

    async def send(self, message: OutgoingMessage) -> DeliveryResult:
        count = self.sends.get(message.to_address, 0) + 1
        self.sends[message.to_address] = count
        if message.to_address in self.raise_for:
            raise RuntimeError(f"provider exploded for {message.to_address}")
        if self.on_send is not None:
            await self.on_send(message)
        return DeliveryResult(success=True, provider_message_id=f"msg-{count}")


def adapters(adapter: Adapter) -> dict[NotificationChannel, ChannelAdapter]:
    return {NotificationChannel.EMAIL: adapter}


async def seed(
    factory: async_sessionmaker[AsyncSession], address: str, **overrides: Any
) -> str:
    values: dict[str, Any] = {
        "event_ref": f"event-{uuid4().hex[:8]}",
        "category": "CERTIFICATE_ISSUED",
        "tier": "IMPORTANT",
        "recipient_type": "USER",
        "recipient_id": str(uuid4()),
        "recipient_address": address,
        "channel": "EMAIL",
        "template_key": "certificate_issued",
        "subject": "Certificate issued",
        "body": "Your certificate has been issued.",
        "status": NotificationStatus.PENDING.value,
        "idempotency_key": uuid4().hex + uuid4().hex,
        "scheduled_for": NOW - timedelta(minutes=1),
    }
    values.update(overrides)
    async with factory() as session:
        notification = Notification(**values)
        session.add(notification)
        await session.commit()
        return notification.id


async def row(
    factory: async_sessionmaker[AsyncSession], notification_id: str
) -> Notification:
    async with factory() as session:
        found = await session.get(Notification, notification_id)
        assert found is not None
        return found


@pytest.mark.asyncio
async def test_the_claim_is_committed_before_the_send(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    nid = await seed(factory, "claim@example.test")
    adapter = Adapter()
    seen: list[tuple[str, int, datetime | None]] = []

    async def inspect(_message: OutgoingMessage) -> None:
        mid_send = await row(factory, nid)  # a separate session sees committed state
        seen.append((mid_send.status, mid_send.attempts, mid_send.scheduled_for))

    adapter.on_send = inspect

    await dispatch_pending(
        factory, adapters=adapters(adapter), settings=Settings(), now=NOW
    )

    (status, attempts, lease_deadline) = seen[0]
    assert (status, attempts) == ("SENDING", 1)
    assert lease_deadline is not None
    assert lease_deadline.replace(tzinfo=UTC) == NOW + timedelta(seconds=LEASE)
    done = await row(factory, nid)
    assert done.status == NotificationStatus.SENT.value and done.attempts == 1


@pytest.mark.asyncio
async def test_a_dispatcher_starting_mid_send_does_not_send_again(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    address = "overlap@example.test"
    nid = await seed(factory, address)
    adapter = Adapter()
    inner: list[dict[str, int]] = []

    async def start_another_dispatcher(_message: OutgoingMessage) -> None:
        inner.append(
            await dispatch_pending(
                factory, adapters=adapters(adapter), settings=Settings(), now=NOW
            )
        )

    adapter.on_send = start_another_dispatcher

    await dispatch_pending(
        factory, adapters=adapters(adapter), settings=Settings(), now=NOW
    )

    assert adapter.sends[address] == 1
    assert inner == [{"sent": 0, "dead_letter": 0}]
    assert (await row(factory, nid)).status == NotificationStatus.SENT.value


@pytest.mark.asyncio
async def test_a_raising_adapter_is_a_failed_attempt_and_the_batch_continues(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    bad = await seed(factory, "bad@example.test", created_at=NOW - timedelta(hours=2))
    good = await seed(factory, "good@example.test")
    adapter = Adapter()
    adapter.raise_for = {"bad@example.test"}

    result = await dispatch_pending(
        factory, adapters=adapters(adapter), settings=Settings(), now=NOW
    )

    assert result == {"sent": 1, "dead_letter": 0}
    failed = await row(factory, bad)
    assert failed.status == NotificationStatus.PENDING.value
    assert failed.attempts == 1  # the attempt is recorded, not lost with a rollback
    # Only the exception class is stored: its message can carry addresses or secrets.
    assert failed.error == "RuntimeError"
    assert (
        failed.scheduled_for is not None
        and failed.scheduled_for.replace(tzinfo=UTC) > NOW
    )
    assert (await row(factory, good)).status == NotificationStatus.SENT.value


@pytest.mark.asyncio
async def test_a_transient_failure_recording_the_outcome_is_retried_not_resent(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    address = "blip@example.test"
    nid = await seed(factory, address)
    adapter = Adapter()

    async def database_blips_after_the_send(_message: OutgoingMessage) -> None:
        FlakySession.commit_failures = 1  # the next commit, the outcome write, fails

    adapter.on_send = database_blips_after_the_send

    await dispatch_pending(
        factory, adapters=adapters(adapter), settings=Settings(), now=NOW
    )
    await dispatch_pending(
        factory, adapters=adapters(adapter), settings=Settings(), now=NOW
    )

    assert adapter.sends[address] == 1
    assert (await row(factory, nid)).status == NotificationStatus.SENT.value


@pytest.mark.asyncio
async def test_an_unrecordable_outcome_leaves_the_row_claimed_until_the_lease_expires(
    factory: async_sessionmaker[AsyncSession], service_log: list[str]
) -> None:
    address = "stuck@example.test"
    nid = await seed(factory, address)
    adapter = Adapter()

    async def database_stays_down(_message: OutgoingMessage) -> None:
        FlakySession.commit_failures = 100

    adapter.on_send = database_stays_down
    first = await dispatch_pending(
        factory, adapters=adapters(adapter), settings=Settings(), now=NOW
    )
    FlakySession.commit_failures = 0

    # The message did go out, so the summary counts it even though its outcome
    # could not be recorded.
    assert first == {"sent": 1, "dead_letter": 0}
    logged = "\n".join(service_log)
    assert "could not record the outcome" in logged
    assert nid in logged and address not in logged
    stuck = await row(factory, nid)
    assert (stuck.status, stuck.attempts) == ("SENDING", 1)

    # Inside the lease it is not sent again, however often dispatch runs.
    await dispatch_pending(
        factory, adapters=adapters(adapter), settings=Settings(), now=NOW
    )
    assert adapter.sends[address] == 1

    # After the lease the unknown outcome is retried: at-least-once, never dropped.
    later = NOW + timedelta(seconds=LEASE + 1)
    adapter.on_send = None
    await dispatch_pending(
        factory, adapters=adapters(adapter), settings=Settings(), now=later
    )
    assert adapter.sends[address] == 2
    final = await row(factory, nid)
    assert (final.status, final.attempts) == ("SENT", 2)


@pytest.mark.asyncio
async def test_an_expired_claim_on_the_last_attempt_is_dead_lettered_not_resent(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    address = "last@example.test"
    nid = await seed(
        factory,
        address,
        status="SENDING",
        attempts=5,
        scheduled_for=NOW - timedelta(seconds=1),
    )
    adapter = Adapter()

    await dispatch_pending(
        factory,
        adapters=adapters(adapter),
        settings=Settings(notification_max_attempts=5),
        now=NOW,
    )

    assert address not in adapter.sends
    dead = await row(factory, nid)
    assert dead.status == NotificationStatus.DEAD_LETTER.value
    assert dead.error == "delivery outcome unknown after the final attempt"


@pytest.mark.asyncio
async def test_a_stale_claim_cannot_overwrite_a_newer_one(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    nid = await seed(factory, "fence@example.test")
    first = await claim(factory, Notification, nid, now=NOW, lease_seconds=LEASE)
    assert first is not None and first.token == 1
    # While held, nobody else can claim it.
    assert await claim(factory, Notification, nid, now=NOW, lease_seconds=LEASE) is None

    # The first holder hangs; its lease expires and the row is re-claimed.
    later = NOW + timedelta(seconds=LEASE + 1)
    await requeue_expired_claims(factory, Notification, now=later, max_attempts=5)
    second = await claim(factory, Notification, nid, now=later, lease_seconds=LEASE)
    assert second is not None and second.token == 2

    # The hung worker wakes up and tries to record "sent": it must not land.
    assert not await finalise(
        factory, Notification, first, {"status": "SENT", "provider_message_id": "old"}
    )
    still = await row(factory, nid)
    assert (still.status, still.attempts, still.provider_message_id) == (
        "SENDING",
        2,
        None,
    )
    assert await finalise(
        factory, Notification, second, {"status": "SENT", "provider_message_id": "new"}
    )
    assert (await row(factory, nid)).provider_message_id == "new"


@pytest.mark.asyncio
async def test_a_notification_that_is_not_yet_due_is_not_claimed(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    nid = await seed(
        factory, "later@example.test", scheduled_for=NOW + timedelta(minutes=5)
    )

    assert await claim(factory, Notification, nid, now=NOW, lease_seconds=LEASE) is None
    assert (await row(factory, nid)).attempts == 0


@pytest.mark.asyncio
async def test_a_missing_address_fails_the_claimed_row_without_sending(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    nid = await seed(factory, "x@example.test", recipient_address=None)
    adapter = Adapter()

    await dispatch_pending(
        factory, adapters=adapters(adapter), settings=Settings(), now=NOW
    )

    failed = await row(factory, nid)
    assert failed.status == NotificationStatus.FAILED.value
    assert failed.error == "no adapter or address"
    assert failed.attempts == 1
    assert adapter.sends == {}


@pytest.mark.asyncio
async def test_a_genuine_relay_failure_is_still_recorded_on_an_unprocessed_event(
    factory: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    import hms_backend.app.modules.notifications.service as service_module
    from hms_backend.app.modules.notifications.models import OutboxEvent
    from hms_backend.app.modules.notifications.service import _relay_one

    async with factory() as session:
        event = OutboxEvent(
            event_type="CERTIFICATE_ISSUED",
            aggregate_type="certificate",
            aggregate_id=str(uuid4()),
            payload={},
        )
        session.add(event)
        await session.commit()
        event_id = event.id

    async def failing(*_args: object, **_kwargs: object) -> list[object]:
        raise RuntimeError("could not resolve recipients")

    monkeypatch.setattr(service_module, "resolve_recipients", failing)

    await _relay_one(factory, event_id, Settings())
    await _relay_one(factory, event_id, Settings())

    async with factory() as session:
        failed = await session.get(OutboxEvent, event_id)
        assert failed is not None
        # Each real failure is counted and kept for retry; the event stays unprocessed.
        assert failed.processed_at is None
        assert failed.attempts == 2
        assert failed.error == "could not resolve recipients"
