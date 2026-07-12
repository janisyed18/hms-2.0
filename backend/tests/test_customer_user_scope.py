from collections.abc import AsyncGenerator
from typing import cast

import pytest
import pytest_asyncio
from sqlalchemy import Table, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from hms_backend.app.core.rbac import Principal, Role, apply_customer_scope
from hms_backend.app.models import foundation as foundation_models  # noqa: F401
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets import models as asset_models  # noqa: F401
from hms_backend.app.modules.certificates import (
    models as certificate_models,  # noqa: F401
)
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.inspections import (
    models as inspection_models,  # noqa: F401
)
from hms_backend.app.modules.products import models as product_models  # noqa: F401
from hms_backend.app.modules.reference import models as reference_models  # noqa: F401
from hms_backend.app.modules.scheduling import models as scheduling_models  # noqa: F401


@pytest_asyncio.fixture
async def session() -> AsyncGenerator[AsyncSession]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(
            lambda sync_connection: Base.metadata.create_all(
                sync_connection, tables=[cast(Table, Customer.__table__)]
            )
        )
    async with AsyncSession(engine, expire_on_commit=False) as db:
        db.add_all(
            [
                Customer(code="ONE", name="Customer One"),
                Customer(code="TWO", name="Customer Two"),
            ]
        )
        await db.flush()
        yield db
    await engine.dispose()


@pytest.mark.asyncio
async def test_customer_user_without_assignment_sees_no_rows(
    session: AsyncSession,
) -> None:
    principal = Principal(
        user_id="customer-user",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset(),
    )
    rows = (
        await session.scalars(
            apply_customer_scope(select(Customer.code), Customer, principal)
        )
    ).all()
    assert rows == []


@pytest.mark.asyncio
async def test_customer_user_sees_only_assigned_customer(
    session: AsyncSession,
) -> None:
    assigned_id = (
        await session.scalars(select(Customer.id).where(Customer.code == "ONE"))
    ).one()
    principal = Principal(
        user_id="customer-user",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({assigned_id}),
    )
    rows = (
        await session.scalars(
            apply_customer_scope(select(Customer.code), Customer, principal)
        )
    ).all()
    assert rows == ["ONE"]


@pytest.mark.asyncio
async def test_elevated_role_is_not_restricted_by_customer_user_membership(
    session: AsyncSession,
) -> None:
    principal = Principal(
        user_id="reviewer-customer-user",
        roles=frozenset({Role.REVIEWER, Role.CUSTOMER_USER}),
        customer_ids=frozenset(),
    )
    rows = (
        await session.scalars(
            apply_customer_scope(select(Customer.code), Customer, principal).order_by(
                Customer.code
            )
        )
    ).all()
    assert rows == ["ONE", "TWO"]
