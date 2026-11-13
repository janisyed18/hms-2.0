"""A credential change ends unfinished sign-ins as well as sessions.

A login challenge issued before the user's password changed (self-service, admin
reset or reset by link) must not be completable afterwards, by MFA code or by
recovery code. The forced-change flow, which deliberately issues a new challenge
after the change, must keep working.
"""

from __future__ import annotations

import base64
from collections.abc import AsyncGenerator, Generator

import fakeredis.aioredis
import httpx
import pyotp
import pytest
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.auth import encode_hs256_bearer_token
from hms_backend.app.core.config import settings
from hms_backend.app.core.password_reset_tokens import (
    EncryptedPasswordResetDelivery,
    decrypt_password_reset_delivery,
)
from hms_backend.app.core.passwords import hash_password
from hms_backend.app.core.redis import set_redis_client
from hms_backend.app.main import create_app
from hms_backend.app.models import foundation  # noqa: F401
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets import models as _assets  # noqa: F401
from hms_backend.app.modules.certificates import models as _certs  # noqa: F401
from hms_backend.app.modules.customers import models as _customers  # noqa: F401
from hms_backend.app.modules.identity.models import (
    BrowserAuthChallenge,
    PasswordResetDelivery,
    User,
)
from hms_backend.app.modules.inspections import models as _inspections  # noqa: F401
from hms_backend.app.modules.notifications import models as _notifications  # noqa: F401
from hms_backend.app.modules.products import models as _products  # noqa: F401
from hms_backend.app.modules.reference import models as _reference  # noqa: F401
from hms_backend.app.modules.scheduling import models as _scheduling  # noqa: F401

SessionFactory = async_sessionmaker[AsyncSession]
EMAIL = "rotation@example.com"
FIRST_PASSWORD = "Sup3r-Secret-Passphrase!"
PASSWORD = "A-New-Str0ng-Passphrase"
SECRET = "unit-test-secret"


@pytest.fixture(autouse=True)
def _config(monkeypatch: pytest.MonkeyPatch) -> Generator[None, None, None]:
    monkeypatch.setattr(settings, "environment", "test")
    monkeypatch.setattr(settings, "auth_mode", "bearer")
    monkeypatch.setattr(settings, "auth_bearer_hmac_secret", SECRET)
    monkeypatch.setattr(settings, "auth_browser_login_enabled", True)
    monkeypatch.setattr(settings, "auth_mfa_required", True, raising=False)
    monkeypatch.setattr(settings, "auth_browser_cookie_secure", False)
    monkeypatch.setattr(
        settings,
        "auth_mfa_encryption_key",
        base64.urlsafe_b64encode(b"m" * 32).decode("ascii"),
    )
    monkeypatch.setattr(settings, "auth_recovery_code_pepper", "unit-test-pepper")
    monkeypatch.setattr(
        settings,
        "auth_password_reset_encryption_key",
        base64.urlsafe_b64encode(b"a" * 32).decode(),
    )
    set_redis_client(fakeredis.aioredis.FakeRedis(decode_responses=True))
    yield
    set_redis_client(None)


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[SessionFactory]:
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine.sync_engine, "connect")
    def _fk(dbapi_connection, _record) -> None:  # type: ignore[no-untyped-def]
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture
async def client(
    session_factory: SessionFactory,
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def _override() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = _override
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        yield c


class Enrolled:
    """A user who has finished first sign-in: new password, MFA and recovery codes."""

    def __init__(self, access_token: str, key: str, codes: list[str]) -> None:
        self.access_token = access_token
        self.key = key
        self.codes = codes


async def _enrol(
    client: httpx.AsyncClient, session_factory: SessionFactory
) -> Enrolled:
    """Drive the forced-change first login, which issues a fresh challenge after the
    password change; finishing it proves that challenge stays usable."""
    async with session_factory() as session:
        session.add(
            User(
                oidc_subject="rotation-sub",
                email=EMAIL,
                role="HMS_ADMIN",
                password_hash=hash_password(FIRST_PASSWORD),
                must_change_password=True,
            )
        )
        await session.commit()
    login = await client.post(
        "/api/v1/auth/browser/login",
        json={"email": EMAIL, "password": FIRST_PASSWORD},
    )
    changed = await client.post(
        "/api/v1/auth/browser/password",
        json={"challenge": login.json()["challenge"], "new_password": PASSWORD},
    )
    assert changed.status_code == 200, changed.text
    challenge = changed.json()["challenge"]
    enroll = await client.post(
        "/api/v1/auth/browser/mfa/enrollment", json={"challenge": challenge}
    )
    key = enroll.json()["manual_key"]
    confirm = await client.post(
        "/api/v1/auth/browser/mfa/confirm",
        json={"challenge": challenge, "code": pyotp.TOTP(key).now()},
    )
    assert confirm.status_code == 200, confirm.text
    body = confirm.json()
    return Enrolled(body["access_token"], key, body["recovery_codes"])


async def _unfinished_login(client: httpx.AsyncClient) -> str:
    login = await client.post(
        "/api/v1/auth/browser/login", json={"email": EMAIL, "password": PASSWORD}
    )
    assert login.status_code == 200, login.text
    return str(login.json()["challenge"])


async def _change_by_self_service(
    client: httpx.AsyncClient, session_factory: SessionFactory, who: Enrolled
) -> None:
    r = await client.post(
        "/api/v1/auth/password",
        headers={"Authorization": f"Bearer {who.access_token}"},
        json={"current_password": PASSWORD, "new_password": "Another-Str0ng-Phrase!"},
    )
    assert r.status_code == 200, r.text


async def _change_by_admin_reset(
    client: httpx.AsyncClient, session_factory: SessionFactory, who: Enrolled
) -> None:
    async with session_factory() as session:
        session.add(
            User(oidc_subject="boss-sub", email="boss@example.com", role="SUPER_ADMIN")
        )
        target = await session.scalar(select(User).where(User.email == EMAIL))
        await session.commit()
        assert target is not None
        target_id = target.id
    token = encode_hs256_bearer_token(subject="boss-sub", secret=SECRET)
    r = await client.post(
        f"/api/v1/admin/users/{target_id}/password-reset",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text


async def _change_by_reset_link(
    client: httpx.AsyncClient, session_factory: SessionFactory, who: Enrolled
) -> None:
    requested = await client.post(
        "/api/v1/auth/browser/password/reset-request", json={"email": EMAIL}
    )
    assert requested.status_code == 202
    async with session_factory() as session:
        delivery = await session.scalar(select(PasswordResetDelivery))
        user = await session.scalar(select(User).where(User.email == EMAIL))
        assert delivery is not None and delivery.ciphertext is not None
        assert user is not None
        token = decrypt_password_reset_delivery(
            EncryptedPasswordResetDelivery(delivery.ciphertext, delivery.key_version),
            reset_id=delivery.reset_id,
            user_id=user.id,
        )
    confirmed = await client.post(
        "/api/v1/auth/browser/password/reset-confirm",
        json={"token": token, "new_password": "Reset-Str0ng-Passphrase!"},
    )
    assert confirmed.status_code == 200, confirmed.text


@pytest.mark.asyncio
async def test_an_unfinished_login_completes_when_nothing_changed(
    client: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    # The control: the challenge and recovery code used below are good ones.
    who = await _enrol(client, session_factory)
    challenge = await _unfinished_login(client)
    done = await client.post(
        "/api/v1/auth/browser/recovery/verify",
        json={"challenge": challenge, "code": who.codes[0]},
    )
    assert done.status_code == 200, done.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change", [_change_by_self_service, _change_by_admin_reset, _change_by_reset_link]
)
async def test_a_login_challenge_from_before_a_credential_change_cannot_finish(
    client: httpx.AsyncClient, session_factory: SessionFactory, change
) -> None:  # type: ignore[no-untyped-def]
    who = await _enrol(client, session_factory)
    challenge = await _unfinished_login(client)

    await change(client, session_factory, who)

    by_recovery = await client.post(
        "/api/v1/auth/browser/recovery/verify",
        json={"challenge": challenge, "code": who.codes[0]},
    )
    by_mfa = await client.post(
        "/api/v1/auth/browser/mfa/verify",
        json={"challenge": challenge, "code": pyotp.TOTP(who.key).now()},
    )
    assert by_recovery.status_code == 401, by_recovery.text
    assert by_mfa.status_code == 401, by_mfa.text
    assert "access_token" not in by_recovery.text + by_mfa.text
    async with session_factory() as session:
        open_challenges = (
            await session.scalars(
                select(BrowserAuthChallenge).where(
                    BrowserAuthChallenge.consumed_at.is_(None)
                )
            )
        ).all()
    # Nothing left open from before the change.
    assert open_challenges == []


@pytest.mark.asyncio
async def test_a_challenge_is_refused_when_its_version_is_stale_even_if_unconsumed(
    client: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    # The version check stands on its own, not only on the consume step: a challenge
    # row that somehow stayed open is still refused once the user's version moved on.
    who = await _enrol(client, session_factory)
    challenge = await _unfinished_login(client)
    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.email == EMAIL))
        assert user is not None
        user.credential_version += 1
        await session.commit()
    r = await client.post(
        "/api/v1/auth/browser/recovery/verify",
        json={"challenge": challenge, "code": who.codes[0]},
    )
    assert r.status_code == 401, r.text
