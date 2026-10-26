"""Credential material must not enter, or leave, the audit trail."""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.audit import (
    REDACTED,
    _audit_hash,
    redact_sensitive,
    verify_audit_chain,
)
from hms_backend.app.core.rbac import Role
from hms_backend.app.main import create_app
from hms_backend.app.models.base import Base
from hms_backend.app.models.foundation import AuditEvent
from hms_backend.app.modules.identity.models import User

ARGON_HASH = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$ZmFrZWhhc2hmYWtlaGFzaA"
MFA_CIPHERTEXT = "v1:ZmFrZS1jaXBoZXJ0ZXh0LWZvci10ZXN0cw=="
SECRET_VALUES = (ARGON_HASH, MFA_CIPHERTEXT)


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@asynccontextmanager
async def admin_client(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncGenerator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"X-HMS-User-Id": "staff-ui-dev"},
    ) as client:
        yield client


async def _seed_admin(session_factory: async_sessionmaker[AsyncSession]) -> None:
    async with session_factory() as session:
        session.add(
            User(
                oidc_subject="staff-ui-dev",
                email="staff@example.com",
                role=Role.HMS_ADMIN.value,
            )
        )
        await session.commit()


# --- the redaction function ----------------------------------------------------


def test_credentials_are_replaced_at_any_depth() -> None:
    redacted = redact_sensitive(
        {
            "password_hash": ARGON_HASH,
            "Mfa_Secret_Ciphertext": MFA_CIPHERTEXT,
            "nested": {"refresh_token": "abc", "items": [{"api_key": "k"}]},
            "token_hash": "deadbeef",
            "code_digest": "cafe",
        }
    )
    assert redacted == {
        "password_hash": REDACTED,
        "Mfa_Secret_Ciphertext": REDACTED,
        "nested": {"refresh_token": REDACTED, "items": [{"api_key": REDACTED}]},
        "token_hash": REDACTED,
        "code_digest": REDACTED,
    }


def test_harmless_security_state_stays_visible() -> None:
    state = {
        "must_change_password": True,
        "password_changed_at": "2026-10-18T00:00:00+00:00",
        "failed_password_attempts": 2,
        "mfa_enabled": True,
        "mfa_secret_key_version": 1,
        "account_status": "ACTIVE",
        "pdf_sha256": "a" * 64,
    }
    assert redact_sensitive(state) == state


def test_absent_credential_stays_none_and_input_is_not_mutated() -> None:
    original = {"password_hash": None, "mfa_secret_ciphertext": MFA_CIPHERTEXT}
    redacted = redact_sensitive(original)
    assert redacted == {"password_hash": None, "mfa_secret_ciphertext": REDACTED}
    assert original["mfa_secret_ciphertext"] == MFA_CIPHERTEXT


# --- write path: new events never contain credentials ---------------------------


@pytest.mark.asyncio
async def test_user_lifecycle_audit_events_contain_no_credentials(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_admin(session_factory)
    async with admin_client(session_factory) as client:
        created = await client.post(
            "/api/v1/admin/users",
            json={
                "oidc_subject": "inspector-1",
                "email": "inspector@example.com",
                "first_name": "Test",
                "last_name": "Person",
                "role": "INSPECTOR",
                "customer_id": None,
            },
        )
        assert created.status_code == 201
        user_id = created.json()["user"]["id"]
        temporary_password = created.json()["temporary_password"]

    async with session_factory() as session:
        user = await session.get(User, user_id)
        assert user is not None
        user.mfa_secret_ciphertext = MFA_CIPHERTEXT
        await session.commit()

    async with admin_client(session_factory) as client:
        updated = await client.patch(
            f"/api/v1/admin/users/{user_id}", json={"first_name": "Ivy"}
        )
        deleted = await client.delete(f"/api/v1/admin/users/{user_id}")
        assert updated.status_code == 200
        assert deleted.status_code == 204

    async with session_factory() as session:
        stored = (
            await session.scalars(select(AuditEvent).order_by(AuditEvent.sequence))
        ).all()
        assert [event.action for event in stored] == [
            "user.created",
            "user.updated",
            "user.deleted",
        ]
        raw = json.dumps([[event.before, event.after] for event in stored])
        assert "$argon2" not in raw
        assert temporary_password not in raw
        assert MFA_CIPHERTEXT not in raw
        created_after = stored[0].after
        assert created_after is not None
        assert created_after["password_hash"] == REDACTED
        assert created_after["email"] == "inspector@example.com"
        updated_before = stored[1].before
        assert updated_before is not None
        assert updated_before["mfa_secret_ciphertext"] == REDACTED
        assert await verify_audit_chain(session)


# --- read path: historical rows are redacted on the way out ---------------------


async def _insert_historical_event(
    session: AsyncSession, *, sequence: int, prev_hash: str | None
) -> AuditEvent:
    """A row as written before redaction existed: raw credentials, valid chain."""
    event = AuditEvent(
        sequence=sequence,
        actor_id="staff-ui-dev",
        action="user.updated",
        entity="User",
        entity_id="legacy-user",
        before={"password_hash": ARGON_HASH, "role": "INSPECTOR"},
        after={
            "password_hash": ARGON_HASH,
            "mfa_secret_ciphertext": MFA_CIPHERTEXT,
            "role": "INSPECTOR",
        },
        timestamp=datetime(2026, 1, 1, tzinfo=UTC),
        prev_hash=prev_hash,
        hash="",
    )
    event.hash = _audit_hash(event)
    session.add(event)
    await session.flush()
    return event


@pytest.mark.asyncio
async def test_admin_audit_api_redacts_historical_rows_and_leaves_them_untouched(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_admin(session_factory)
    async with session_factory() as session:
        historical = await _insert_historical_event(session, sequence=1, prev_hash=None)
        stored_hash = historical.hash
        await session.commit()

    async with admin_client(session_factory) as client:
        response = await client.get(
            "/api/v1/admin/audit-events", params={"entity": "User"}
        )

    assert response.status_code == 200
    body = response.text
    assert ARGON_HASH not in body
    assert MFA_CIPHERTEXT not in body
    item = response.json()["items"][0]
    assert item["before"] == {"password_hash": REDACTED, "role": "INSPECTOR"}
    assert item["after"]["mfa_secret_ciphertext"] == REDACTED
    assert item["after"]["role"] == "INSPECTOR"
    assert item["hash"] == stored_hash

    # Redaction is presentation only: the stored row and its chain are unchanged.
    async with session_factory() as session:
        row = (
            await session.scalars(select(AuditEvent).where(AuditEvent.sequence == 1))
        ).one()
        assert row.before == {"password_hash": ARGON_HASH, "role": "INSPECTOR"}
        assert row.hash == stored_hash
        assert await verify_audit_chain(session)


@pytest.mark.asyncio
async def test_new_events_chain_correctly_after_historical_unredacted_rows(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_admin(session_factory)
    async with session_factory() as session:
        await _insert_historical_event(session, sequence=1, prev_hash=None)
        await session.commit()

    async with admin_client(session_factory) as client:
        created = await client.post(
            "/api/v1/admin/users",
            json={
                "oidc_subject": "inspector-2",
                "email": "inspector2@example.com",
                "first_name": "Test",
                "last_name": "Person",
                "role": "INSPECTOR",
                "customer_id": None,
            },
        )
        assert created.status_code == 201

    async with session_factory() as session:
        assert await verify_audit_chain(session)
