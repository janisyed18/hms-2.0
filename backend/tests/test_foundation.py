from collections.abc import AsyncGenerator
from uuid import UUID

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.core.audit import append_audit_event, verify_audit_chain
from hms_backend.app.core.repository import soft_delete
from hms_backend.app.models.base import Base
from hms_backend.app.models.foundation import AuditEvent, SyncChange
from hms_backend.app.modules.customers.models import Customer


@pytest_asyncio.fixture
async def session() -> AsyncGenerator[AsyncSession]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as test_session:
        yield test_session

    await engine.dispose()


@pytest.mark.asyncio
async def test_customer_uses_client_generatable_uuidv7(session: AsyncSession) -> None:
    customer = Customer(code="VOPA", name="Vopak")
    session.add(customer)
    await session.flush()

    parsed = UUID(customer.id)

    assert parsed.version == 7
    assert customer.version == 1
    assert customer.deleted_at is None


@pytest.mark.asyncio
async def test_soft_delete_writes_tombstone_sync_change_and_audit_event(
    session: AsyncSession,
) -> None:
    customer = Customer(code="VOPA", name="Vopak")
    session.add(customer)
    await session.flush()

    await soft_delete(
        session,
        customer,
        actor_id="system",
        action="customer.deleted",
    )
    await session.commit()

    sync_changes = (await session.scalars(select(SyncChange))).all()
    audit_events = (await session.scalars(select(AuditEvent))).all()

    assert customer.deleted_at is not None
    assert customer.version == 2
    assert len(sync_changes) == 1
    assert sync_changes[0].entity == "Customer"
    assert sync_changes[0].entity_id == customer.id
    assert sync_changes[0].op == "delete"
    assert sync_changes[0].version == 2
    assert len(audit_events) == 1
    assert audit_events[0].actor_id == "system"
    assert audit_events[0].action == "customer.deleted"
    assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_audit_chain_detects_tampering(session: AsyncSession) -> None:
    await append_audit_event(
        session,
        actor_id="system",
        action="customer.created",
        entity="Customer",
        entity_id="customer-1",
        before=None,
        after={"name": "Vopak"},
    )
    await append_audit_event(
        session,
        actor_id="system",
        action="customer.updated",
        entity="Customer",
        entity_id="customer-1",
        before={"name": "Vopak"},
        after={"name": "Vopak Pty Ltd"},
    )
    await session.flush()

    assert await verify_audit_chain(session)

    first_event = (
        await session.scalars(select(AuditEvent).order_by(AuditEvent.sequence))
    ).first()
    assert first_event is not None
    first_event.after = {"name": "Tampered"}
    await session.flush()

    assert not await verify_audit_chain(session)
