"""Self-service password reset transitions for staff browser authentication."""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.core.audit import append_audit_event
from hms_backend.app.core.config import Settings, settings
from hms_backend.app.core.password_reset_tokens import (
    encrypt_password_reset_delivery,
    generate_password_reset_secret,
)
from hms_backend.app.core.passwords import hash_password, validate_password_policy
from hms_backend.app.core.rate_limit import LoginRateLimiter
from hms_backend.app.models.foundation import SyncChange
from hms_backend.app.modules.identity.models import (
    AccountStatus,
    BrowserRefreshSession,
    PasswordResetDelivery,
    PasswordResetToken,
    User,
)

GENERIC_RESET_MESSAGE = "If that email exists, a password reset link has been sent."
INVALID_RESET_ERROR = "Invalid or expired reset link."


class PasswordResetError(ValueError):
    """Safe error for malformed, expired, used, or superseded reset links."""


class PasswordResetService:
    def __init__(
        self,
        *,
        config: Settings = settings,
        now: Callable[[], datetime] | None = None,
        rate_limiter: LoginRateLimiter | None = None,
    ) -> None:
        self._settings = config
        self._now = now or (lambda: datetime.now(UTC))
        self._rate_limiter = rate_limiter or LoginRateLimiter(
            max_attempts=config.auth_password_reset_rate_limit_max_attempts,
            window_seconds=config.auth_password_reset_rate_limit_window_seconds,
            lockout_seconds=config.auth_password_reset_rate_limit_window_seconds,
        )

    async def request(
        self,
        session: AsyncSession,
        *,
        email: str,
        ip: str | None,
        user_agent: str | None,
    ) -> str:
        normalized = email.strip().lower()
        account_key = "account:" + hashlib.sha256(normalized.encode()).hexdigest()
        ip_key = "ip:" + (ip or "unknown")
        decisions = await self._rate_limiter.hit(account_key)
        ip_decision = await self._rate_limiter.hit(ip_key)
        if not decisions.allowed or not ip_decision.allowed:
            return GENERIC_RESET_MESSAGE

        user = await session.scalar(
            select(User).where(
                User.email == normalized,
                User.deleted_at.is_(None),
            )
        )
        if user is None or user.account_status == AccountStatus.DISABLED.value:
            # Keep a small amount of deterministic work on the unknown path so
            # the response does not become an account-existence oracle.
            dummy = generate_password_reset_secret()
            hashlib.sha256(dummy.raw.encode()).digest()
            return GENERIC_RESET_MESSAGE

        now = self._now()
        await session.execute(
            update(PasswordResetToken)
            .where(
                PasswordResetToken.user_id == user.id,
                PasswordResetToken.consumed_at.is_(None),
                PasswordResetToken.superseded_at.is_(None),
            )
            .values(superseded_at=now)
        )

        secret = generate_password_reset_secret()
        reset = PasswordResetToken(
            token_hash=secret.digest,
            user_id=user.id,
            expires_at=now
            + timedelta(seconds=self._settings.auth_password_reset_ttl_seconds),
            requested_ip=ip,
            requested_user_agent=user_agent,
        )
        session.add(reset)
        await session.flush()
        envelope = encrypt_password_reset_delivery(
            secret.raw,
            reset_id=reset.id,
            user_id=user.id,
            config=self._settings,
        )
        session.add(
            PasswordResetDelivery(
                reset_id=reset.id,
                recipient_email=user.email,
                ciphertext=envelope.ciphertext,
                key_version=envelope.key_version,
                scheduled_for=now,
            )
        )
        await append_audit_event(
            session,
            actor_id="anonymous",
            action="auth.password.reset.requested",
            entity="User",
            entity_id=user.id,
            before=None,
            after={"delivery": "queued"},
        )
        await session.flush()
        return GENERIC_RESET_MESSAGE

    async def confirm(
        self,
        session: AsyncSession,
        *,
        token: str,
        new_password: str,
    ) -> None:
        if not token or len(token) > 512:
            raise PasswordResetError(INVALID_RESET_ERROR)
        digest = hashlib.sha256(token.encode()).hexdigest()
        record = await session.scalar(
            select(PasswordResetToken)
            .where(PasswordResetToken.token_hash == digest)
            .with_for_update()
        )
        now = self._now()
        if (
            record is None
            or record.consumed_at is not None
            or record.superseded_at is not None
            or _aware(record.expires_at) <= now
        ):
            raise PasswordResetError(INVALID_RESET_ERROR)

        user = await session.get(User, record.user_id)
        if user is None or user.deleted_at is not None:
            raise PasswordResetError(INVALID_RESET_ERROR)
        policy = validate_password_policy(new_password)
        if not policy.valid:
            raise PasswordResetError(" ".join(policy.errors))

        before = _credential_safe_snapshot(user)
        user.password_hash = hash_password(new_password)
        user.password_changed_at = now
        user.must_change_password = False
        user.failed_password_attempts = 0
        user.locked_until = None
        if user.account_status == AccountStatus.LOCKED.value:
            user.account_status = AccountStatus.ACTIVE.value
        user.version += 1
        record.consumed_at = now
        await session.execute(
            update(PasswordResetToken)
            .where(
                PasswordResetToken.user_id == user.id,
                PasswordResetToken.id != record.id,
                PasswordResetToken.consumed_at.is_(None),
            )
            .values(superseded_at=now)
        )
        delivery = await session.scalar(
            select(PasswordResetDelivery).where(
                PasswordResetDelivery.reset_id == record.id
            )
        )
        if delivery is not None:
            delivery.ciphertext = None
        await session.execute(
            update(BrowserRefreshSession)
            .where(
                BrowserRefreshSession.user_id == user.id,
                BrowserRefreshSession.revoked_at.is_(None),
            )
            .values(revoked_at=now)
        )
        session.add(
            SyncChange(
                entity="User",
                entity_id=user.id,
                op="update",
                version=user.version,
            )
        )
        await append_audit_event(
            session,
            actor_id=user.id,
            action="auth.password.reset",
            entity="User",
            entity_id=user.id,
            before=before,
            after=_credential_safe_snapshot(user),
        )
        await session.flush()


def _credential_safe_snapshot(user: User) -> dict[str, object | None]:
    """Create audit data without password, MFA, token, or contact secrets."""
    return {
        "id": user.id,
        "email": user.email,
        "role": user.role,
        "customer_id": user.customer_id,
        "account_status": user.account_status,
        "must_change_password": user.must_change_password,
        "password_changed_at": user.password_changed_at,
        "mfa_enabled": user.mfa_enabled,
        "failed_password_attempts": user.failed_password_attempts,
        "locked_until": user.locked_until,
        "version": user.version,
    }


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value
