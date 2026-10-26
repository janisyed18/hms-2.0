"""Server-side user discovery: search, filters, sorting, counts and name rules."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.rbac import Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.identity.models import User, UserCustomerAccess

ADMIN = "sub-admin"
NOW = datetime(2026, 10, 26, 3, 0, tzinfo=UTC)


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@asynccontextmanager
async def client_for(
    session_factory: async_sessionmaker[AsyncSession], subject: str = ADMIN
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"X-HMS-User-Id": subject},
    ) as client:
        yield client


def person(
    key: str,
    first: str | None,
    last: str | None,
    role: Role = Role.INSPECTOR,
    **extra: Any,
) -> User:
    return User(
        oidc_subject=f"sub-{key}",
        email=f"{key}@example.com",
        first_name=first,
        last_name=last,
        role=role.value,
        **extra,
    )


@pytest_asyncio.fixture
async def directory(
    session_factory: async_sessionmaker[AsyncSession],
) -> dict[str, str]:
    async with session_factory() as session:
        customer = Customer(code="VOPA", name="Vopak")
        other = Customer(code="ORIC", name="Orica")
        session.add_all([customer, other])
        await session.flush()
        users = [
            person("admin", "Ada", "Admin", Role.HMS_ADMIN, mfa_enabled=True),
            person(
                "jani",
                "Jani",
                "Syed",
                Role.INSPECTOR,
                mfa_enabled=True,
                last_login_at=NOW,
            ),
            person(
                "sam",
                "Sam",
                "Syed",
                Role.REVIEWER,
                last_login_at=NOW - timedelta(days=3),
            ),
            person("locked", "Lena", "Locked", Role.INSPECTOR, account_status="LOCKED"),
            person(
                "off",
                "Omar",
                "Off",
                Role.INSPECTOR,
                account_status="DISABLED",
                mfa_enabled=True,
            ),
            person("legacy", None, None, Role.ASSEMBLY),
            person(
                "cust", "Cora", "Client", Role.CUSTOMER_USER, customer_id=customer.id
            ),
            person("gone", "Gina", "Gone", Role.INSPECTOR, deleted_at=NOW),
        ]
        session.add_all(users)
        await session.flush()
        session.add(UserCustomerAccess(user_id=users[2].id, customer_id=other.id))
        await session.commit()
        return {
            "vopak": customer.id,
            "orica": other.id,
            **{u.oidc_subject: u.id for u in users},
        }


async def emails(client: httpx.AsyncClient, **params: Any) -> list[str]:
    response = await client.get("/api/v1/admin/users", params={"limit": 50, **params})
    assert response.status_code == 200, response.text
    return [item["email"].split("@")[0] for item in response.json()["items"]]


@pytest.mark.asyncio
async def test_search_matches_names_email_and_id_one_word_at_a_time(
    session_factory: async_sessionmaker[AsyncSession], directory: dict[str, str]
) -> None:
    async with client_for(session_factory) as client:
        assert await emails(client, search="jani") == ["jani"]  # first name
        assert await emails(client, search="SYED", sort="email") == [
            "jani",
            "sam",
        ]  # last name
        assert await emails(client, search="sam@example") == ["sam"]  # email
        assert await emails(client, search=directory["sub-cust"][:18]) == ["cust"]  # id
        assert await emails(client, search="Jani Syed") == ["jani"]  # full name
        assert await emails(client, search="syed jani") == ["jani"]  # either order
        assert await emails(client, search="nobody-by-this-name") == []


@pytest.mark.asyncio
async def test_role_is_a_filter_not_a_search_word(
    session_factory: async_sessionmaker[AsyncSession], directory: dict[str, str]
) -> None:
    async with client_for(session_factory) as client:
        assert await emails(client, role="INSPECTOR", sort="email") == [
            "jani",
            "locked",
            "off",
        ]
        assert await emails(client, search="REVIEWER") == []  # not matched as free text
        refused = await client.get("/api/v1/admin/users", params={"role": "WIZARD"})
        assert refused.status_code == 400


@pytest.mark.asyncio
async def test_filters_compose_and_totals_describe_the_filtered_set(
    session_factory: async_sessionmaker[AsyncSession], directory: dict[str, str]
) -> None:
    async with client_for(session_factory) as client:
        assert await emails(client, role="INSPECTOR", account_status="ACTIVE") == [
            "jani"
        ]
        assert await emails(client, role="INSPECTOR", account_status="DISABLED") == [
            "off"
        ]
        assert await emails(client, role="INSPECTOR", mfa="setup_required") == [
            "locked"
        ]
        assert await emails(
            client, role="INSPECTOR", account_status="DISABLED", mfa="enabled"
        ) == ["off"]
        assert (
            await emails(
                client, role="INSPECTOR", account_status="LOCKED", mfa="enabled"
            )
            == []
        )
        assert await emails(client, account_status="LOCKED") == ["locked"]
        bad = await client.get(
            "/api/v1/admin/users", params={"account_status": "ASLEEP"}
        )
        assert bad.status_code == 422


@pytest.mark.asyncio
async def test_customer_filter_matches_primary_and_granted_scope_only(
    session_factory: async_sessionmaker[AsyncSession], directory: dict[str, str]
) -> None:
    async with client_for(session_factory) as client:
        assert await emails(client, customer_id=directory["vopak"]) == ["cust"]
        assert await emails(client, customer_id=directory["orica"]) == ["sam"]
        assert await emails(client, customer_id="no-such-customer") == []


@pytest.mark.asyncio
async def test_pagination_stays_truthful_under_filters(
    session_factory: async_sessionmaker[AsyncSession], directory: dict[str, str]
) -> None:
    async with client_for(session_factory) as client:
        params: dict[str, str | int] = {
            "role": "INSPECTOR",
            "sort": "email",
            "limit": 2,
        }
        first = (await client.get("/api/v1/admin/users", params=params)).json()
        second = (
            await client.get("/api/v1/admin/users", params={**params, "offset": 2})
        ).json()
        assert (
            first["total"] == second["total"] == 3
        )  # the deleted inspector never counts
        assert [i["email"] for i in first["items"] + second["items"]] == [
            "jani@example.com",
            "locked@example.com",
            "off@example.com",
        ]
        # Keyset walks honour the same filters.
        walk: list[str] = []
        cursor: str | None = None
        for _ in range(5):
            page = (
                await client.get(
                    "/api/v1/admin/users",
                    params={
                        "role": "INSPECTOR",
                        "sort": "id",
                        "limit": 2,
                        **({"after": cursor} if cursor else {}),
                    },
                )
            ).json()
            walk += [i["email"] for i in page["items"]]
            cursor = page["next_after"]
            if cursor is None:
                break
        assert sorted(walk) == [
            "jani@example.com",
            "locked@example.com",
            "off@example.com",
        ]


@pytest.mark.asyncio
async def test_summary_counts_are_global_and_ignore_deleted_users(
    session_factory: async_sessionmaker[AsyncSession], directory: dict[str, str]
) -> None:
    async with client_for(session_factory) as client:
        summary = (await client.get("/api/v1/admin/users/summary")).json()
        # A one-row page must not change what the directory-wide counts say.
        await client.get("/api/v1/admin/users", params={"limit": 1, "role": "REVIEWER"})
    assert summary["total"] == 7
    assert summary["by_role"] == {
        "HMS_ADMIN": 1,
        "INSPECTOR": 3,
        "REVIEWER": 1,
        "ASSEMBLY": 1,
        "CUSTOMER_USER": 1,
    }
    assert (summary["active"], summary["locked"], summary["disabled"]) == (5, 1, 1)
    assert (summary["mfa_enabled"], summary["mfa_setup_required"]) == (3, 4)


@pytest.mark.asyncio
async def test_discovery_never_widens_who_can_see_users(
    session_factory: async_sessionmaker[AsyncSession], directory: dict[str, str]
) -> None:
    async with client_for(
        session_factory, subject="sub-jani"
    ) as client:  # an inspector
        for path, params in [
            ("/api/v1/admin/users", {}),
            ("/api/v1/admin/users", {"search": "syed", "role": "INSPECTOR"}),
            ("/api/v1/admin/users/summary", {}),
        ]:
            response = await client.get(path, params=params)
            assert response.status_code == 403, path
    async with client_for(session_factory) as client:
        # Deleted users stay hidden whatever the filter or the search names them by.
        assert await emails(client, search="gone") == []
        assert await emails(client, search=directory["sub-gone"]) == []
        assert "gone" not in await emails(client, role="INSPECTOR")


@pytest.mark.asyncio
async def test_sorting_by_name_and_last_login(
    session_factory: async_sessionmaker[AsyncSession], directory: dict[str, str]
) -> None:
    async with client_for(session_factory) as client:
        by_name = await emails(client, sort="name", role="INSPECTOR")
        assert by_name == ["locked", "off", "jani"]  # Locked, Off, Syed
        assert (await emails(client, sort="name"))[
            0
        ] == "legacy"  # nameless sorts first
        newest = await emails(client, sort="-last_login_at")
        assert newest[:2] == ["jani", "sam"]
        oldest = await emails(client, sort="last_login_at")
        assert oldest[:2] == ["sam", "jani"]
        assert (
            oldest[2:] and "legacy" in oldest[2:]
        )  # never signed in sorts last both ways


@pytest.mark.asyncio
async def test_creating_a_user_requires_a_first_and_last_name(
    session_factory: async_sessionmaker[AsyncSession], directory: dict[str, str]
) -> None:
    body = {"email": "new.person@example.com", "role": "INSPECTOR"}
    async with client_for(session_factory) as client:
        for payload in (
            body,
            {**body, "first_name": "New"},
            {**body, "first_name": "  ", "last_name": "Person"},
            {**body, "first_name": "New", "last_name": ""},
        ):
            refused = await client.post("/api/v1/admin/users", json=payload)
            assert refused.status_code == 422, payload
        created = await client.post(
            "/api/v1/admin/users",
            json={**body, "first_name": " New ", "last_name": "Person"},
        )
        assert created.status_code == 201
        assert created.json()["user"]["first_name"] == "New"
        # A legacy user without a name can still be edited without inventing one.
        legacy = directory["sub-legacy"]
        updated = await client.patch(
            f"/api/v1/admin/users/{legacy}", json={"role": "ASSEMBLY"}
        )
        assert updated.status_code == 200
        assert updated.json()["first_name"] is None
