"""Staff browser authentication endpoints (Task 4).

A separate contract from the native ``/auth/login`` bearer flow. Intermediate
steps return only a short-lived opaque challenge; the access token is returned in
the body (held in memory by the SPA) and the rotating refresh token is set as a
strict ``HttpOnly`` cookie scoped to this router's path. Refresh and logout read
only the cookie and enforce an allowed-origin check.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import select

from hms_backend.app.api.dependencies import (
    PrincipalDep,
    SessionDep,
)
from hms_backend.app.core.config import settings
from hms_backend.app.core.rate_limit import LoginRateLimiter
from hms_backend.app.core.rbac import ROLE_PERMISSIONS
from hms_backend.app.modules.identity.browser_auth import (
    AuthenticatedSession,
    BrowserAuthError,
    BrowserAuthService,
    RateLimitedError,
)
from hms_backend.app.modules.identity.models import User

router = APIRouter(prefix="/auth/browser", tags=["auth-browser"])

_service = BrowserAuthService()
_login_limiter = LoginRateLimiter()


class BrowserAuthNextStep(StrEnum):
    PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED"
    MFA_ENROLLMENT_REQUIRED = "MFA_ENROLLMENT_REQUIRED"
    MFA_REQUIRED = "MFA_REQUIRED"
    RECOVERY_CODES = "RECOVERY_CODES"
    AUTHENTICATED = "AUTHENTICATED"


# --- request payloads -----------------------------------------------------------


class BrowserLoginRequest(BaseModel):
    email: str
    password: str


class BrowserPasswordChangeRequest(BaseModel):
    challenge: str
    new_password: str


class BrowserChallengeRequest(BaseModel):
    challenge: str


class BrowserCodeRequest(BaseModel):
    challenge: str
    code: str


# --- responses ------------------------------------------------------------------


class BrowserChallengeResponse(BaseModel):
    next_step: BrowserAuthNextStep
    challenge: str
    expires_in: int


class BrowserEnrollmentResponse(BaseModel):
    next_step: Literal[BrowserAuthNextStep.MFA_ENROLLMENT_REQUIRED] = (
        BrowserAuthNextStep.MFA_ENROLLMENT_REQUIRED
    )
    challenge: str
    otpauth_uri: str
    manual_key: str


class BrowserAuthenticatedResponse(BaseModel):
    next_step: Literal[BrowserAuthNextStep.AUTHENTICATED] = (
        BrowserAuthNextStep.AUTHENTICATED
    )
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int


class BrowserRecoveryCodesResponse(BaseModel):
    next_step: Literal[BrowserAuthNextStep.RECOVERY_CODES] = (
        BrowserAuthNextStep.RECOVERY_CODES
    )
    access_token: str
    expires_in: int
    recovery_codes: list[str]


class BrowserMeResponse(BaseModel):
    user_id: str
    email: str
    display_name: str
    account_status: str
    roles: list[str]
    permissions: list[str]
    customer_ids: list[str]


# --- helpers --------------------------------------------------------------------


def _client_meta(request: Request) -> tuple[str | None, str | None]:
    user_agent = request.headers.get("user-agent")
    ip = request.client.host if request.client else None
    return user_agent, ip


def _set_refresh_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=settings.auth_browser_cookie_name,
        value=token,
        max_age=settings.auth_browser_refresh_absolute_ttl_seconds,
        httponly=True,
        secure=settings.auth_browser_cookie_secure,
        samesite="strict",
        path=settings.auth_browser_cookie_path,
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        key=settings.auth_browser_cookie_name,
        path=settings.auth_browser_cookie_path,
    )


def _require_allowed_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    allowed = settings.auth_browser_allowed_origins
    if not allowed:
        # No explicit allow-list: permitted only in local/test (dev convenience).
        if settings.is_local_or_test:
            return
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Origin not allowed"
        )
    if origin not in allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Origin not allowed"
        )


def _authenticated_body(
    authed: AuthenticatedSession, response: Response
) -> BrowserAuthenticatedResponse | BrowserRecoveryCodesResponse:
    _set_refresh_cookie(response, authed.refresh_token)
    if authed.recovery_codes is not None:
        return BrowserRecoveryCodesResponse(
            access_token=authed.access_token,
            expires_in=authed.expires_in,
            recovery_codes=list(authed.recovery_codes),
        )
    return BrowserAuthenticatedResponse(
        access_token=authed.access_token, expires_in=authed.expires_in
    )


def _unauthorized(exc: BrowserAuthError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc))


# --- endpoints ------------------------------------------------------------------


@router.post("/login", response_model=BrowserChallengeResponse)
async def browser_login(
    payload: BrowserLoginRequest,
    request: Request,
    session: SessionDep,
) -> BrowserChallengeResponse:
    _, ip = _client_meta(request)
    account_key = f"account:{payload.email.strip().lower()}"
    for key in (account_key, f"ip:{ip or 'unknown'}"):
        decision = await _login_limiter.hit(key)
        if not decision.allowed:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many attempts; please wait and try again.",
                headers={"Retry-After": str(decision.retry_after_seconds)},
            )
    try:
        challenge = await _service.login(
            session,
            email=payload.email,
            password=payload.password,
            user_agent=request.headers.get("user-agent"),
            ip=ip,
        )
    except RateLimitedError as exc:
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
            headers={"Retry-After": str(exc.retry_after_seconds)},
        ) from exc
    except BrowserAuthError as exc:
        # Persist the redacted failure audit + attempt counter, then fail generic.
        await session.commit()
        raise _unauthorized(exc) from exc
    await _login_limiter.reset(account_key)
    await session.commit()
    return BrowserChallengeResponse(
        next_step=BrowserAuthNextStep(challenge.stage),
        challenge=challenge.raw,
        expires_in=challenge.expires_in,
    )


@router.post("/password", response_model=BrowserChallengeResponse)
async def browser_change_password(
    payload: BrowserPasswordChangeRequest,
    request: Request,
    session: SessionDep,
) -> BrowserChallengeResponse:
    user_agent, ip = _client_meta(request)
    try:
        challenge = await _service.change_password(
            session,
            challenge=payload.challenge,
            new_password=payload.new_password,
            user_agent=user_agent,
            ip=ip,
        )
    except BrowserAuthError as exc:
        await session.commit()
        # Password-policy errors are a 400 (safe to surface); everything else is
        # a generic 401 from an invalid/expired challenge.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    await session.commit()
    return BrowserChallengeResponse(
        next_step=BrowserAuthNextStep(challenge.stage),
        challenge=challenge.raw,
        expires_in=challenge.expires_in,
    )


@router.post("/mfa/enrollment", response_model=BrowserEnrollmentResponse)
async def browser_start_enrollment(
    payload: BrowserChallengeRequest,
    session: SessionDep,
) -> BrowserEnrollmentResponse:
    try:
        enrollment = await _service.start_mfa_enrollment(
            session, challenge=payload.challenge
        )
    except BrowserAuthError as exc:
        raise _unauthorized(exc) from exc
    await session.commit()
    return BrowserEnrollmentResponse(
        challenge=payload.challenge,
        otpauth_uri=enrollment.otpauth_uri,
        manual_key=enrollment.manual_key,
    )


@router.post("/mfa/confirm", response_model=BrowserRecoveryCodesResponse)
async def browser_confirm_enrollment(
    payload: BrowserCodeRequest,
    request: Request,
    session: SessionDep,
    response: Response,
) -> BrowserRecoveryCodesResponse | BrowserAuthenticatedResponse:
    user_agent, ip = _client_meta(request)
    try:
        authed = await _service.confirm_mfa_enrollment(
            session,
            challenge=payload.challenge,
            code=payload.code,
            user_agent=user_agent,
            ip=ip,
        )
    except BrowserAuthError as exc:
        await session.commit()
        raise _unauthorized(exc) from exc
    await session.commit()
    return _authenticated_body(authed, response)


@router.post("/mfa/verify", response_model=BrowserAuthenticatedResponse)
async def browser_verify_mfa(
    payload: BrowserCodeRequest,
    request: Request,
    session: SessionDep,
    response: Response,
) -> BrowserAuthenticatedResponse | BrowserRecoveryCodesResponse:
    user_agent, ip = _client_meta(request)
    try:
        authed = await _service.verify_mfa(
            session,
            challenge=payload.challenge,
            code=payload.code,
            user_agent=user_agent,
            ip=ip,
        )
    except BrowserAuthError as exc:
        await session.commit()
        raise _unauthorized(exc) from exc
    await session.commit()
    return _authenticated_body(authed, response)


@router.post("/recovery/verify", response_model=BrowserAuthenticatedResponse)
async def browser_verify_recovery(
    payload: BrowserCodeRequest,
    request: Request,
    session: SessionDep,
    response: Response,
) -> BrowserAuthenticatedResponse | BrowserRecoveryCodesResponse:
    user_agent, ip = _client_meta(request)
    try:
        authed = await _service.verify_recovery_code(
            session,
            challenge=payload.challenge,
            code=payload.code,
            user_agent=user_agent,
            ip=ip,
        )
    except BrowserAuthError as exc:
        await session.commit()
        raise _unauthorized(exc) from exc
    await session.commit()
    return _authenticated_body(authed, response)


@router.post("/refresh", response_model=BrowserAuthenticatedResponse)
async def browser_refresh(
    request: Request,
    session: SessionDep,
    response: Response,
) -> BrowserAuthenticatedResponse | BrowserRecoveryCodesResponse:
    _require_allowed_origin(request)
    token = request.cookies.get(settings.auth_browser_cookie_name)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="No session"
        )
    user_agent, ip = _client_meta(request)
    try:
        authed = await _service.refresh(
            session, refresh_token=token, user_agent=user_agent, ip=ip
        )
    except BrowserAuthError as exc:
        await session.commit()  # persist family revocation on reuse detection
        _clear_refresh_cookie(response)
        raise _unauthorized(exc) from exc
    await session.commit()
    return _authenticated_body(authed, response)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def browser_logout(
    request: Request,
    session: SessionDep,
    response: Response,
) -> Response:
    _require_allowed_origin(request)
    token = request.cookies.get(settings.auth_browser_cookie_name)
    if token:
        await _service.logout(session, refresh_token=token)
        await session.commit()
    _clear_refresh_cookie(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me", response_model=BrowserMeResponse)
async def browser_me(
    principal: PrincipalDep,
    session: SessionDep,
) -> BrowserMeResponse:
    user = await session.scalar(
        select(User).where(
            User.oidc_subject == principal.user_id, User.deleted_at.is_(None)
        )
    )
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown HMS user"
        )
    permissions = sorted(
        {
            permission.value
            for role in principal.roles
            for permission in ROLE_PERMISSIONS.get(role, frozenset())
        }
    )
    display_name = " ".join(
        part for part in (user.first_name, user.last_name) if part
    ) or user.email
    return BrowserMeResponse(
        user_id=user.oidc_subject,
        email=user.email,
        display_name=display_name,
        account_status=user.account_status,
        roles=sorted(role.value for role in principal.roles),
        permissions=permissions,
        customer_ids=sorted(principal.customer_ids),
    )
