from __future__ import annotations

from collections.abc import AsyncGenerator

from fastapi import Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.core.config import settings
from hms_backend.app.core.rbac import Principal, Role

engine = create_async_engine(settings.database_url)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_session() -> AsyncGenerator[AsyncSession]:
    async with SessionLocal() as session:
        yield session


async def get_current_principal(
    x_hms_user_id: str | None = Header(default=None),
    x_hms_roles: str | None = Header(default=None),
    x_hms_customer_ids: str | None = Header(default=None),
) -> Principal:
    if not x_hms_user_id or not x_hms_roles:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing HMS identity headers",
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
