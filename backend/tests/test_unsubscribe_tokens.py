from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.config import Settings, settings
from hms_backend.app.core.unsubscribe_tokens import (
    UnsubscribeClaim,
    create_unsubscribe_token,
    read_unsubscribe_token,
)
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.modules.notifications.enums import (
    NotificationCategory,
    NotificationChannel,
    RecipientType,
)
from hms_backend.app.modules.notifications.models import NotificationPreference

CLAIM = UnsubscribeClaim(
    party_type=RecipientType.CUSTOMER_CONTACT.value,
    party_id="contact-1",
    category=NotificationCategory.CERTIFICATE_ISSUED.value,
)
URL = "/api/v1/notifications/unsubscribe"


def deployed(secret: str) -> Settings:
    return Settings(environment="production", auth_bearer_hmac_secret=secret)


def test_a_token_round_trips_to_the_same_claim() -> None:
    token = create_unsubscribe_token(CLAIM, deployed("a" * 40))
    assert token is not None
    assert read_unsubscribe_token(token, deployed("a" * 40)) == CLAIM


def test_a_token_signed_with_another_key_is_refused() -> None:
    token = create_unsubscribe_token(CLAIM, deployed("a" * 40))
    assert token is not None
    assert read_unsubscribe_token(token, deployed("b" * 40)) is None


def test_editing_the_party_invalidates_the_signature() -> None:
    config = deployed("a" * 40)
    token = create_unsubscribe_token(CLAIM, config)
    other = create_unsubscribe_token(
        UnsubscribeClaim(CLAIM.party_type, "contact-2", CLAIM.category), config
    )
    assert token is not None and other is not None
    forged = other.split(".")[0] + "." + token.split(".")[1]
    assert read_unsubscribe_token(forged, config) is None


@pytest.mark.parametrize("junk", ["", ".", "abc", "a.b.c", "!!!.???", "YQ.YQ"])
def test_malformed_tokens_are_refused(junk: str) -> None:
    assert read_unsubscribe_token(junk, deployed("a" * 40)) is None


def test_a_deployed_environment_without_a_key_issues_no_link() -> None:
    assert create_unsubscribe_token(CLAIM, deployed("")) is None


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@asynccontextmanager
async def public_client(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        yield client


async def preferences(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[NotificationPreference]:
    async with session_factory() as session:
        return list(await session.scalars(select(NotificationPreference)))


@pytest.mark.asyncio
async def test_opening_the_link_asks_first_and_changes_nothing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    token = create_unsubscribe_token(CLAIM, settings)
    async with public_client(session_factory) as client:
        response = await client.get(URL, params={"token": token})
    assert response.status_code == 200
    assert "<form" in response.text and "Unsubscribe" in response.text
    assert await preferences(session_factory) == []


@pytest.mark.asyncio
async def test_posting_a_valid_token_opts_that_party_out_of_email(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    token = create_unsubscribe_token(CLAIM, settings)
    async with public_client(session_factory) as client:
        via_query = await client.post(URL, params={"token": token})
        via_form = await client.post(URL, data={"token": token})
    assert via_query.status_code == 200 and via_form.status_code == 200
    (pref,) = await preferences(session_factory)
    assert (pref.party_type, pref.party_id, pref.category) == (
        CLAIM.party_type,
        CLAIM.party_id,
        CLAIM.category,
    )
    assert pref.channel == NotificationChannel.EMAIL.value
    assert pref.opted_in is False


@pytest.mark.asyncio
async def test_unsigned_party_links_no_longer_change_anything(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    legacy = {
        "party_type": CLAIM.party_type,
        "party_id": CLAIM.party_id,
        "category": CLAIM.category,
    }
    async with public_client(session_factory) as client:
        assert (await client.get(URL, params=legacy)).status_code == 422
        assert (await client.post(URL, params=legacy)).status_code == 400
        assert (await client.post(URL, params={"token": "nope"})).status_code == 400
    assert await preferences(session_factory) == []
