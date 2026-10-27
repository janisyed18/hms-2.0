"""The in-app notification feed behind the shared Notification Center.

Unread count, paging, mark one, mark all (idempotent, own and in scope only), and the
subject ids a click routes by.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from test_notifications_api import (  # noqa: F401
    notifications_client,
    seed_user,
    session_factory,
)

from hms_backend.app.core.rbac import Role
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.identity.models import User, UserCustomerAccess
from hms_backend.app.modules.notifications.enums import (
    NotificationCategory,
    NotificationChannel,
    NotificationStatus,
    NotificationTier,
    RecipientType,
)
from hms_backend.app.modules.notifications.models import Notification, OutboxEvent

_counter = {"n": 0}


def notice(
    recipient_id: str,
    *,
    channel: NotificationChannel = NotificationChannel.IN_APP,
    read: bool = False,
    customer_id: str | None = None,
    event_ref: str = "event",
    category: str = NotificationCategory.INSPECTION_SUBMITTED.value,
    age_minutes: int = 0,
) -> Notification:
    _counter["n"] += 1
    return Notification(
        event_ref=event_ref,
        category=category,
        tier=NotificationTier.IMPORTANT.value,
        recipient_type=RecipientType.USER.value,
        recipient_id=recipient_id,
        channel=channel.value,
        template_key="t",
        subject=f"Subject {_counter['n']}",
        body="Body",
        status=NotificationStatus.SENT.value,
        idempotency_key=f"{_counter['n']:064d}",
        customer_id=customer_id,
        read_at=datetime.now(UTC) if read else None,
        created_at=datetime.now(UTC) - timedelta(minutes=age_minutes),
    )


async def add(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
    *rows: Notification | OutboxEvent,
) -> None:
    async with session_factory() as session:
        session.add_all(rows)
        await session.commit()


@pytest.mark.asyncio
async def test_an_empty_feed_has_no_unread(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
) -> None:
    await seed_user(session_factory)
    async with notifications_client(session_factory) as client:
        body = (await client.get("/api/v1/notifications/me")).json()
    assert body["total"] == 0 and body["unread_total"] == 0 and body["items"] == []


@pytest.mark.asyncio
async def test_unread_count_is_exact_and_ignores_other_channels_and_people(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
) -> None:
    user = await seed_user(session_factory)
    await add(
        session_factory,
        notice(user.id),
        notice(user.id),
        notice(user.id, read=True),
        notice(user.id, channel=NotificationChannel.EMAIL),
        notice("someone-else"),
    )
    async with notifications_client(session_factory) as client:
        body = (await client.get("/api/v1/notifications/me")).json()
    assert body["total"] == 3
    assert body["unread_total"] == 2


@pytest.mark.asyncio
async def test_the_feed_pages_newest_first_and_the_unread_count_spans_pages(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
) -> None:
    user = await seed_user(session_factory)
    await add(session_factory, *[notice(user.id, age_minutes=i) for i in range(5)])
    async with notifications_client(session_factory) as client:
        first = (await client.get("/api/v1/notifications/me?limit=2")).json()
        second = (await client.get("/api/v1/notifications/me?limit=2&offset=2")).json()
    assert [first["total"], first["unread_total"]] == [5, 5]
    assert len(first["items"]) == 2 and len(second["items"]) == 2
    assert first["items"][0]["created_at"] > second["items"][0]["created_at"]
    assert second["unread_total"] == 5
    assert not {i["id"] for i in first["items"]} & {i["id"] for i in second["items"]}


@pytest.mark.asyncio
async def test_a_notification_carries_what_it_is_about(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
) -> None:
    user = await seed_user(session_factory)
    event = OutboxEvent(
        event_type="INSPECTION_SUBMITTED",
        aggregate_type="inspection",
        aggregate_id="inspection-42",
        payload={},
    )
    async with session_factory() as session:
        session.add(event)
        await session.flush()
        session.add_all([notice(user.id, event_ref=event.id), notice(user.id)])
        await session.commit()
    async with notifications_client(session_factory) as client:
        items = (await client.get("/api/v1/notifications/me")).json()["items"]
    subjects = sorted(
        (i["subject_type"], i["subject_id"]) for i in items if i["subject_type"]
    )
    assert subjects == [("inspection", "inspection-42")]
    assert (
        sum(1 for i in items if i["subject_type"] is None) == 1
    )  # no event: still safe


@pytest.mark.asyncio
async def test_mark_all_read_marks_only_the_callers_in_app_unread_and_is_idempotent(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
) -> None:
    user = await seed_user(session_factory)
    other = Notification
    await add(
        session_factory,
        notice(user.id),
        notice(user.id),
        notice(user.id, read=True),
        notice(user.id, channel=NotificationChannel.EMAIL),
        notice("someone-else"),
    )
    async with notifications_client(session_factory) as client:
        first = await client.post("/api/v1/notifications/me/read-all")
        second = await client.post("/api/v1/notifications/me/read-all")
        feed = (await client.get("/api/v1/notifications/me")).json()
    assert first.status_code == 200
    assert first.json() == {"updated": 2, "unread_total": 0}
    assert second.json() == {"updated": 0, "unread_total": 0}
    assert feed["unread_total"] == 0
    async with session_factory() as session:
        rows = (await session.scalars(select(other))).all()
    by_recipient = {(r.recipient_id == user.id, r.channel): r.read_at for r in rows}
    assert by_recipient[(True, "EMAIL")] is None  # another channel: untouched
    assert by_recipient[(False, "IN_APP")] is None  # another person: untouched


@pytest.mark.asyncio
async def test_a_customer_user_marks_only_their_own_scope_read(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
) -> None:
    user = await seed_user(session_factory, oidc_subject="customer-oidc")
    async with session_factory() as session:
        mine, theirs = (
            Customer(code="MINE", name="Mine"),
            Customer(code="THEIRS", name="Theirs"),
        )
        session.add_all([mine, theirs])
        await session.flush()
        person = await session.get(User, user.id)
        assert person is not None
        person.role = Role.CUSTOMER_USER.value
        person.customer_id = mine.id
        session.add(UserCustomerAccess(user_id=person.id, customer_id=mine.id))
        session.add_all(
            [
                notice(person.id, customer_id=mine.id),
                notice(person.id, customer_id=theirs.id),
                notice(person.id),
            ]
        )
        await session.commit()
        mine_id, theirs_id = mine.id, theirs.id
        person_id = person.id
    async with notifications_client(session_factory, user_id="customer-oidc") as client:
        denied = await client.post(
            "/api/v1/notifications/me/read-all", params={"customer_id": theirs_id}
        )
        done = await client.post("/api/v1/notifications/me/read-all")
        again = await client.post(
            "/api/v1/notifications/me/read-all", params={"customer_id": mine_id}
        )
    assert denied.status_code == 404
    assert (
        done.json()["updated"] == 2
    )  # their own organisation and the account-level one
    assert again.json()["updated"] == 0
    async with session_factory() as session:
        hidden = await session.scalar(
            select(Notification).where(
                Notification.recipient_id == person_id,
                Notification.customer_id == theirs_id,
            )
        )
    assert (
        hidden is not None and hidden.read_at is None
    )  # another customer's: never touched


@pytest.mark.asyncio
async def test_marking_one_read_twice_is_harmless(
    session_factory: async_sessionmaker[AsyncSession],  # noqa: F811
) -> None:
    user = await seed_user(session_factory)
    row = notice(user.id)
    await add(session_factory, row)
    async with notifications_client(session_factory) as client:
        first = await client.post(f"/api/v1/notifications/{row.id}/read")
        second = await client.post(f"/api/v1/notifications/{row.id}/read")
        feed = (await client.get("/api/v1/notifications/me")).json()
    assert first.status_code == second.status_code == 200
    # SQLite drops the zone on the way back; the instant is what must not move.
    assert first.json()["read_at"].rstrip("Z") == second.json()["read_at"].rstrip("Z")
    assert feed["unread_total"] == 0
