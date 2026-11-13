"""Change-own password and the retired admin set-password endpoint.

Sign-in itself is the browser flow (see ``test_browser_auth_api``); the legacy
password-only ``/auth/login`` was retired (``test_auth_login_retired``). An admin resets
someone else's password only through ``/admin/users/{id}/password-reset``.
"""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.auth import encode_hs256_bearer_token
from hms_backend.app.core.config import settings
from hms_backend.app.core.passwords import hash_password, verify_password
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.models.foundation import AuditEvent
from hms_backend.app.modules.identity.models import BrowserRefreshSession, User

_SECRET = "test-hmac-secret"
_PASSWORD = "correct horse battery"
SessionFactory = async_sessionmaker[AsyncSession]


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    yield factory
    await engine.dispose()


@pytest.fixture(autouse=True)
def _configure_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "auth_bearer_hmac_secret", _SECRET)


@pytest_asyncio.fixture
async def users(session_factory: SessionFactory) -> dict[str, str]:
    async with session_factory() as session:
        member = User(
            oidc_subject="member-sub",
            email="member@example.com",
            role="INSPECTOR",
            password_hash=hash_password(_PASSWORD),
        )
        admin = User(
            oidc_subject="admin-sub",
            email="admin@example.com",
            role="HMS_ADMIN",
        )
        session.add_all([member, admin])
        await session.commit()
        return {"member": member.id, "admin": admin.id}


@asynccontextmanager
async def _client(
    session_factory: SessionFactory,
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        yield c


def _refresh_session(user_id: str, token: str) -> BrowserRefreshSession:
    now = datetime.now(UTC)
    return BrowserRefreshSession(
        id=f"rs-{token}",
        user_id=user_id,
        family_id=f"fam-{token}",
        token_hash=token,
        expires_at=now + timedelta(days=30),
        idle_expires_at=now + timedelta(days=7),
    )


def _token(subject: str, *, credential_version: int | None = None) -> str:
    """A token as sign-in issues it; ``cv`` is the user's credential version and
    ``auth_time`` is a just-now sign-in."""
    extra: dict[str, object] = {"auth_time": int(datetime.now(UTC).timestamp())}
    if credential_version is not None:
        extra["cv"] = credential_version
    return encode_hs256_bearer_token(
        subject=subject, secret=_SECRET, extra_claims=extra
    )


@pytest.mark.asyncio
async def test_change_own_password(
    session_factory: SessionFactory,
    users: dict[str, str],
) -> None:
    headers = {"X-HMS-User-Id": "member-sub"}  # dev-mode identity
    async with _client(session_factory) as client:
        changed = await client.post(
            "/api/v1/auth/password",
            headers=headers,
            json={"current_password": _PASSWORD, "new_password": "brand-new-secret-9"},
        )
        assert changed.status_code == 200, changed.text
        wrong = await client.post(
            "/api/v1/auth/password",
            headers=headers,
            json={"current_password": _PASSWORD, "new_password": "another-secret-77"},
        )
    # The old password no longer verifies; the new one does.
    assert wrong.status_code == 400
    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.id == users["member"]))
        assert user is not None and user.password_hash is not None
        assert verify_password(user.password_hash, "brand-new-secret-9")
        assert not verify_password(user.password_hash, _PASSWORD)
        assert user.password_changed_at is not None
        assert user.must_change_password is False
        assert user.credential_version == 1
        event = (await session.scalars(select(AuditEvent))).one()
        assert event.action == "auth.password.changed"
        assert event.entity_id == users["member"]
        # The new password is never written to the ledger.
        assert "brand-new-secret-9" not in str(event.after)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "weak", ["short", "password123", "x" * (settings.auth_password_max_length + 1)]
)
async def test_change_own_password_uses_the_central_policy(
    session_factory: SessionFactory, users: dict[str, str], weak: str
) -> None:
    async with _client(session_factory) as client:
        r = await client.post(
            "/api/v1/auth/password",
            headers={"X-HMS-User-Id": "member-sub"},
            json={"current_password": _PASSWORD, "new_password": weak},
        )
    assert r.status_code == 400, r.text
    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.id == users["member"]))
        assert user is not None and user.password_hash is not None
        # Refused before anything changed: the old password still works.
        assert verify_password(user.password_hash, _PASSWORD)
        assert user.password_changed_at is None


@pytest.mark.asyncio
async def test_change_own_password_revokes_every_refresh_session(
    session_factory: SessionFactory, users: dict[str, str]
) -> None:
    async with session_factory() as session:
        session.add_all(
            [
                _refresh_session(users["member"], "member-a"),
                _refresh_session(users["member"], "member-b"),
                _refresh_session(users["admin"], "admin-a"),
            ]
        )
        await session.commit()
    async with _client(session_factory) as client:
        r = await client.post(
            "/api/v1/auth/password",
            headers={"X-HMS-User-Id": "member-sub"},
            json={"current_password": _PASSWORD, "new_password": "brand-new-secret-9"},
        )
        assert r.status_code == 200, r.text
    async with session_factory() as session:
        rows = {
            row.token_hash: row.revoked_at
            for row in await session.scalars(select(BrowserRefreshSession))
        }
    assert rows["member-a"] is not None and rows["member-b"] is not None
    # Someone else's sessions are untouched.
    assert rows["admin-a"] is None


@pytest.mark.asyncio
async def test_an_access_token_issued_before_a_password_change_is_refused(
    session_factory: SessionFactory,
    users: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "auth_mode", "bearer")
    # Issued in this very second: the change below happens in the same second as the
    # token, which a timestamp comparison could not tell apart.
    before = _token("member-sub", credential_version=0)
    async with _client(session_factory) as client:
        ok = await client.get(
            "/api/v1/auth/me", headers={"Authorization": f"Bearer {before}"}
        )
        assert ok.status_code == 200, ok.text
        changed = await client.post(
            "/api/v1/auth/password",
            headers={"Authorization": f"Bearer {before}"},
            json={"current_password": _PASSWORD, "new_password": "brand-new-secret-9"},
        )
        assert changed.status_code == 200, changed.text
        stale = await client.get(
            "/api/v1/auth/me", headers={"Authorization": f"Bearer {before}"}
        )
        # What signing in again issues: the new credential version.
        fresh = await client.get(
            "/api/v1/auth/me",
            headers={
                "Authorization": f"Bearer {_token('member-sub', credential_version=1)}"
            },
        )
    assert stale.status_code == 401
    assert fresh.status_code == 200, fresh.text


@pytest.mark.asyncio
async def test_an_admin_reset_also_refuses_the_users_older_access_token(
    session_factory: SessionFactory,
    users: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "auth_mode", "bearer")
    member = _token("member-sub", credential_version=0)
    admin = _token("admin-sub", credential_version=0)
    async with _client(session_factory) as client:
        reset = await client.post(
            f"/api/v1/admin/users/{users['member']}/password-reset",
            headers={"Authorization": f"Bearer {admin}"},
        )
        # The admin's token was minted just now, so the recent sign-in check passes;
        # the reset and its effect on the user's older token are what is under test.
        assert reset.status_code == 200, reset.text
        stale = await client.get(
            "/api/v1/auth/me", headers={"Authorization": f"Bearer {member}"}
        )
    assert stale.status_code == 401


@pytest.mark.asyncio
async def test_a_token_without_a_version_counts_as_version_zero(
    session_factory: SessionFactory,
    users: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Tokens issued before versions existed stay valid until the next credential change.
    monkeypatch.setattr(settings, "auth_mode", "bearer")
    async with _client(session_factory) as client:
        r = await client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {_token('member-sub')}"},
        )
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_the_alternate_admin_set_password_endpoint_no_longer_exists(
    session_factory: SessionFactory, users: dict[str, str]
) -> None:
    async with _client(session_factory) as client:
        r = await client.post(
            f"/api/v1/auth/users/{users['member']}/password",
            headers={"X-HMS-User-Id": "admin-sub"},
            json={"new_password": "admin-set-secret-1"},
        )
    assert r.status_code in (404, 405)
    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.id == users["member"]))
        assert user is not None and user.password_hash is not None
        assert verify_password(user.password_hash, _PASSWORD)


@pytest.mark.asyncio
async def test_an_hms_admin_cannot_reset_a_super_admin_password(
    session_factory: SessionFactory,
) -> None:
    async with session_factory() as session:
        boss = User(
            oidc_subject="boss-sub",
            email="boss@example.com",
            role="SUPER_ADMIN",
            password_hash=hash_password(_PASSWORD),
        )
        admin = User(oidc_subject="hms-sub", email="hms@example.com", role="HMS_ADMIN")
        session.add_all([boss, admin])
        await session.commit()
        boss_id = boss.id
    async with _client(session_factory) as client:
        r = await client.post(
            f"/api/v1/admin/users/{boss_id}/password-reset",
            headers={"X-HMS-User-Id": "hms-sub"},
        )
    assert r.status_code == 403, r.text
    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.id == boss_id))
        assert user is not None and user.password_hash is not None
        assert verify_password(user.password_hash, _PASSWORD)
        assert user.password_changed_at is None


@pytest.mark.asyncio
async def test_an_admin_reset_forces_a_change_and_ends_the_users_sessions(
    session_factory: SessionFactory, users: dict[str, str]
) -> None:
    async with session_factory() as session:
        session.add(_refresh_session(users["member"], "member-a"))
        await session.commit()
    async with _client(session_factory) as client:
        r = await client.post(
            f"/api/v1/admin/users/{users['member']}/password-reset",
            headers={"X-HMS-User-Id": "admin-sub"},
        )
        assert r.status_code == 200, r.text
    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.id == users["member"]))
        assert user is not None
        assert user.must_change_password is True
        assert user.password_changed_at is not None
        assert user.credential_version == 1
        revoked = await session.scalar(select(BrowserRefreshSession))
        assert revoked is not None and revoked.revoked_at is not None


@pytest.mark.asyncio
async def test_change_own_password_requires_the_current_password(
    session_factory: SessionFactory, users: dict[str, str]
) -> None:
    async with _client(session_factory) as client:
        r = await client.post(
            "/api/v1/auth/password",
            headers={"X-HMS-User-Id": "member-sub"},
            json={
                "current_password": "not-it-at-all-1",
                "new_password": "brand-new-secret-9",
            },
        )
    assert r.status_code == 400
