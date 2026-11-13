"""Staff browser authentication state machine (Task 3).

Drives the multi-step browser login: password check -> (forced password change)
-> (TOTP enrollment) -> TOTP/recovery verification -> rotating refresh session.
Every intermediate step hands back only a short-lived opaque challenge; a refresh
session and access token are minted only once the final MFA step succeeds.

Security properties enforced here:
* Login failures are generic (no account-existence leak); the reason is recorded
  only in a redacted audit event with a keyed (non-reversible) email identifier.
* TOTP secrets are decrypted per-use and same-time-step replay is rejected.
* Refresh tokens rotate on every use; presenting a rotated (revoked) token is
  treated as theft and revokes the whole token family.
* Credential/security changes revoke all of the user's browser sessions.
"""

from __future__ import annotations

import hashlib
import hmac
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from uuid6 import uuid7

from hms_backend.app.core import mfa
from hms_backend.app.core.audit import append_audit_event
from hms_backend.app.core.auth import encode_hs256_bearer_token
from hms_backend.app.core.config import Settings, settings
from hms_backend.app.core.mfa import EncryptedTotpSecret
from hms_backend.app.core.passwords import (
    hash_password,
    validate_password_policy,
    verify_password,
)
from hms_backend.app.core.session_tokens import (
    digest_opaque_token,
    generate_opaque_token,
)
from hms_backend.app.modules.identity.credentials import rotate_credentials
from hms_backend.app.modules.identity.models import (
    AccountStatus,
    BrowserAuthChallenge,
    BrowserAuthStage,
    BrowserRefreshSession,
    MfaRecoveryCode,
    User,
)

_GENERIC_LOGIN_ERROR = "Invalid email or password"
_REAUTH_ERROR = "That password or code was not correct."
_GENERIC_CHALLENGE_ERROR = "Your session has expired; please sign in again."


class BrowserAuthError(Exception):
    """Auth failure surfaced to clients without detail leakage."""


class SessionEndedError(BrowserAuthError):
    """The browser session cannot be used any more (revoked, expired, mismatched)."""


class RateLimitedError(BrowserAuthError):
    def __init__(self, retry_after_seconds: int) -> None:
        super().__init__("Too many attempts; please wait and try again.")
        self.retry_after_seconds = retry_after_seconds


@dataclass(frozen=True)
class IssuedChallenge:
    raw: str
    stage: str
    expires_in: int


@dataclass(frozen=True)
class EnrollmentInfo:
    otpauth_uri: str
    manual_key: str


@dataclass(frozen=True)
class AuthenticatedSession:
    access_token: str
    expires_in: int
    refresh_token: str
    # Seconds of absolute session life left, for the cookie lifetime.
    refresh_max_age: int
    recovery_codes: tuple[str, ...] | None = None


@dataclass(frozen=True)
class RefreshResult:
    access_token: str
    expires_in: int
    # None only when a refresh lands in the rotation grace window: the caller keeps the
    # cookie it already holds, which belongs to the successor session.
    refresh_token: str | None
    # Seconds of absolute session life left. Rotation never extends it past the family's
    # original absolute expiry.
    refresh_max_age: int


class BrowserAuthService:
    def __init__(
        self,
        *,
        config: Settings = settings,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._settings = config
        self._now = now or (lambda: datetime.now(UTC))

    # -- public state transitions ------------------------------------------------

    async def login(
        self,
        session: AsyncSession,
        *,
        email: str,
        password: str,
        user_agent: str | None = None,
        ip: str | None = None,
    ) -> IssuedChallenge | AuthenticatedSession:
        user = await self._user_by_email(session, email, for_update=True)
        if (
            user is None
            or user.password_hash is None
            or not verify_password(user.password_hash, password)
        ):
            if user is not None:
                user.failed_password_attempts += 1
                self._maybe_lock(user)
            await self._audit(
                session,
                user,
                email=email,
                action="auth.login.failed",
                detail={"reason": "bad_credentials"},
            )
            raise BrowserAuthError(_GENERIC_LOGIN_ERROR)

        self._ensure_usable(user)
        user.failed_password_attempts = 0
        if not user.must_change_password and not self._settings.auth_mfa_required:
            await self._audit(
                session, user, email=user.email, action="auth.login.password"
            )
            return await self._finalise(session, user, user_agent=user_agent, ip=ip)
        return await self._issue_challenge(session, user, self._initial_stage(user))

    async def change_password(
        self,
        session: AsyncSession,
        *,
        challenge: str,
        new_password: str,
        user_agent: str | None = None,
        ip: str | None = None,
    ) -> IssuedChallenge | AuthenticatedSession:
        record, user = await self._consume_challenge(
            session, challenge, BrowserAuthStage.PASSWORD_CHANGE_REQUIRED
        )
        policy = validate_password_policy(new_password)
        if not policy.valid:
            # Password errors are safe to surface (they help the user, not an
            # attacker probing account existence).
            record.consumed_at = None  # allow retry with the same challenge
            raise BrowserAuthError(" ".join(policy.errors))

        user.password_hash = hash_password(new_password)
        user.must_change_password = False
        user.password_changed_at = self._now()
        await rotate_credentials(session, user)
        await self._audit(
            session, user, email=user.email, action="auth.password.changed"
        )
        if not self._settings.auth_mfa_required:
            return await self._finalise(session, user, user_agent=user_agent, ip=ip)
        return await self._issue_challenge(
            session, user, self._post_password_stage(user)
        )

    async def start_mfa_enrollment(
        self, session: AsyncSession, *, challenge: str
    ) -> EnrollmentInfo:
        record, user = await self._load_challenge(
            session, challenge, BrowserAuthStage.MFA_ENROLLMENT_REQUIRED
        )
        secret = mfa.generate_totp_secret()
        encrypted = mfa.encrypt_totp_secret(secret, user_id=user.id)
        user.mfa_secret_ciphertext = encrypted.ciphertext
        user.mfa_secret_key_version = encrypted.key_version
        await session.flush()
        await self._audit(
            session, user, email=user.email, action="auth.mfa.enrollment.started"
        )
        uri = mfa.build_totp_uri(
            secret, email=user.email, issuer=self._settings.auth_totp_issuer
        )
        return EnrollmentInfo(otpauth_uri=uri, manual_key=secret)

    async def confirm_mfa_enrollment(
        self,
        session: AsyncSession,
        *,
        challenge: str,
        code: str,
        user_agent: str | None = None,
        ip: str | None = None,
    ) -> AuthenticatedSession:
        record, user = await self._load_challenge(
            session, challenge, BrowserAuthStage.MFA_ENROLLMENT_REQUIRED
        )
        self._register_attempt(record)
        secret = self._decrypt_user_secret(user)
        step = mfa.verify_totp(secret, code, now=self._now())
        if step is None:
            raise BrowserAuthError("Incorrect code.")
        user.mfa_enabled = True
        user.mfa_last_accepted_step = step
        recovery_codes = await self._issue_recovery_codes(session, user)
        record.consumed_at = self._now()
        await self._audit(session, user, email=user.email, action="auth.mfa.enrolled")
        return await self._finalise(
            session, user, user_agent=user_agent, ip=ip, recovery_codes=recovery_codes
        )

    async def verify_mfa(
        self,
        session: AsyncSession,
        *,
        challenge: str,
        code: str,
        user_agent: str | None = None,
        ip: str | None = None,
    ) -> AuthenticatedSession:
        record, user = await self._load_challenge(
            session, challenge, BrowserAuthStage.MFA_REQUIRED
        )
        self._register_attempt(record)
        secret = self._decrypt_user_secret(user)
        step = mfa.verify_totp(secret, code, now=self._now())
        if step is None:
            raise BrowserAuthError("Incorrect code.")
        if (
            user.mfa_last_accepted_step is not None
            and step <= user.mfa_last_accepted_step
        ):
            # Same or older 30s window already used -> replay.
            raise BrowserAuthError("Incorrect code.")
        user.mfa_last_accepted_step = step
        record.consumed_at = self._now()
        await self._audit(session, user, email=user.email, action="auth.login.mfa")
        return await self._finalise(session, user, user_agent=user_agent, ip=ip)

    async def verify_recovery_code(
        self,
        session: AsyncSession,
        *,
        challenge: str,
        code: str,
        user_agent: str | None = None,
        ip: str | None = None,
    ) -> AuthenticatedSession:
        record, user = await self._load_challenge(
            session, challenge, BrowserAuthStage.MFA_REQUIRED
        )
        self._register_attempt(record)
        digest = mfa.recovery_code_digest(code)
        recovery = await session.scalar(
            select(MfaRecoveryCode).where(
                MfaRecoveryCode.user_id == user.id,
                MfaRecoveryCode.code_digest == digest,
                MfaRecoveryCode.consumed_at.is_(None),
            )
        )
        if recovery is None:
            raise BrowserAuthError("Invalid recovery code.")
        recovery.consumed_at = self._now()
        record.consumed_at = self._now()
        await self._audit(
            session, user, email=user.email, action="auth.login.recovery"
        )
        return await self._finalise(session, user, user_agent=user_agent, ip=ip)

    async def refresh(
        self,
        session: AsyncSession,
        *,
        refresh_token: str,
        user_agent: str | None = None,
        ip: str | None = None,
    ) -> RefreshResult:
        digest = digest_opaque_token(refresh_token)
        # Lock order is always user, then refresh session (as in credential changes and
        # reauthentication). The session is found without a lock only to learn whose it
        # is; it is locked and revalidated once the user lock is held.
        peek = await session.scalar(
            select(BrowserRefreshSession).where(
                BrowserRefreshSession.token_hash == digest
            )
        )
        if peek is None:
            raise BrowserAuthError(_GENERIC_CHALLENGE_ERROR)
        user = await self._locked_user(session, peek.user_id)
        if user is None:
            raise BrowserAuthError(_GENERIC_CHALLENGE_ERROR)
        # The row lock makes rotation atomic: concurrent requests presenting the same
        # token are serialised, exactly one rotates it, and the rest see it as already
        # rotated (reuse, or the grace window below) instead of minting a second child.
        current = await session.scalar(
            select(BrowserRefreshSession)
            .where(BrowserRefreshSession.token_hash == digest)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if current is None:
            raise BrowserAuthError(_GENERIC_CHALLENGE_ERROR)
        now = self._now()
        if current.revoked_at is not None:
            graced = await self._refresh_within_rotation_grace(
                session, current, user, now
            )
            if graced is not None:
                return graced
            # Presenting an already-rotated token means it was stolen: burn the
            # whole family so neither party keeps a valid session.
            await self._revoke_family(session, current.family_id)
            await self._audit(
                session,
                user,
                email=None,
                action="auth.refresh.reuse",
            )
            raise BrowserAuthError(_GENERIC_CHALLENGE_ERROR)
        if now >= _aware(current.expires_at) or now >= _aware(current.idle_expires_at):
            raise BrowserAuthError(_GENERIC_CHALLENGE_ERROR)
        self._ensure_usable(user)

        # Rotation never refreshes the credential-presentation time (only a sign-in or
        # a step-up does) and never renews the absolute expiry.
        new_token, new_id = self._new_refresh_session(
            session,
            user,
            family_id=current.family_id,
            user_agent=user_agent,
            ip=ip,
            auth_time=current.auth_time,
            absolute_expires_at=_aware(current.expires_at),
        )
        await session.flush()  # the successor row must exist before it is referenced
        current.revoked_at = now
        current.last_used_at = now
        current.replaced_by_id = new_id
        access_token, expires_in = self._mint_access(user, auth_time=current.auth_time)
        return RefreshResult(
            access_token=access_token,
            expires_in=expires_in,
            refresh_token=new_token,
            refresh_max_age=self._remaining_seconds(_aware(current.expires_at), now),
        )

    async def reauthenticate(
        self,
        session: AsyncSession,
        *,
        refresh_token: str,
        user_subject: str,
        password: str,
        code: str | None,
    ) -> tuple[str, int]:
        """Step-up: re-check the password (and TOTP when enrolled) for the
        browser session identified by its refresh cookie, then stamp that one
        session's ``auth_time``. Grants no roles or permissions, only freshness.
        """
        current = await session.scalar(
            select(BrowserRefreshSession).where(
                BrowserRefreshSession.token_hash == digest_opaque_token(refresh_token)
            )
        )
        now = self._now()
        if (
            current is None
            or now >= _aware(current.expires_at)
            or now >= _aware(current.idle_expires_at)
        ):
            raise SessionEndedError(_GENERIC_CHALLENGE_ERROR)
        # Serialise with refresh and credential changes (see ``_load_challenge``).
        user = await self._locked_user(session, current.user_id)
        await session.refresh(current)
        if current.revoked_at is not None:
            # A refresh that finished while this waited rotated the cookie this
            # request carries. That is not a lost session: carry on if the family is
            # still live. Logout, reuse detection and credential changes leave none.
            rotated = current.last_used_at is not None
            live = await session.scalar(
                select(BrowserRefreshSession.id).where(
                    BrowserRefreshSession.family_id == current.family_id,
                    BrowserRefreshSession.revoked_at.is_(None),
                )
            )
            if not rotated or live is None:
                raise SessionEndedError(_GENERIC_CHALLENGE_ERROR)
        # The cookie and the bearer token must describe the same account.
        if user is None or user.oidc_subject != user_subject:
            raise SessionEndedError(_GENERIC_CHALLENGE_ERROR)
        try:
            self._ensure_usable(user)
        except BrowserAuthError as exc:
            raise SessionEndedError(_GENERIC_CHALLENGE_ERROR) from exc

        failure: str | None = None
        step: int | None = None
        if user.password_hash is None or not verify_password(
            user.password_hash, password
        ):
            failure = _REAUTH_ERROR
        elif user.mfa_enabled:
            step = (
                mfa.verify_totp(self._decrypt_user_secret(user), code, now=now)
                if code
                else None
            )
            if step is None or (
                user.mfa_last_accepted_step is not None
                and step <= user.mfa_last_accepted_step
            ):
                failure = _REAUTH_ERROR
        if failure is not None:
            user.failed_password_attempts += 1
            self._maybe_lock(user)
            await self._audit(
                session,
                user,
                email=user.email,
                action="auth.reauth.failed",
            )
            raise BrowserAuthError(failure)

        user.failed_password_attempts = 0
        if step is not None:
            user.mfa_last_accepted_step = step
        # Stamp every live token of this browser session (its family) only.
        await session.execute(
            update(BrowserRefreshSession)
            .where(
                BrowserRefreshSession.family_id == current.family_id,
                BrowserRefreshSession.revoked_at.is_(None),
            )
            .values(auth_time=now)
        )
        await self._audit(session, user, email=user.email, action="auth.reauth")
        return self._mint_access(user, auth_time=now)

    async def _refresh_within_rotation_grace(
        self,
        session: AsyncSession,
        rotated: BrowserRefreshSession,
        user: User,
        now: datetime,
    ) -> RefreshResult | None:
        """Answer a request that raced the rotation of its own token, or None for reuse.

        Two tabs refreshing together send the same cookie; one rotates it and the other
        arrives a moment later holding the now-rotated token. Within a short window (off
        by default) that second request gets a fresh access token but no new refresh
        token: the browser already holds the successor from the winning response. The
        access token is still a usable credential, so someone replaying a stolen,
        just-rotated token inside the window would obtain one (for its short lifetime,
        without any way to renew it). That exposure is why the window is off by
        default. Anything else is reuse.
        """
        grace = self._settings.auth_browser_refresh_reuse_grace_seconds
        if (
            grace <= 0
            or rotated.replaced_by_id is None
            or rotated.last_used_at is None
            or now - _aware(rotated.last_used_at) > timedelta(seconds=grace)
            or now >= _aware(rotated.expires_at)
        ):
            return None
        successor = await session.scalar(
            select(BrowserRefreshSession)
            .where(BrowserRefreshSession.id == rotated.replaced_by_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if (
            successor is None
            or successor.revoked_at is not None  # out, rotated on, or burned
            or successor.family_id != rotated.family_id
            or successor.user_id != rotated.user_id
            or now >= _aware(successor.expires_at)
            or now >= _aware(successor.idle_expires_at)
        ):
            return None
        self._ensure_usable(user)
        # The successor carries the browser session's current authentication time (a
        # step-up stamps live tokens only), never "now": a refresh is not a sign-in.
        access_token, expires_in = self._mint_access(
            user, auth_time=successor.auth_time
        )
        return RefreshResult(
            access_token=access_token,
            expires_in=expires_in,
            refresh_token=None,
            refresh_max_age=self._remaining_seconds(_aware(rotated.expires_at), now),
        )

    @staticmethod
    def _remaining_seconds(expires_at: datetime, now: datetime) -> int:
        return max(int((expires_at - now).total_seconds()), 0)

    async def logout(self, session: AsyncSession, *, refresh_token: str) -> None:
        digest = digest_opaque_token(refresh_token)
        record = await session.scalar(
            select(BrowserRefreshSession).where(
                BrowserRefreshSession.token_hash == digest
            )
        )
        if record is not None and record.revoked_at is None:
            record.revoked_at = self._now()
            user = await session.get(User, record.user_id)
            await self._audit(
                session,
                user,
                email=user.email if user else None,
                action="auth.logout",
            )

    async def revoke_all_sessions(self, session: AsyncSession, user_id: str) -> None:
        await session.execute(
            update(BrowserRefreshSession)
            .where(
                BrowserRefreshSession.user_id == user_id,
                BrowserRefreshSession.revoked_at.is_(None),
            )
            .values(revoked_at=self._now())
        )

    # -- internals ---------------------------------------------------------------

    async def _user_by_email(
        self, session: AsyncSession, email: str, *, for_update: bool = False
    ) -> User | None:
        statement = select(User).where(
            User.email == email.strip().lower(), User.deleted_at.is_(None)
        )
        if for_update:
            statement = statement.with_for_update().execution_options(
                populate_existing=True
            )
        user: User | None = await session.scalar(statement)
        return user

    async def _locked_user(self, session: AsyncSession, user_id: str) -> User | None:
        """The user, row-locked and freshly read (credential version included)."""
        user: User | None = await session.scalar(
            select(User)
            .where(User.id == user_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return user

    def _initial_stage(self, user: User) -> str:
        if user.must_change_password:
            return BrowserAuthStage.PASSWORD_CHANGE_REQUIRED.value
        return self._post_password_stage(user)

    def _post_password_stage(self, user: User) -> str:
        if not user.mfa_enabled:
            return BrowserAuthStage.MFA_ENROLLMENT_REQUIRED.value
        return BrowserAuthStage.MFA_REQUIRED.value

    def _ensure_usable(self, user: User) -> None:
        now = self._now()
        if user.account_status == AccountStatus.DISABLED.value:
            raise BrowserAuthError(_GENERIC_LOGIN_ERROR)
        if user.locked_until is not None and _aware(user.locked_until) > now:
            raise BrowserAuthError(_GENERIC_LOGIN_ERROR)

    def _maybe_lock(self, user: User) -> None:
        threshold = self._settings.auth_login_account_rate_limit_max_attempts
        if user.failed_password_attempts >= threshold:
            user.account_status = AccountStatus.LOCKED.value
            user.locked_until = self._now() + timedelta(
                seconds=self._settings.auth_login_lockout_seconds
            )

    async def _issue_challenge(
        self, session: AsyncSession, user: User, stage: str
    ) -> IssuedChallenge:
        token = generate_opaque_token()
        ttl = self._settings.auth_browser_challenge_ttl_seconds
        session.add(
            BrowserAuthChallenge(
                token_hash=token.digest,
                user_id=user.id,
                stage=stage,
                credential_version=user.credential_version,
                expires_at=self._now() + timedelta(seconds=ttl),
            )
        )
        await session.flush()
        return IssuedChallenge(raw=token.raw, stage=stage, expires_in=ttl)

    async def _load_challenge(
        self, session: AsyncSession, raw: str, expected_stage: BrowserAuthStage
    ) -> tuple[BrowserAuthChallenge, User]:
        digest = digest_opaque_token(raw)
        record = await session.scalar(
            select(BrowserAuthChallenge).where(
                BrowserAuthChallenge.token_hash == digest,
                BrowserAuthChallenge.consumed_at.is_(None),
            )
        )
        if (
            record is None
            or record.stage != expected_stage.value
            or _aware(record.expires_at) <= self._now()
        ):
            raise BrowserAuthError(_GENERIC_CHALLENGE_ERROR)
        # Row-lock the user: a credential change takes the same lock, so it either
        # finishes before this reads the version (and the challenge is refused) or
        # waits until this commits (and then revokes the session created here).
        user = await self._locked_user(session, record.user_id)
        if user is None or record.credential_version != user.credential_version:
            # Issued before the user's credentials last changed.
            raise BrowserAuthError(_GENERIC_CHALLENGE_ERROR)
        self._ensure_usable(user)
        return record, user

    async def _consume_challenge(
        self, session: AsyncSession, raw: str, expected_stage: BrowserAuthStage
    ) -> tuple[BrowserAuthChallenge, User]:
        record, user = await self._load_challenge(session, raw, expected_stage)
        record.consumed_at = self._now()
        return record, user

    def _register_attempt(self, record: BrowserAuthChallenge) -> None:
        record.attempt_count += 1
        if record.attempt_count > self._settings.auth_browser_challenge_max_attempts:
            record.consumed_at = self._now()
            raise BrowserAuthError(_GENERIC_CHALLENGE_ERROR)

    def _decrypt_user_secret(self, user: User) -> str:
        if user.mfa_secret_ciphertext is None or user.mfa_secret_key_version is None:
            raise BrowserAuthError(_GENERIC_CHALLENGE_ERROR)
        return mfa.decrypt_totp_secret(
            EncryptedTotpSecret(
                ciphertext=user.mfa_secret_ciphertext,
                key_version=user.mfa_secret_key_version,
            ),
            user_id=user.id,
        )

    async def _issue_recovery_codes(
        self, session: AsyncSession, user: User
    ) -> tuple[str, ...]:
        await session.execute(
            delete(MfaRecoveryCode).where(MfaRecoveryCode.user_id == user.id)
        )
        codes = mfa.generate_recovery_codes()
        for code in codes:
            session.add(
                MfaRecoveryCode(
                    user_id=user.id, code_digest=mfa.recovery_code_digest(code)
                )
            )
        await session.flush()
        return codes

    def _new_refresh_session(
        self,
        session: AsyncSession,
        user: User,
        *,
        family_id: str | None,
        user_agent: str | None,
        ip: str | None,
        auth_time: datetime | None,
        absolute_expires_at: datetime | None = None,
    ) -> tuple[str, str]:
        token = generate_opaque_token()
        now = self._now()
        # A new sign-in starts a full lifetime; a rotation inherits the family's expiry.
        expires_at = absolute_expires_at or now + timedelta(
            seconds=self._settings.auth_browser_refresh_absolute_ttl_seconds
        )
        idle_expires_at = min(
            now
            + timedelta(seconds=self._settings.auth_browser_refresh_idle_ttl_seconds),
            expires_at,
        )
        session_id = str(uuid7())
        session.add(
            BrowserRefreshSession(
                id=session_id,
                user_id=user.id,
                family_id=family_id or session_id,
                token_hash=token.digest,
                auth_time=auth_time,
                expires_at=expires_at,
                idle_expires_at=idle_expires_at,
                user_agent=user_agent,
                ip_address=ip,
            )
        )
        return token.raw, session_id

    async def _revoke_family(self, session: AsyncSession, family_id: str) -> None:
        await session.execute(
            update(BrowserRefreshSession)
            .where(
                BrowserRefreshSession.family_id == family_id,
                BrowserRefreshSession.revoked_at.is_(None),
            )
            .values(revoked_at=self._now())
        )

    def _mint_access(
        self, user: User, *, auth_time: datetime | None
    ) -> tuple[str, int]:
        ttl = self._settings.auth_browser_access_ttl_seconds
        now = self._now()
        token = encode_hs256_bearer_token(
            subject=user.oidc_subject,
            secret=self._settings.auth_bearer_hmac_secret,
            issuer=self._settings.auth_bearer_issuer,
            audience=self._settings.auth_bearer_audience,
            ttl_seconds=ttl,
            now=now,
            extra_claims={
                "client": "staff-web",
                # Omitted (not faked) when unknown, so the recent-sign-in guard
                # fails closed for the session.
                **(
                    {"auth_time": int(_aware(auth_time).timestamp())}
                    if auth_time is not None
                    else {}
                ),
                "hms_roles": [user.role],
                "cv": user.credential_version,
            },
        )
        return token, ttl

    async def _finalise(
        self,
        session: AsyncSession,
        user: User,
        *,
        user_agent: str | None,
        ip: str | None,
        recovery_codes: tuple[str, ...] | None = None,
    ) -> AuthenticatedSession:
        now = self._now()
        user.last_login_at = now
        user.failed_mfa_attempts = 0
        refresh_raw, _ = self._new_refresh_session(
            session, user, family_id=None, user_agent=user_agent, ip=ip, auth_time=now
        )
        await session.flush()
        access_token, expires_in = self._mint_access(user, auth_time=now)
        return AuthenticatedSession(
            access_token=access_token,
            expires_in=expires_in,
            refresh_token=refresh_raw,
            refresh_max_age=self._settings.auth_browser_refresh_absolute_ttl_seconds,
            recovery_codes=recovery_codes,
        )

    async def _audit(
        self,
        session: AsyncSession,
        user: User | None,
        *,
        email: str | None,
        action: str,
        detail: dict[str, object] | None = None,
    ) -> None:
        after: dict[str, object] = dict(detail or {})
        if email is not None:
            after["email_key"] = self._email_key(email)
        if user is not None:
            actor_id = user.id
            entity_id = user.id
        else:
            actor_id = "anonymous"
            entity_id = str(after.get("email_key", "unknown"))
        await append_audit_event(
            session,
            actor_id=actor_id,
            action=action,
            entity="user",
            entity_id=entity_id,
            before=None,
            after=after or None,
        )

    def _email_key(self, email: str) -> str:
        pepper = self._settings.auth_recovery_code_pepper or "hms-audit"
        return hmac.new(
            pepper.encode("utf-8"),
            email.strip().lower().encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()[:32]


def _aware(value: datetime) -> datetime:
    """SQLite round-trips timezone-aware datetimes as naive; re-attach UTC."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
