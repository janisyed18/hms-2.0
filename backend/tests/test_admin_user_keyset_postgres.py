"""Admin user-list keyset paging against the migrated PostgreSQL schema.

PostgreSQL orders text with the database collation, so this proves the `id > :after`
cursor agrees with `ORDER BY id`, and that deletes, email edits and new users made
between pages neither skip nor repeat a user.
"""

from __future__ import annotations

import asyncio
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

EMAIL_PARTS = ["a_b", "a.b", "a-c", "a+c", "b1", "b_1", "zed", "zed.x", "m", "m2"]


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
async def test_keyset_walk_survives_concurrent_changes_on_postgresql(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    tag = uuid4().hex[:10]
    admin_subject = f"keyset-admin-{tag}"
    async with session_factory() as session:
        session.add(
            User(
                oidc_subject=admin_subject,
                email=f"admin.{tag}@example.com",
                role=Role.HMS_ADMIN.value,
            )
        )
        for index, part in enumerate(EMAIL_PARTS):
            session.add(
                User(
                    oidc_subject=f"keyset-{index}-{tag}",
                    email=f"{part}.{tag}@example.com",
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
    base: dict[str, str | int] = {"search": tag, "sort": "id", "limit": 3}

    async def edit(current: str, **values: object) -> str:
        async with session_factory() as session:
            user = await session.scalar(select(User).where(User.email == current))
            assert user is not None
            for key, value in values.items():
                setattr(user, key, value)
            await session.commit()
            return user.id

    try:
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
            headers={"X-HMS-User-Id": admin_subject},
        ) as client:
            # Offset paging gives the database's own id order; the walk must match it.
            expected: list[dict[str, str]] = []
            for offset in range(0, len(EMAIL_PARTS) + 1, 3):
                body = (
                    await client.get(
                        "/api/v1/admin/users", params={**base, "offset": offset}
                    )
                ).json()
                expected += body["items"]
            expected_ids = [item["id"] for item in expected]
            assert len(expected_ids) == len(EMAIL_PARTS) + 1

            first = (await client.get("/api/v1/admin/users", params=base)).json()
            assert first["next_after"] == expected_ids[2]
            seen = [item["id"] for item in first["items"]]
            unread_email = expected[-1]["email"]
            read_email = expected[1]["email"]
            cursor_email = expected[2]["email"]

            # Between pages: delete a read user and the cursor user, move an unread
            # user's email before everything and a read user's after everything, and
            # create a new user.
            deleted = [
                await edit(read_email, deleted_at=datetime.now(UTC)),
                await edit(cursor_email, deleted_at=datetime.now(UTC)),
            ]
            await edit(unread_email, email=f"0-first.{tag}@example.com")
            await edit(expected[0]["email"], email=f"zzz-last.{tag}@example.com")
            await asyncio.sleep(0.01)
            async with session_factory() as session:
                late = User(
                    oidc_subject=f"keyset-late-{tag}",
                    email=f"0-late.{tag}@example.com",
                    role=Role.INSPECTOR.value,
                )
                session.add(late)
                await session.commit()
                late_id = late.id

            cursor: str | None = first["next_after"]
            for _ in range(10):
                if cursor is None:
                    break
                body = (
                    await client.get(
                        "/api/v1/admin/users", params={**base, "after": cursor}
                    )
                ).json()
                seen += [item["id"] for item in body["items"]]
                cursor = body["next_after"]

        assert len(set(seen)) == len(seen)
        # Every user present throughout is returned once; the new user appears once.
        surviving = [i for i in expected_ids if i not in deleted]
        assert [i for i in seen if i not in deleted and i != late_id] == surviving
        assert seen.count(late_id) == 1
    finally:
        async with session_factory() as session:
            await session.execute(
                delete(User).where(User.email.like(f"%{tag}@example.com"))
            )
            await session.commit()
