from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import event
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.schema import UniqueConstraint

from hms_backend.app.api.schemas import UserRead
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets import models as asset_models  # noqa: F401
from hms_backend.app.modules.certificates import (  # noqa: F401
    models as certificate_models,
)
from hms_backend.app.modules.customers import models as customer_models  # noqa: F401
from hms_backend.app.modules.identity.models import (
    AccountStatus,
    BrowserAuthChallenge,
    BrowserAuthStage,
    BrowserRefreshSession,
    MfaRecoveryCode,
    User,
)
from hms_backend.app.modules.inspections import (  # noqa: F401
    models as inspection_models,
)
from hms_backend.app.modules.products import models as product_models  # noqa: F401
from hms_backend.app.modules.reference import models as reference_models  # noqa: F401
from hms_backend.app.modules.scheduling import (  # noqa: F401
    models as scheduling_models,
)


@pytest_asyncio.fixture
async def session() -> AsyncGenerator[AsyncSession]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")

    @event.listens_for(engine.sync_engine, "connect")
    def _enable_foreign_keys(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as connection:
        table_names = (
            "customers",
            "users",
            "browser_auth_challenges",
            "browser_refresh_sessions",
            "mfa_recovery_codes",
        )
        tables = [Base.metadata.tables[name] for name in table_names]
        await connection.run_sync(
            lambda sync_connection: Base.metadata.create_all(
                sync_connection, tables=tables
            )
        )

    async with AsyncSession(engine, expire_on_commit=False) as test_session:
        yield test_session

    await engine.dispose()


async def _create_user(session: AsyncSession, suffix: str = "one") -> User:
    user = User(
        oidc_subject=f"browser-{suffix}",
        email=f"browser-{suffix}@example.com",
        role="HMS_ADMIN",
    )
    session.add(user)
    await session.flush()
    return user


@pytest.mark.asyncio
async def test_browser_security_records_persist_with_defaults(
    session: AsyncSession,
) -> None:
    user = await _create_user(session)
    now = datetime.now(UTC)
    challenge = BrowserAuthChallenge(
        token_hash="challenge-hash",
        user_id=user.id,
        stage=BrowserAuthStage.MFA_REQUIRED.value,
        expires_at=now + timedelta(minutes=10),
    )
    refresh_session = BrowserRefreshSession(
        user_id=user.id,
        family_id="family-1",
        token_hash="refresh-hash",
        expires_at=now + timedelta(days=30),
        idle_expires_at=now + timedelta(days=7),
        user_agent="pytest",
        ip_address="127.0.0.1",
    )
    recovery_code = MfaRecoveryCode(
        user_id=user.id,
        code_digest="recovery-digest",
    )
    session.add_all([challenge, refresh_session, recovery_code])
    await session.flush()

    assert user.account_status == AccountStatus.ACTIVE.value
    assert user.must_change_password is False
    assert user.mfa_enabled is False
    assert user.failed_password_attempts == 0
    assert user.failed_mfa_attempts == 0
    assert challenge.attempt_count == 0
    assert challenge.consumed_at is None
    assert refresh_session.last_used_at is None
    assert refresh_session.revoked_at is None
    assert refresh_session.replaced_by_id is None
    assert refresh_session.user_agent == "pytest"
    assert refresh_session.ip_address == "127.0.0.1"
    assert recovery_code.consumed_at is None


@pytest.mark.asyncio
async def test_challenge_and_refresh_token_hashes_are_unique(
    session: AsyncSession,
) -> None:
    user = await _create_user(session)
    now = datetime.now(UTC)
    session.add_all(
        [
            BrowserAuthChallenge(
                token_hash="duplicate-token-hash",
                user_id=user.id,
                stage=BrowserAuthStage.MFA_REQUIRED.value,
                expires_at=now + timedelta(minutes=10),
            ),
            BrowserAuthChallenge(
                token_hash="duplicate-token-hash",
                user_id=user.id,
                stage=BrowserAuthStage.MFA_REQUIRED.value,
                expires_at=now + timedelta(minutes=10),
            ),
        ]
    )

    with pytest.raises(IntegrityError):
        await session.flush()
    await session.rollback()

    user = await _create_user(session, "two")
    session.add_all(
        [
            BrowserRefreshSession(
                user_id=user.id,
                family_id="family-1",
                token_hash="duplicate-refresh-hash",
                expires_at=now + timedelta(days=30),
                idle_expires_at=now + timedelta(days=7),
            ),
            BrowserRefreshSession(
                user_id=user.id,
                family_id="family-1",
                token_hash="duplicate-refresh-hash",
                expires_at=now + timedelta(days=30),
                idle_expires_at=now + timedelta(days=7),
            ),
        ]
    )

    with pytest.raises(IntegrityError):
        await session.flush()


@pytest.mark.asyncio
async def test_recovery_code_digest_is_unique_per_user(
    session: AsyncSession,
) -> None:
    first_user = await _create_user(session, "first")
    second_user = await _create_user(session, "second")
    session.add_all(
        [
            MfaRecoveryCode(user_id=first_user.id, code_digest="shared-digest"),
            MfaRecoveryCode(user_id=second_user.id, code_digest="shared-digest"),
        ]
    )
    await session.flush()

    session.add(
        MfaRecoveryCode(user_id=first_user.id, code_digest="shared-digest")
    )
    with pytest.raises(IntegrityError):
        await session.flush()


@pytest.mark.asyncio
async def test_browser_security_records_require_an_existing_user(
    session: AsyncSession,
) -> None:
    session.add(
        BrowserAuthChallenge(
            token_hash="orphan-challenge",
            user_id="missing-user",
            stage=BrowserAuthStage.PASSWORD_CHANGE_REQUIRED.value,
            expires_at=datetime.now(UTC) + timedelta(minutes=10),
        )
    )

    with pytest.raises(IntegrityError):
        await session.flush()


def test_user_read_exposes_security_state_without_secret_material() -> None:
    fields = set(UserRead.model_fields)

    assert {
        "account_status",
        "must_change_password",
        "mfa_enabled",
        "locked_until",
        "last_login_at",
    } <= fields
    assert not fields & {
        "password_hash",
        "mfa_secret_ciphertext",
        "mfa_secret_key_version",
        "mfa_last_accepted_step",
        "failed_password_attempts",
        "failed_mfa_attempts",
    }


def test_token_hashes_use_one_unique_constraint_without_redundant_indexes() -> None:
    for model in (BrowserAuthChallenge, BrowserRefreshSession):
        token_indexes = [
            index
            for index in model.__table__.indexes
            if "token_hash" in {column.name for column in index.columns}
        ]
        token_constraints = [
            constraint
            for constraint in model.__table__.constraints
            if isinstance(constraint, UniqueConstraint)
            and "token_hash" in {column.name for column in constraint.columns}
        ]

        assert token_indexes == []
        assert len(token_constraints) == 1


def test_user_email_keeps_unique_constraint_and_lowercase_lookup_index() -> None:
    email_constraints = [
        constraint
        for constraint in User.__table__.constraints
        if isinstance(constraint, UniqueConstraint)
        and {column.name for column in constraint.columns} == {"email"}
    ]
    email_indexes = {
        index.name: index.unique
        for index in User.__table__.indexes
        if "email" in {column.name for column in index.columns}
    }

    assert len(email_constraints) == 1
    assert email_indexes == {"ix_users_email_lower": False}
