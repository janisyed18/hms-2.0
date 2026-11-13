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
    AuthenticatedSession,
    BrowserAuthError,
    BrowserAuthService,
    IssuedChallenge,
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
    monkeypatch.setattr(settings, "auth_mfa_required", True, raising=False)


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


def _issued_challenge(
    result: IssuedChallenge | AuthenticatedSession,
) -> IssuedChallenge:
    assert isinstance(result, IssuedChallenge)
    return result


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
    challenge = _issued_challenge(
        await _service().login(session, email="USER@example.com", password=PASSWORD)
    )
    assert challenge.stage == BrowserAuthStage.PASSWORD_CHANGE_REQUIRED.value


@pytest.mark.asyncio
async def test_login_routes_to_mfa_enrollment(session: AsyncSession) -> None:
    await _make_user(session)
    challenge = _issued_challenge(
        await _service().login(session, email=EMAIL, password=PASSWORD)
    )
    assert challenge.stage == BrowserAuthStage.MFA_ENROLLMENT_REQUIRED.value


@pytest.mark.asyncio
async def test_login_routes_to_mfa_required(session: AsyncSession) -> None:
    await _make_user(session, totp_secret=pyotp.random_base32())
    challenge = _issued_challenge(
        await _service().login(session, email=EMAIL, password=PASSWORD)
    )
    assert challenge.stage == BrowserAuthStage.MFA_REQUIRED.value


@pytest.mark.asyncio
async def test_login_bypasses_mfa_when_not_required(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _make_user(session, totp_secret=pyotp.random_base32())
    monkeypatch.setattr(settings, "auth_mfa_required", False, raising=False)

    result = await _service().login(session, email=EMAIL, password=PASSWORD)

    assert isinstance(result, AuthenticatedSession)
    assert result.access_token


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
    challenge = _issued_challenge(
        await service.login(session, email=EMAIL, password=PASSWORD)
    )
    advanced = _issued_challenge(
        await service.change_password(
            session, challenge=challenge.raw, new_password="A-New-Str0ng-Passphrase"
        )
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
    challenge = _issued_challenge(
        await service.login(session, email=EMAIL, password=PASSWORD)
    )
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
    challenge = _issued_challenge(
        await service.login(session, email=EMAIL, password=PASSWORD)
    )
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

    challenge = _issued_challenge(
        await service.login(session, email=EMAIL, password=PASSWORD)
    )
    result = await service.verify_mfa(session, challenge=challenge.raw, code=code)
    assert result.refresh_token

    # Fresh challenge, same 30s-step code -> replay must be rejected.
    challenge2 = _issued_challenge(
        await service.login(session, email=EMAIL, password=PASSWORD)
    )
    with pytest.raises(BrowserAuthError):
        await service.verify_mfa(session, challenge=challenge2.raw, code=code)


@pytest.mark.asyncio
async def test_wrong_stage_is_rejected(session: AsyncSession) -> None:
    await _make_user(session)  # enrollment stage
    service = _service()
    challenge = _issued_challenge(
        await service.login(session, email=EMAIL, password=PASSWORD)
    )
    with pytest.raises(BrowserAuthError):
        await service.verify_mfa(session, challenge=challenge.raw, code="000000")


@pytest.mark.asyncio
async def test_challenge_expiry_is_rejected(session: AsyncSession) -> None:
    secret = pyotp.random_base32()
    await _make_user(session, totp_secret=secret)
    issuer = _service(now=NOW)
    challenge = _issued_challenge(
        await issuer.login(session, email=EMAIL, password=PASSWORD)
    )
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
    challenge = _issued_challenge(
        await service.login(session, email=EMAIL, password=PASSWORD)
    )
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
    challenge = _issued_challenge(
        await service.login(session, email=EMAIL, password=PASSWORD)
    )
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
    challenge = _issued_challenge(
        await service.login(session, email=EMAIL, password=PASSWORD)
    )
    authed = await service.verify_mfa(
        session, challenge=challenge.raw, code=pyotp.TOTP(secret).at(NOW)
    )
    await service.logout(session, refresh_token=authed.refresh_token)
    await service.logout(session, refresh_token=authed.refresh_token)  # no error
    with pytest.raises(BrowserAuthError):
        await service.refresh(session, refresh_token=authed.refresh_token)


# --- absolute lifetime and rotation grace ----------------------------------------


async def _signed_in(session: AsyncSession, at: datetime = NOW) -> AuthenticatedSession:
    secret = pyotp.random_base32()
    await _make_user(session, totp_secret=secret)
    service = _service(at)
    challenge = _issued_challenge(
        await service.login(session, email=EMAIL, password=PASSWORD)
    )
    return await service.verify_mfa(
        session, challenge=challenge.raw, code=pyotp.TOTP(secret).at(at)
    )


def _long_idle(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep idle expiry out of the way so the absolute lifetime is what is tested."""
    monkeypatch.setattr(
        settings, "auth_browser_refresh_idle_ttl_seconds", 60 * 60 * 24 * 60
    )


def _absolute() -> timedelta:
    return timedelta(seconds=settings.auth_browser_refresh_absolute_ttl_seconds)


def _naive_utc(value: datetime) -> datetime:
    return value.astimezone(UTC).replace(tzinfo=None)


@pytest.mark.asyncio
async def test_rotation_never_extends_the_absolute_expiry(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _long_idle(monkeypatch)
    authed = await _signed_in(session)
    original = NOW + _absolute()
    token = authed.refresh_token
    assert token is not None
    when = NOW
    for _ in range(5):  # a session used every day for five days
        when += timedelta(days=1)
        rotated = await _service(when).refresh(session, refresh_token=token)
        assert rotated.refresh_token is not None
        token = rotated.refresh_token
    rows = (await session.scalars(select(BrowserRefreshSession))).all()
    assert len(rows) == 6
    assert {_naive_utc(_aware_utc(row.expires_at)) for row in rows} == {
        _naive_utc(original)
    }
    # The cookie only ever lives for what is left, not a fresh full lifetime.
    assert rotated.refresh_max_age == int((original - when).total_seconds())
    assert rotated.refresh_max_age < settings.auth_browser_refresh_absolute_ttl_seconds


def _aware_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


@pytest.mark.asyncio
async def test_absolute_expiry_boundary_is_exclusive(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _long_idle(monkeypatch)
    authed = await _signed_in(session)
    token = authed.refresh_token
    assert token is not None
    deadline = NOW + _absolute()
    just_before = await _service(deadline - timedelta(seconds=1)).refresh(
        session, refresh_token=token
    )
    assert just_before.refresh_max_age == 1
    assert just_before.refresh_token is not None
    # The successor is no longer valid at the original deadline, however recently used.
    with pytest.raises(BrowserAuthError):
        await _service(deadline).refresh(
            session, refresh_token=just_before.refresh_token
        )


@pytest.mark.asyncio
async def test_a_refresh_past_the_absolute_expiry_is_refused_even_if_active(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _long_idle(monkeypatch)
    authed = await _signed_in(session)
    token = authed.refresh_token
    assert token is not None
    when = NOW
    # Daily activity keeps the idle window open all month, but not past day 30.
    for _ in range(29):
        when += timedelta(days=1)
        result = await _service(when).refresh(session, refresh_token=token)
        assert result.refresh_token is not None
        token = result.refresh_token
    with pytest.raises(BrowserAuthError):
        await _service(NOW + _absolute()).refresh(session, refresh_token=token)


@pytest.mark.asyncio
async def test_idle_expiry_never_outlives_the_absolute_expiry(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _long_idle(monkeypatch)
    authed = await _signed_in(session)
    token = authed.refresh_token
    assert token is not None
    when = NOW + _absolute() - timedelta(minutes=5)
    await _service(when).refresh(session, refresh_token=token)
    newest = await session.scalar(
        select(BrowserRefreshSession).where(
            BrowserRefreshSession.revoked_at.is_(None)
        )
    )
    assert newest is not None
    assert _aware_utc(newest.idle_expires_at) == NOW + _absolute()


@pytest.mark.asyncio
async def test_rotation_records_the_successor(session: AsyncSession) -> None:
    authed = await _signed_in(session)
    assert authed.refresh_token is not None
    await _service().refresh(session, refresh_token=authed.refresh_token)
    old = await session.scalar(
        select(BrowserRefreshSession).where(
            BrowserRefreshSession.revoked_at.is_not(None)
        )
    )
    new = await session.scalar(
        select(BrowserRefreshSession).where(
            BrowserRefreshSession.revoked_at.is_(None)
        )
    )
    assert old is not None and new is not None
    assert old.replaced_by_id == new.id
    assert old.family_id == new.family_id


def _graced(monkeypatch: pytest.MonkeyPatch, seconds: int = 5) -> None:
    monkeypatch.setattr(
        settings, "auth_browser_refresh_reuse_grace_seconds", seconds, raising=False
    )


async def _live_count(session: AsyncSession) -> int:
    return int(
        await session.scalar(
            select(func.count())
            .select_from(BrowserRefreshSession)
            .where(BrowserRefreshSession.revoked_at.is_(None))
        )
        or 0
    )


@pytest.mark.asyncio
async def test_grace_answers_a_raced_refresh_without_a_second_refresh_token(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _graced(monkeypatch)
    authed = await _signed_in(session)
    assert authed.refresh_token is not None
    winner = await _service().refresh(session, refresh_token=authed.refresh_token)
    raced = await _service(NOW + timedelta(seconds=5)).refresh(
        session, refresh_token=authed.refresh_token
    )
    assert raced.access_token
    assert raced.refresh_token is None  # nothing a thief could keep
    assert winner.refresh_token is not None
    assert await _live_count(session) == 1  # one live successor, no second child
    # The winner's token still works afterwards.
    await _service(NOW + timedelta(seconds=6)).refresh(
        session, refresh_token=winner.refresh_token
    )


@pytest.mark.asyncio
async def test_reuse_after_the_grace_window_still_burns_the_family(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _graced(monkeypatch)
    authed = await _signed_in(session)
    assert authed.refresh_token is not None
    await _service().refresh(session, refresh_token=authed.refresh_token)
    with pytest.raises(BrowserAuthError):
        await _service(NOW + timedelta(seconds=6)).refresh(
            session, refresh_token=authed.refresh_token
        )
    assert await _live_count(session) == 0


@pytest.mark.asyncio
async def test_grace_is_off_by_default_so_reuse_is_strict(
    session: AsyncSession,
) -> None:
    assert settings.auth_browser_refresh_reuse_grace_seconds == 0
    authed = await _signed_in(session)
    assert authed.refresh_token is not None
    await _service().refresh(session, refresh_token=authed.refresh_token)
    with pytest.raises(BrowserAuthError):
        await _service().refresh(session, refresh_token=authed.refresh_token)
    assert await _live_count(session) == 0


@pytest.mark.asyncio
async def test_grace_never_applies_after_logout_or_a_security_event(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _graced(monkeypatch)
    authed = await _signed_in(session)
    assert authed.refresh_token is not None
    winner = await _service().refresh(session, refresh_token=authed.refresh_token)
    assert winner.refresh_token is not None
    # The successor was signed out (or the family revoked) inside the window.
    await _service().logout(session, refresh_token=winner.refresh_token)
    with pytest.raises(BrowserAuthError):
        await _service().refresh(session, refresh_token=authed.refresh_token)


@pytest.mark.asyncio
async def test_grace_does_not_apply_to_a_token_revoked_by_logout(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _graced(monkeypatch)
    authed = await _signed_in(session)
    assert authed.refresh_token is not None
    await _service().logout(session, refresh_token=authed.refresh_token)
    with pytest.raises(BrowserAuthError):
        await _service().refresh(session, refresh_token=authed.refresh_token)


@pytest.mark.asyncio
async def test_grace_respects_an_account_that_became_unusable(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _graced(monkeypatch)
    authed = await _signed_in(session)
    assert authed.refresh_token is not None
    await _service().refresh(session, refresh_token=authed.refresh_token)
    user = await session.scalar(select(User))
    assert user is not None
    user.account_status = "DISABLED"
    await session.flush()
    with pytest.raises(BrowserAuthError):
        await _service(NOW + timedelta(seconds=1)).refresh(
            session, refresh_token=authed.refresh_token
        )
