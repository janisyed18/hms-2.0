"""Admin user-list keyset paging against the migrated PostgreSQL schema.

PostgreSQL orders text with the database collation, so this proves the
`email > :after` cursor agrees with `ORDER BY email` for punctuated addresses (emails
are stored lowercased).
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import delete, select
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.rbac import Role
from hms_backend.app.main import create_app
from hms_backend.app.modules.identity.models import User

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)

LOCAL_PARTS = ["a_b", "a.b", "a-c", "a+c", "b1", "b_1", "zed", "zed.x", "m", "m2"]


@pytest_asyncio.fixture
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert POSTGRES_URL is not None
    database_name = make_url(POSTGRES_URL).database
    if database_name is None or not database_name.endswith("_test"):
        raise ValueError("These tests require a database name ending in _test")
    engine = create_async_engine(POSTGRES_URL)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_keyset_walk_matches_database_order_and_survives_removal_on_postgresql(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    tag = uuid4().hex[:10]
    admin_subject = f"keyset-admin-{tag}"
    emails = [f"{part}.{tag}@example.com" for part in LOCAL_PARTS]
    async with session_factory() as session:
        session.add(
            User(
                oidc_subject=admin_subject,
                email=f"admin.{tag}@example.com",
                role=Role.HMS_ADMIN.value,
            )
        )
        for index, email in enumerate(emails):
            session.add(
                User(
                    oidc_subject=f"keyset-{index}-{tag}",
                    email=email,
                    role=Role.INSPECTOR.value,
                )
            )
        await session.commit()

    app = create_app()

    async def override_session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    transport = httpx.ASGITransport(app=app)
    base: dict[str, str | int] = {"search": tag, "sort": "email", "limit": 3}
    try:
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
            headers={"X-HMS-User-Id": admin_subject},
        ) as client:
            # Offset paging gives the database's own order; the cursor walk must match.
            expected: list[str] = []
            for offset in range(0, len(emails) + 1, 3):
                page = (
                    await client.get(
                        "/api/v1/admin/users", params={**base, "offset": offset}
                    )
                ).json()
                expected += [item["email"] for item in page["items"]]

            seen: list[str] = []
            params: dict[str, str | int] = dict(base)
            first_cursor: str | None = None
            for _ in range(10):
                body = (await client.get("/api/v1/admin/users", params=params)).json()
                seen += [item["email"] for item in body["items"]]
                if first_cursor is None:
                    first_cursor = body["next_after"]
                    # Remove an already-read user and the cursor user between pages.
                    async with session_factory() as session:
                        for email in (seen[0], first_cursor):
                            user = await session.scalar(
                                select(User).where(User.email == email)
                            )
                            assert user is not None
                            user.deleted_at = datetime.now(UTC)
                        await session.commit()
                if body["next_after"] is None:
                    break
                params["after"] = body["next_after"]

        assert len(expected) == len(emails) + 1
        surviving = [e for e in expected if e not in (seen[0], first_cursor)]
        # No still-active user is skipped or repeated; removed ones are simply absent.
        assert [e for e in seen if e not in (seen[0], first_cursor)] == surviving
        assert len(set(seen)) == len(seen)
    finally:
        async with session_factory() as session:
            await session.execute(
                delete(User).where(User.email.like(f"%{tag}@example.com"))
            )
            await session.commit()
