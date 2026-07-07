from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.schemas import UserRead
from hms_backend.app.core.rbac import (
    Permission,
    Principal,
    Role,
    apply_customer_scope,
    require_permission,
)
from hms_backend.app.models.base import Base
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.identity.models import User


@pytest_asyncio.fixture
async def session() -> AsyncGenerator[AsyncSession]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as test_session:
        yield test_session

    await engine.dispose()


def test_role_permissions_grant_admin_customer_management() -> None:
    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )

    require_permission(principal, Permission.CUSTOMER_WRITE)


def test_role_permissions_reject_customer_write_for_customer_user() -> None:
    principal = Principal(
        user_id="customer-user-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({"customer-1"}),
    )

    with pytest.raises(PermissionError):
        require_permission(principal, Permission.CUSTOMER_WRITE)


@pytest.mark.asyncio
async def test_customer_scope_limits_customer_user_rows(session: AsyncSession) -> None:
    vopak = Customer(code="VOPA", name="Vopak")
    orica = Customer(code="ORIC", name="Orica")
    session.add_all([vopak, orica])
    await session.flush()

    principal = Principal(
        user_id="customer-user-1",
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset({vopak.id}),
    )
    statement = apply_customer_scope(select(Customer), Customer, principal)

    customers = (await session.scalars(statement)).all()

    assert [customer.code for customer in customers] == ["VOPA"]


@pytest.mark.asyncio
async def test_customer_scope_does_not_limit_hms_admin(session: AsyncSession) -> None:
    session.add_all(
        [
            Customer(code="VOPA", name="Vopak"),
            Customer(code="ORIC", name="Orica"),
        ]
    )
    await session.flush()

    principal = Principal(
        user_id="admin-1",
        roles=frozenset({Role.HMS_ADMIN}),
        customer_ids=frozenset(),
    )
    statement = apply_customer_scope(select(Customer), Customer, principal)

    customers = (await session.scalars(statement.order_by(Customer.code))).all()

    assert [customer.code for customer in customers] == ["ORIC", "VOPA"]


def test_user_model_has_no_plaintext_password_column() -> None:
    column_names = {column.name for column in User.__table__.columns}

    assert "password" not in column_names
    assert "password_hash" in column_names
    assert "oidc_subject" in column_names


def test_user_read_schema_does_not_expose_password_hash() -> None:
    field_names = set(UserRead.model_fields)

    assert "password" not in field_names
    assert "password_hash" not in field_names
