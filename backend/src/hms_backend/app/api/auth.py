"""Authentication endpoints.

* ``/auth/me`` — the resolved principal (roles + permissions) for any auth mode.
* ``/auth/login`` — Argon2 password login, returns a locally-issued HS256 access
  token used as a bearer credential.
* ``/auth/password`` — change your own password (verifying the current one).
* ``/auth/users/{user_id}/password`` — admin reset of another user's password.

Passwords are Argon2-hashed and never returned in any response.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.api.dependencies import get_current_principal, get_session
from hms_backend.app.core.auth import TokenValidationError, encode_hs256_bearer_token
from hms_backend.app.core.config import settings
from hms_backend.app.core.passwords import (
    hash_password,
    needs_rehash,
    verify_password,
)
from hms_backend.app.core.rbac import (
    ROLE_PERMISSIONS,
    Permission,
    Principal,
    require_permission,
)
from hms_backend.app.modules.identity.models import User
from hms_backend.app.modules.identity.password_reset import (
    GENERIC_RESET_MESSAGE,
    INVALID_RESET_ERROR,
    PasswordResetError,
    PasswordResetService,
)

router = APIRouter(prefix="/auth")

PrincipalDep = Annotated[Principal, Depends(get_current_principal)]
SessionDep = Annotated[AsyncSession, Depends(get_session)]

_MIN_PASSWORD_LEN = 10
_DUMMY_PASSWORD_HASH = hash_password("hms-dummy-password")


class AuthMeResponse(BaseModel):
    user_id: str
    roles: list[str]
    permissions: list[str]
    customer_ids: list[str]
    auth_mode: str


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=_MIN_PASSWORD_LEN)


class SetPasswordRequest(BaseModel):
    new_password: str = Field(min_length=_MIN_PASSWORD_LEN)


class MessageResponse(BaseModel):
    message: str


class ResetRequest(BaseModel):
    email: str


class ResetConfirm(BaseModel):
    token: str
    new_password: str = Field(min_length=_MIN_PASSWORD_LEN)


@router.get("/me", response_model=AuthMeResponse)
async def read_current_auth_session(principal: PrincipalDep) -> AuthMeResponse:
    return AuthMeResponse(
        user_id=principal.user_id,
        roles=sorted(role.value for role in principal.roles),
        permissions=sorted(
            permission.value
            for role in principal.roles
            for permission in ROLE_PERMISSIONS[role]
        ),
        customer_ids=sorted(principal.customer_ids),
        auth_mode=settings.auth_mode,
    )


@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest, session: SessionDep) -> TokenResponse:
    if not settings.auth_password_login_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Password login is disabled",
        )
    # Uniform failure to avoid leaking whether an email exists.
    invalid = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid email or password",
    )
    user = await session.scalar(
        select(User).where(
            func.lower(User.email) == payload.email.strip().lower(),
            User.deleted_at.is_(None),
        )
    )
    if user is None or not user.password_hash:
        # Still run a verify to keep timing roughly constant.
        verify_password(_DUMMY_PASSWORD_HASH, payload.password)
        raise invalid
    if not verify_password(user.password_hash, payload.password):
        raise invalid

    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(payload.password)
        await session.commit()

    return _issue_token(user)


@router.post("/password", response_model=MessageResponse)
async def change_password(
    payload: ChangePasswordRequest,
    session: SessionDep,
    principal: PrincipalDep,
) -> MessageResponse:
    user = await _current_user(session, principal)
    if not user.password_hash or not verify_password(
        user.password_hash, payload.current_password
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )
    user.password_hash = hash_password(payload.new_password)
    await session.commit()
    return MessageResponse(message="Password updated")


@router.post("/users/{user_id}/password", response_model=MessageResponse)
async def admin_set_password(
    user_id: str,
    payload: SetPasswordRequest,
    session: SessionDep,
    principal: PrincipalDep,
) -> MessageResponse:
    try:
        require_permission(principal, Permission.USER_ADMIN)
    except PermissionError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)
        ) from exc
    user = await session.get(User, user_id)
    if user is None or user.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )
    user.password_hash = hash_password(payload.new_password)
    await session.commit()
    return MessageResponse(message=f"Password set for {user.email}")


@router.post("/password/reset-request", response_model=MessageResponse)
async def request_password_reset(
    payload: ResetRequest, request: Request, session: SessionDep
) -> MessageResponse:
    """Compatibility alias for the hardened browser reset request flow."""
    await PasswordResetService().request(
        session,
        email=payload.email,
        ip=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    await session.commit()
    return MessageResponse(message=GENERIC_RESET_MESSAGE)


@router.post("/password/reset-confirm", response_model=MessageResponse)
async def confirm_password_reset(
    payload: ResetConfirm, session: SessionDep
) -> MessageResponse:
    try:
        await PasswordResetService().confirm(
            session,
            token=payload.token,
            new_password=payload.new_password,
        )
    except PasswordResetError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=INVALID_RESET_ERROR if str(exc) == INVALID_RESET_ERROR else str(exc),
        ) from exc
    await session.commit()
    return MessageResponse(message="Password reset. You can now log in.")


def _issue_token(user: User) -> TokenResponse:
    try:
        token = encode_hs256_bearer_token(
            subject=user.oidc_subject,
            secret=settings.auth_bearer_hmac_secret,
            issuer=settings.auth_bearer_issuer,
            audience=settings.auth_bearer_audience,
            ttl_seconds=settings.auth_access_token_ttl_seconds,
        )
    except TokenValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Token signing is not configured",
        ) from exc
    return TokenResponse(
        access_token=token, expires_in=settings.auth_access_token_ttl_seconds
    )


async def _current_user(session: AsyncSession, principal: Principal) -> User:
    user = await session.scalar(
        select(User).where(
            or_(User.oidc_subject == principal.user_id, User.id == principal.user_id),
            User.deleted_at.is_(None),
        )
    )
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unknown HMS user identity",
        )
    return user
