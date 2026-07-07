from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from starlette.concurrency import run_in_threadpool

from hms_backend.app.core.auth import TokenValidationError, decode_hs256_bearer_token
from hms_backend.app.core.config import settings
from hms_backend.app.core.oidc import (
    OidcConfigurationError,
    OidcValidationError,
    get_oidc_validator,
)
from hms_backend.app.core.rbac import Principal, Role
from hms_backend.app.modules.identity.models import User

engine = create_async_engine(settings.database_url)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_session() -> AsyncGenerator[AsyncSession]:
    async with SessionLocal() as session:
        yield session


SessionDep = Annotated[AsyncSession, Depends(get_session)]


async def get_current_principal(
    session: SessionDep,
    authorization: str | None = Header(default=None),
    x_hms_user_id: str | None = Header(default=None),
    x_hms_roles: str | None = Header(default=None),
    x_hms_customer_ids: str | None = Header(default=None),
) -> Principal:
    if settings.auth_mode == "oidc":
        return await _oidc_principal(session, authorization)

    if settings.auth_mode == "bearer":
        return await _bearer_principal(session, authorization)

    if not settings.auth_dev_headers_enabled:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Dev header auth is disabled",
        )

    if not x_hms_user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing HMS user identity",
        )

    user_principal = await _persisted_user_principal(session, x_hms_user_id)
    if user_principal is not None:
        return user_principal

    if not settings.auth_dev_allow_role_fallback:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unknown HMS user identity",
        )

    return _dev_header_principal(x_hms_user_id, x_hms_roles, x_hms_customer_ids)


async def _bearer_principal(
    session: AsyncSession,
    authorization: str | None,
) -> Principal:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token",
        )

    try:
        claims = decode_hs256_bearer_token(
            authorization.removeprefix("Bearer ").strip(),
            secret=settings.auth_bearer_hmac_secret,
            issuer=settings.auth_bearer_issuer,
            audience=settings.auth_bearer_audience,
            leeway_seconds=settings.auth_token_leeway_seconds,
        )
    except TokenValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
        ) from exc

    principal = await _persisted_user_principal(session, claims.subject)
    if principal is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unknown HMS user identity",
        )
    return principal


async def _oidc_principal(
    session: AsyncSession,
    authorization: str | None,
) -> Principal:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token",
        )
    token = authorization.removeprefix("Bearer ").strip()
    try:
        # JWKS/signature verification is blocking IO; keep the loop responsive.
        claims = await run_in_threadpool(get_oidc_validator().validate, token)
    except OidcValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)
        ) from exc
    except OidcConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc

    principal = await _persisted_user_principal(session, claims.subject)
    if principal is not None:
        return principal
    if settings.auth_oidc_jit_provisioning and claims.email:
        return await _provision_oidc_user(session, claims.subject, claims.email)
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Unknown HMS user identity",
    )


async def _provision_oidc_user(
    session: AsyncSession,
    subject: str,
    email: str,
) -> Principal:
    # JIT provisioning creates a least-privilege user; an admin elevates roles.
    user = User(
        oidc_subject=subject,
        email=email.strip().lower(),
        role=Role.CUSTOMER_USER.value,
        email_verified=True,
    )
    session.add(user)
    await session.commit()
    return Principal(
        user_id=user.oidc_subject,
        roles=frozenset({Role.CUSTOMER_USER}),
        customer_ids=frozenset(),
    )


async def _persisted_user_principal(
    session: AsyncSession,
    user_id: str,
) -> Principal | None:
    user = await session.scalar(
        select(User).where(
            User.oidc_subject == user_id,
            User.deleted_at.is_(None),
        )
    )
    if user is None:
        return None

    try:
        role = Role(user.role)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid persisted HMS role",
        ) from exc
    return Principal(
        user_id=user.oidc_subject,
        roles=frozenset({role}),
        customer_ids=frozenset({user.customer_id} if user.customer_id else ()),
    )


def _dev_header_principal(
    user_id: str,
    x_hms_roles: str | None,
    x_hms_customer_ids: str | None,
) -> Principal:
    if not x_hms_roles:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unknown HMS user identity",
        )

    try:
        roles = frozenset(Role(role.strip()) for role in x_hms_roles.split(","))
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid HMS role",
        ) from exc

    customer_ids = frozenset(
        customer_id.strip()
        for customer_id in (x_hms_customer_ids or "").split(",")
        if customer_id.strip()
    )
    return Principal(
        user_id=user_id,
        roles=roles,
        customer_ids=customer_ids,
    )
