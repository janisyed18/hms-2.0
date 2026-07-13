from __future__ import annotations

import base64
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from hms_backend.app.core.config import settings
from hms_backend.app.core.passwords import hash_password
from hms_backend.app.core.redis import set_redis_client
from hms_backend.app.models import foundation  # noqa: F401
from hms_backend.app.models.base import Base

# Register all tables used by Base.metadata.create_all.
from hms_backend.app.modules.assets import models as _assets  # noqa: F401, E402
from hms_backend.app.modules.certificates import models as _certs  # noqa: F401, E402
from hms_backend.app.modules.customers import models as _customers  # noqa: F401, E402
from hms_backend.app.modules.identity.models import (
    AccountStatus,
    BrowserRefreshSession,
    PasswordResetDelivery,
    PasswordResetToken,
    User,
)
from hms_backend.app.modules.identity.password_reset import (
    GENERIC_RESET_MESSAGE,
    INVALID_RESET_ERROR,
    PasswordResetService,
)
from hms_backend.app.modules.inspections import (
    models as _inspections,  # noqa: F401, E402
)
from hms_backend.app.modules.notifications import (
    models as _notifications,  # noqa: F401, E402
)
from hms_backend.app.modules.products import models as _products  # noqa: F401, E402
from hms_backend.app.modules.reference import models as _reference  # noqa: F401, E402
from hms_backend.app.modules.scheduling import models as _scheduling  # noqa: F401, E402

NOW = datetime(2026, 7, 13, 12, 0, tzinfo=UTC)
PASSWORD = "Sup3r-Secret-Passphrase!"
EMAIL = "reset@example.com"


@pytest.fixture(autouse=True)
def reset_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "environment", "test")
    reset_key = base64.urlsafe_b64encode(b"r" * 32).decode()
    monkeypatch.setattr(settings, "auth_password_reset_encryption_key", reset_key)
    monkeypatch.setattr(settings, "auth_password_reset_key_version", 1)
    monkeypatch.setattr(settings, "auth_password_reset_ttl_seconds", 900)
    monkeypatch.setattr(settings, "auth_password_reset_rate_limit_max_attempts", 3)
    monkeypatch.setattr(settings, "auth_password_reset_rate_limit_window_seconds", 900)
    set_redis_client(None)


@pytest_asyncio.fixture
async def session() -> AsyncGenerator[AsyncSession]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")

    @event.listens_for(engine.sync_engine, "connect")
    def _fk(dbapi_connection, _record) -> None:  # type: ignore[no-untyped-def]
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with AsyncSession(engine, expire_on_commit=False) as test_session:
        yield test_session
    await engine.dispose()


def service() -> PasswordResetService:
    return PasswordResetService(now=lambda: NOW)


async def make_user(
    session: AsyncSession,
    *,
    status: AccountStatus = AccountStatus.ACTIVE,
    mfa: bool = True,
) -> User:
    user = User(
        oidc_subject="reset-subject",
        email=EMAIL,
        role="HMS_ADMIN",
        password_hash=hash_password(PASSWORD),
        account_status=status.value,
        mfa_enabled=mfa,
        mfa_secret_ciphertext="mfa-ciphertext" if mfa else None,
        mfa_secret_key_version=1 if mfa else None,
    )
    session.add(user)
    await session.flush()
    return user


@pytest.mark.asyncio
async def test_request_returns_generic_message_and_creates_encrypted_delivery(
    session: AsyncSession,
) -> None:
    user = await make_user(session)

    message = await service().request(
        session, email=user.email, ip="127.0.0.1", user_agent="pytest"
    )

    assert message == GENERIC_RESET_MESSAGE
    reset = await session.scalar(select(PasswordResetToken))
    delivery = await session.scalar(select(PasswordResetDelivery))
    assert reset is not None
    assert delivery is not None
    assert delivery.ciphertext
    assert user.email not in delivery.ciphertext


@pytest.mark.asyncio
async def test_request_is_generic_and_side_effect_free_for_unknown_or_disabled(
    session: AsyncSession,
) -> None:
    disabled = await make_user(session, status=AccountStatus.DISABLED)
    before = await session.scalar(select(func.count()).select_from(PasswordResetToken))

    assert (
        await service().request(
            session, email="nobody@example.com", ip="127.0.0.1", user_agent=None
        )
        == GENERIC_RESET_MESSAGE
    )
    assert (
        await service().request(
            session, email=disabled.email, ip="127.0.0.1", user_agent=None
        )
        == GENERIC_RESET_MESSAGE
    )
    after = await session.scalar(select(func.count()).select_from(PasswordResetToken))
    assert after == before


@pytest.mark.asyncio
async def test_new_request_supersedes_previous_token(session: AsyncSession) -> None:
    user = await make_user(session)
    reset_service = service()
    await reset_service.request(
        session, email=user.email, ip="127.0.0.1", user_agent=None
    )
    first = await session.scalar(select(PasswordResetToken))

    await reset_service.request(
        session, email=user.email, ip="127.0.0.2", user_agent=None
    )
    rows = list((await session.scalars(select(PasswordResetToken))).all())

    assert first is not None
    assert first.superseded_at == NOW
    assert len(rows) == 2


@pytest.mark.asyncio
async def test_confirm_changes_password_revokes_sessions_and_preserves_mfa(
    session: AsyncSession,
) -> None:
    user = await make_user(session)
    original_mfa = (
        user.mfa_enabled,
        user.mfa_secret_ciphertext,
        user.mfa_secret_key_version,
    )
    session.add(
        BrowserRefreshSession(
            user_id=user.id,
            family_id="family-1",
            token_hash="refresh-hash",
            expires_at=NOW + timedelta(days=1),
            idle_expires_at=NOW + timedelta(hours=1),
        )
    )
    await session.flush()
    reset_service = service()
    await reset_service.request(
        session, email=user.email, ip="127.0.0.1", user_agent=None
    )
    delivery = await session.scalar(select(PasswordResetDelivery))
    assert delivery is not None
    from hms_backend.app.core.password_reset_tokens import (
        EncryptedPasswordResetDelivery,
        decrypt_password_reset_delivery,
    )

    raw = decrypt_password_reset_delivery(
        EncryptedPasswordResetDelivery(delivery.ciphertext or "", delivery.key_version),
        reset_id=delivery.reset_id,
        user_id=user.id,
    )

    await reset_service.confirm(
        session, token=raw, new_password="N3w-Reset-Passphrase!"
    )

    assert user.password_hash != hash_password(PASSWORD)
    assert user.password_changed_at == NOW
    assert user.failed_password_attempts == 0
    assert user.locked_until is None
    assert (
        user.mfa_enabled,
        user.mfa_secret_ciphertext,
        user.mfa_secret_key_version,
    ) == original_mfa
    assert (
        await session.scalar(
            select(func.count())
            .select_from(BrowserRefreshSession)
            .where(BrowserRefreshSession.revoked_at.is_(None))
        )
        == 0
    )
    reset = await session.get(PasswordResetToken, delivery.reset_id)
    assert reset is not None
    assert reset.consumed_at is not None
    assert reset.consumed_at.replace(tzinfo=UTC) == NOW
    assert delivery.ciphertext is None


@pytest.mark.asyncio
async def test_confirm_rejects_second_use_with_one_generic_error(
    session: AsyncSession,
) -> None:
    user = await make_user(session, mfa=False)
    reset_service = service()
    await reset_service.request(session, email=user.email, ip=None, user_agent=None)
    delivery = await session.scalar(select(PasswordResetDelivery))
    assert delivery is not None and delivery.ciphertext is not None
    from hms_backend.app.core.password_reset_tokens import (
        EncryptedPasswordResetDelivery,
        decrypt_password_reset_delivery,
    )

    raw = decrypt_password_reset_delivery(
        EncryptedPasswordResetDelivery(delivery.ciphertext, delivery.key_version),
        reset_id=delivery.reset_id,
        user_id=user.id,
    )
    await reset_service.confirm(
        session, token=raw, new_password="N3w-Reset-Passphrase!"
    )

    with pytest.raises(ValueError, match=INVALID_RESET_ERROR):
        await reset_service.confirm(
            session, token=raw, new_password="N3w-Reset-Passphrase!"
        )
