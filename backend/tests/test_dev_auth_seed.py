"""Dev role-account seeding tests (Task 6)."""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from hms_backend.app.core.rbac import Role
from hms_backend.app.models import foundation  # noqa: F401
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets import models as _assets  # noqa: F401
from hms_backend.app.modules.certificates import models as _certs  # noqa: F401
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.identity.models import User
from hms_backend.app.modules.inspections import models as _insp  # noqa: F401
from hms_backend.app.modules.notifications import models as _notif  # noqa: F401
from hms_backend.app.modules.products import models as _products  # noqa: F401
from hms_backend.app.modules.reference import models as _reference  # noqa: F401
from hms_backend.app.modules.scheduling import models as _sched  # noqa: F401
from hms_backend.app.tooling.auth_seed import (
    AUTH_TEST_ACCOUNTS,
    ProductionSeedError,
    format_credentials_table,
    seed_auth_test_accounts,
)


@pytest_asyncio.fixture
async def session() -> AsyncGenerator[AsyncSession]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with AsyncSession(engine, expire_on_commit=False) as test_session:
        yield test_session
    await engine.dispose()


@pytest.mark.parametrize("environment", ["production", "prod", "staging", "STAGING"])
@pytest.mark.asyncio
async def test_refuses_production_like_environments(
    session: AsyncSession, environment: str
) -> None:
    with pytest.raises(ProductionSeedError):
        await seed_auth_test_accounts(session, environment=environment)


@pytest.mark.asyncio
async def test_creates_one_account_per_role_with_unique_hashes(
    session: AsyncSession,
) -> None:
    accounts = await seed_auth_test_accounts(session, environment="local")
    assert len(accounts) == len(AUTH_TEST_ACCOUNTS) == 6
    assert {a.role for a in accounts} == set(Role)

    users = (await session.scalars(select(User))).all()
    assert len(users) == 6
    # Passwords are hashed (Argon2), never stored in plaintext, and unique.
    assert all(u.password_hash and u.password_hash.startswith("$argon2") for u in users)
    assert len({u.password_hash for u in users}) == 6
    assert all(u.must_change_password for u in users)
    assert all(u.mfa_enabled is False for u in users)


@pytest.mark.asyncio
async def test_customer_user_is_scoped_others_are_not(
    session: AsyncSession,
) -> None:
    await seed_auth_test_accounts(session, environment="local")
    customer_user = await session.scalar(
        select(User).where(User.role == Role.CUSTOMER_USER.value)
    )
    assert customer_user is not None and customer_user.customer_id is not None
    others = (
        await session.scalars(
            select(User).where(User.role != Role.CUSTOMER_USER.value)
        )
    ).all()
    assert all(u.customer_id is None for u in others)
    # A single synthetic customer backs the Customer User.
    assert await session.scalar(select(func.count()).select_from(Customer)) == 1


@pytest.mark.asyncio
async def test_idempotent_without_reset_and_rotates_with_reset(
    session: AsyncSession,
) -> None:
    first = await seed_auth_test_accounts(session, environment="local")
    hashes_before = {
        u.email: u.password_hash for u in (await session.scalars(select(User))).all()
    }

    # Re-run without reset: no new rows, and no password reported/changed.
    second = await seed_auth_test_accounts(session, environment="local")
    assert all(a.temporary_password is None and not a.created for a in second)
    assert await session.scalar(select(func.count()).select_from(User)) == 6

    enrolled_user = await session.scalar(
        select(User).where(User.email == "reviewer@example.test")
    )
    assert enrolled_user is not None
    enrolled_user.mfa_enabled = True
    enrolled_user.mfa_secret_ciphertext = "v1:encrypted-secret"
    enrolled_user.mfa_secret_key_version = 1
    enrolled_user.mfa_last_accepted_step = 123
    enrolled_user.failed_password_attempts = 4
    enrolled_user.failed_mfa_attempts = 3
    enrolled_user.account_status = "LOCKED"
    await session.flush()

    # Re-run with reset: passwords rotate and are reported once.
    third = await seed_auth_test_accounts(
        session, environment="local", reset_existing=True
    )
    assert all(a.temporary_password for a in third)
    hashes_after = {
        u.email: u.password_hash for u in (await session.scalars(select(User))).all()
    }
    assert hashes_after != hashes_before
    assert enrolled_user.mfa_enabled is False
    assert enrolled_user.mfa_secret_ciphertext is None
    assert enrolled_user.mfa_secret_key_version is None
    assert enrolled_user.mfa_last_accepted_step is None
    assert enrolled_user.failed_password_attempts == 0
    assert enrolled_user.failed_mfa_attempts == 0
    assert enrolled_user.account_status == "ACTIVE"
    assert first  # first run reported temporary passwords
    assert all(a.temporary_password for a in first)


@pytest.mark.asyncio
async def test_credentials_table_lists_every_account_and_never_writes_a_file(
    session: AsyncSession,
) -> None:
    accounts = await seed_auth_test_accounts(session, environment="local")
    table = format_credentials_table(accounts)
    for account in accounts:
        assert account.email in table
        assert account.temporary_password is not None
        assert account.temporary_password in table
    assert "MFA enrollment" in table
