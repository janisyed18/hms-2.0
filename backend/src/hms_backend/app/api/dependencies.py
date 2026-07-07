from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.core.config import settings
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
    x_hms_user_id: str | None = Header(default=None),
    x_hms_roles: str | None = Header(default=None),
    x_hms_customer_ids: str | None = Header(default=None),
) -> Principal:
    if not x_hms_user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing HMS user identity",
        )

    user = await session.scalar(
        select(User).where(
            User.oidc_subject == x_hms_user_id,
            User.deleted_at.is_(None),
        )
    )
    if user is not None:
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
        user_id=x_hms_user_id,
        roles=roles,
        customer_ids=customer_ids,
    )
