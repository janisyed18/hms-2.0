"""BrowserAuthService state-machine tests (Task 3)."""

from __future__ import annotations

import base64
import secrets
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pyotp
import pytest
import pytest_asyncio
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from hms_backend.app.core import mfa
from hms_backend.app.core.config import settings
from hms_backend.app.core.passwords import hash_password
from hms_backend.app.models import foundation  # noqa: F401 - register AuditEvent
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets import models as _assets  # noqa: F401
from hms_backend.app.modules.certificates import models as _certs  # noqa: F401
from hms_backend.app.modules.customers import models as _customers  # noqa: F401
from hms_backend.app.modules.identity.browser_auth import (
    BrowserAuthError,
    BrowserAuthService,
)
from hms_backend.app.modules.identity.models import (
    BrowserAuthStage,
    BrowserRefreshSession,
    MfaRecoveryCode,
    User,
)
from hms_backend.app.modules.inspections import models as _insp  # noqa: F401
from hms_backend.app.modules.notifications import models as _notif  # noqa: F401
from hms_backend.app.modules.products import models as _products  # noqa: F401
from hms_backend.app.modules.reference import models as _reference  # noqa: F401
from hms_backend.app.modules.scheduling import models as _sched  # noqa: F401

NOW = datetime(2026, 7, 12, 12, 0, 0, tzinfo=UTC)
PASSWORD = "Sup3r-Secret-Passphrase!"
EMAIL = "user@example.com"


@pytest.fixture(autouse=True)
def _auth_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "environment", "test")
    monkeypatch.setattr(settings, "auth_bearer_hmac_secret", "unit-test-signing-secret")
    key = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")
    monkeypatch.setattr(settings, "auth_mfa_encryption_key", key)
    monkeypatch.setattr(settings, "auth_recovery_code_pepper", "unit-test-pepper")


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


def _service(now: datetime = NOW) -> BrowserAuthService:
    return BrowserAuthService(now=lambda: now)


async def _make_user(
    session: AsyncSession,
    *,
    must_change: bool = False,
    totp_secret: str | None = None,
) -> User:
    user = User(
        oidc_subject="user-sub",
        email=EMAIL,
        role="HMS_ADMIN",
        password_hash=hash_password(PASSWORD),
        must_change_password=must_change,
    )
    session.add(user)
    await session.flush()
    if totp_secret is not None:
        encrypted = mfa.encrypt_totp_secret(totp_secret, user_id=user.id)
        user.mfa_secret_ciphertext = encrypted.ciphertext
        user.mfa_secret_key_version = encrypted.key_version
        user.mfa_enabled = True
        await session.flush()
    return user


# --- login stage routing --------------------------------------------------------


@pytest.mark.asyncio
async def test_login_routes_to_password_change(session: AsyncSession) -> None:
    await _make_user(session, must_change=True)
    challenge = await _service().login(
        session, email="USER@example.com", password=PASSWORD
    )
    assert challenge.stage == BrowserAuthStage.PASSWORD_CHANGE_REQUIRED.value


@pytest.mark.asyncio
async def test_login_routes_to_mfa_enrollment(session: AsyncSession) -> None:
    await _make_user(session)
    challenge = await _service().login(session, email=EMAIL, password=PASSWORD)
    assert challenge.stage == BrowserAuthStage.MFA_ENROLLMENT_REQUIRED.value


@pytest.mark.asyncio
async def test_login_routes_to_mfa_required(session: AsyncSession) -> None:
    await _make_user(session, totp_secret=pyotp.random_base32())
    challenge = await _service().login(session, email=EMAIL, password=PASSWORD)
    assert challenge.stage == BrowserAuthStage.MFA_REQUIRED.value


@pytest.mark.asyncio
async def test_login_wrong_password_is_generic_and_counts(
    session: AsyncSession,
) -> None:
    user = await _make_user(session)
    with pytest.raises(BrowserAuthError):
        await _service().login(session, email=EMAIL, password="wrong-one")
    assert user.failed_password_attempts == 1


@pytest.mark.asyncio
async def test_login_unknown_email_is_generic(session: AsyncSession) -> None:
    with pytest.raises(BrowserAuthError):
        await _service().login(session, email="nobody@example.com", password=PASSWORD)


# --- password change ------------------------------------------------------------


@pytest.mark.asyncio
async def test_change_password_advances_and_revokes_sessions(
    session: AsyncSession,
) -> None:
    user = await _make_user(session, must_change=True)
    # Pre-existing session that must be revoked when the password changes.
    session.add(
        BrowserRefreshSession(
            user_id=user.id,
            family_id="fam",
            token_hash="pre-existing",
            expires_at=NOW + timedelta(days=30),
            idle_expires_at=NOW + timedelta(hours=8),
        )
    )
    await session.flush()
    service = _service()
    challenge = await service.login(session, email=EMAIL, password=PASSWORD)
    advanced = await service.change_password(
        session, challenge=challenge.raw, new_password="A-New-Str0ng-Passphrase"
    )
    assert advanced.stage == BrowserAuthStage.MFA_ENROLLMENT_REQUIRED.value
    assert user.must_change_password is False
    revoked = await session.scalar(
        select(func.count()).select_from(BrowserRefreshSession).where(
            BrowserRefreshSession.revoked_at.is_(None)
        )
    )
    assert revoked == 0


@pytest.mark.asyncio
async def test_change_password_rejects_weak(session: AsyncSession) -> None:
    await _make_user(session, must_change=True)
    service = _service()
    challenge = await service.login(session, email=EMAIL, password=PASSWORD)
    with pytest.raises(BrowserAuthError):
        await service.change_password(
            session, challenge=challenge.raw, new_password="short"
        )


# --- MFA enrollment + verification ----------------------------------------------


@pytest.mark.asyncio
async def test_enrollment_encrypts_secret_and_returns_recovery_codes(
    session: AsyncSession,
) -> None:
    user = await _make_user(session)
    service = _service()
    challenge = await service.login(session, email=EMAIL, password=PASSWORD)
    enrollment = await service.start_mfa_enrollment(session, challenge=challenge.raw)
    assert enrollment.otpauth_uri.startswith("otpauth://totp/")
    assert user.mfa_secret_ciphertext is not None
    assert enrollment.manual_key not in user.mfa_secret_ciphertext  # stored encrypted

    code = pyotp.TOTP(enrollment.manual_key).at(NOW)
    result = await service.confirm_mfa_enrollment(
        session, challenge=challenge.raw, code=code
    )
    assert result.recovery_codes is not None
    assert len(result.recovery_codes) == 10
    assert result.access_token and result.refresh_token
    assert user.mfa_enabled is True
    assert user.last_login_at is not None


@pytest.mark.asyncio
async def test_verify_mfa_success_then_replay_rejected(session: AsyncSession) -> None:
    secret = pyotp.random_base32()
    await _make_user(session, totp_secret=secret)
    service = _service()
    code = pyotp.TOTP(secret).at(NOW)

    challenge = await service.login(session, email=EMAIL, password=PASSWORD)
    result = await service.verify_mfa(session, challenge=challenge.raw, code=code)
    assert result.refresh_token

    # Fresh challenge, same 30s-step code -> replay must be rejected.
    challenge2 = await service.login(session, email=EMAIL, password=PASSWORD)
    with pytest.raises(BrowserAuthError):
        await service.verify_mfa(session, challenge=challenge2.raw, code=code)


@pytest.mark.asyncio
async def test_wrong_stage_is_rejected(session: AsyncSession) -> None:
    await _make_user(session)  # enrollment stage
    service = _service()
    challenge = await service.login(session, email=EMAIL, password=PASSWORD)
    with pytest.raises(BrowserAuthError):
        await service.verify_mfa(session, challenge=challenge.raw, code="000000")


@pytest.mark.asyncio
async def test_challenge_expiry_is_rejected(session: AsyncSession) -> None:
    secret = pyotp.random_base32()
    await _make_user(session, totp_secret=secret)
    issuer = _service(now=NOW)
    challenge = await issuer.login(session, email=EMAIL, password=PASSWORD)
    ttl = settings.auth_browser_challenge_ttl_seconds
    later = _service(now=NOW + timedelta(seconds=ttl + 1))
    with pytest.raises(BrowserAuthError):
        await later.verify_mfa(
            session, challenge=challenge.raw, code=pyotp.TOTP(secret).at(NOW)
        )


# --- recovery codes -------------------------------------------------------------


@pytest.mark.asyncio
async def test_recovery_code_login_consumes_code(session: AsyncSession) -> None:
    user = await _make_user(session, totp_secret=pyotp.random_base32())
    code = "ABCD-EFGH-JKLM"
    session.add(
        MfaRecoveryCode(user_id=user.id, code_digest=mfa.recovery_code_digest(code))
    )
    await session.flush()
    service = _service()
    challenge = await service.login(session, email=EMAIL, password=PASSWORD)
    result = await service.verify_recovery_code(
        session, challenge=challenge.raw, code=code
    )
    assert result.refresh_token
    remaining = await session.scalar(
        select(func.count()).select_from(MfaRecoveryCode).where(
            MfaRecoveryCode.consumed_at.is_(None)
        )
    )
    assert remaining == 0


# --- refresh rotation + reuse detection -----------------------------------------


@pytest.mark.asyncio
async def test_refresh_rotates_and_reuse_revokes_family(session: AsyncSession) -> None:
    secret = pyotp.random_base32()
    await _make_user(session, totp_secret=secret)
    service = _service()
    challenge = await service.login(session, email=EMAIL, password=PASSWORD)
    authed = await service.verify_mfa(
        session, challenge=challenge.raw, code=pyotp.TOTP(secret).at(NOW)
    )

    rotated = await service.refresh(session, refresh_token=authed.refresh_token)
    assert rotated.refresh_token != authed.refresh_token

    # Reusing the old (now revoked) token is treated as theft: whole family dies.
    with pytest.raises(BrowserAuthError):
        await service.refresh(session, refresh_token=authed.refresh_token)
    active = await session.scalar(
        select(func.count()).select_from(BrowserRefreshSession).where(
            BrowserRefreshSession.revoked_at.is_(None)
        )
    )
    assert active == 0


@pytest.mark.asyncio
async def test_logout_is_idempotent(session: AsyncSession) -> None:
    secret = pyotp.random_base32()
    await _make_user(session, totp_secret=secret)
    service = _service()
    challenge = await service.login(session, email=EMAIL, password=PASSWORD)
    authed = await service.verify_mfa(
        session, challenge=challenge.raw, code=pyotp.TOTP(secret).at(NOW)
    )
    await service.logout(session, refresh_token=authed.refresh_token)
    await service.logout(session, refresh_token=authed.refresh_token)  # no error
    with pytest.raises(BrowserAuthError):
        await service.refresh(session, refresh_token=authed.refresh_token)
