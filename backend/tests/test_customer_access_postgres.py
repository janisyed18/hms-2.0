"""Customer-access lifecycle checks against the migrated PostgreSQL schema."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import selectinload

from hms_backend.app.api.admin import _replace_customer_accesses
from hms_backend.app.api.dependencies import get_current_principal
from hms_backend.app.core.rbac import Role
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.identity.models import User, UserCustomerAccess

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)


@pytest_asyncio.fixture
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert POSTGRES_URL is not None
    if not POSTGRES_URL.startswith("postgresql+asyncpg://"):
        raise ValueError("These tests require a dedicated async PostgreSQL database")
    database_name = make_url(POSTGRES_URL).database
    if database_name is None or not database_name.endswith("_test"):
        raise ValueError("These tests require a database name ending in _test")
    engine = create_async_engine(POSTGRES_URL)
    try:
        async with engine.connect() as connection:
            version = await connection.scalar(
                text("SELECT version_num FROM alembic_version")
            )
            head = ScriptDirectory.from_config(Config("alembic.ini")).get_current_head()
            assert version == head, "Migrate the test database first"
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_customer_access_can_be_revoked_and_regranted_on_postgresql(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    tag = uuid4().hex[:10]
    async with session_factory() as session:
        customer_a = Customer(code=f"PGA{tag}", name=f"Postgres A {tag}")
        customer_b = Customer(code=f"PGB{tag}", name=f"Postgres B {tag}")
        user = User(
            oidc_subject=f"customer-regrant-{tag}",
            email=f"customer-regrant-{tag}@example.test",
            role=Role.CUSTOMER_USER.value,
            customer_accesses=[],
        )
        session.add_all([customer_a, customer_b, user])
        await session.flush()
        user.customer_id = customer_a.id
        await _replace_customer_accesses(
            session, user, [customer_a.id, customer_b.id], actor_id="test-admin"
        )
        await session.commit()

    async with session_factory() as session:
        loaded_user = await session.scalar(
            select(User)
            .options(selectinload(User.customer_accesses))
            .where(User.oidc_subject == f"customer-regrant-{tag}")
        )
        assert loaded_user is not None
        loaded_user.customer_id = customer_a.id
        await _replace_customer_accesses(
            session, loaded_user, [customer_a.id], actor_id="test-admin"
        )
        await session.commit()

    async with session_factory() as session:
        loaded_user = await session.scalar(
            select(User)
            .options(selectinload(User.customer_accesses))
            .where(User.oidc_subject == f"customer-regrant-{tag}")
        )
        assert loaded_user is not None
        await _replace_customer_accesses(
            session,
            loaded_user,
            [customer_a.id, customer_b.id],
            actor_id="test-admin",
        )
        await session.commit()

    async with session_factory() as session:
        loaded_user = await session.scalar(
            select(User).where(User.oidc_subject == f"customer-regrant-{tag}")
        )
        assert loaded_user is not None
        access_rows = await session.scalar(
            select(func.count())
            .select_from(UserCustomerAccess)
            .where(
                UserCustomerAccess.user_id == loaded_user.id,
                UserCustomerAccess.customer_id == customer_b.id,
            )
        )
        principal = await get_current_principal(
            session, x_hms_user_id=loaded_user.oidc_subject
        )

    assert access_rows == 1
    assert principal.customer_ids == frozenset({customer_a.id, customer_b.id})
