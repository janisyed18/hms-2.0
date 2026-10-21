"""Historical audit rows round-tripped through real PostgreSQL JSON columns.

SQLite proves the redaction logic; only PostgreSQL proves the shape the API actually
receives for rows written by older code, and the serialised HTTP response is the
boundary that matters, so these tests scan the response body itself.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import delete, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hms_backend.app.api.dependencies import get_session
from hms_backend.app.core.audit import REDACTED, _audit_hash, verify_audit_chain
from hms_backend.app.core.rbac import Role
from hms_backend.app.main import create_app
from hms_backend.app.models.foundation import AuditEvent
from hms_backend.app.modules.identity import models as _identity_models  # noqa: F401
from hms_backend.app.modules.identity.models import User

POSTGRES_URL = os.environ.get("POSTGRES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="POSTGRES_TEST_DATABASE_URL is not configured"
)

SENSITIVE_KEYS = ("password_hash", "mfa_secret_ciphertext")


@pytest_asyncio.fixture
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert POSTGRES_URL is not None
    if not POSTGRES_URL.startswith("postgresql+asyncpg://"):
        raise ValueError("These tests require a dedicated async PostgreSQL database")
    database_name = make_url(POSTGRES_URL).database
    if database_name is None or not database_name.endswith("_test"):
        raise ValueError("These tests require a database name ending in _test")
    engine = create_async_engine(POSTGRES_URL, pool_size=4)
    try:
        async with engine.connect() as connection:
            version = await connection.scalar(
                text("SELECT version_num FROM alembic_version")
            )
            head = ScriptDirectory.from_config(Config("alembic.ini")).get_current_head()
            assert version == head, "Migrate the test database first"
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


def _walk(value: object, found: list[tuple[str, object]]) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in SENSITIVE_KEYS:
                found.append((key, item))
            _walk(item, found)
    elif isinstance(value, list):
        for item in value:
            _walk(item, found)


@pytest.mark.asyncio
async def test_historical_user_rows_are_redacted_in_the_serialised_response(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    tag = uuid4().hex[:12]
    argon = f"$argon2id$v=19$m=65536,t=3,p=4$hist{tag}$ZmFrZWhhc2g"
    ciphertext = f"v1:hist-ciphertext-{tag}"
    nested_secret = f"nested-secret-{tag}"
    admin_subject = f"audit-admin-{tag}"
    entity_id = f"hist-user-{tag}"
    inserted: list[int] = []

    async with session_factory() as session:
        admin = User(
            oidc_subject=admin_subject,
            email=f"{admin_subject}@example.com",
            role=Role.HMS_ADMIN.value,
        )
        subject = User(
            id=entity_id[:36],
            oidc_subject=f"hist-{tag}",
            email=f"hist-{tag}@example.com",
            role=Role.INSPECTOR.value,
            password_hash=argon,
            mfa_secret_ciphertext=ciphertext,
            mfa_secret_key_version=1,
            legacy_payload={"import": {"mfa_secret": nested_secret}},
        )
        session.add_all([admin, subject])
        await session.flush()
        # Exactly what pre-redaction code stored: every column of the user row.
        raw_row = subject.to_audit_dict()
        assert raw_row["password_hash"] == argon

        latest = (
            await session.scalars(
                select(AuditEvent).order_by(AuditEvent.sequence.desc())
            )
        ).first()
        prev_hash = latest.hash if latest else None
        for action, before, after in (
            ("user.created", None, raw_row),
            ("user.updated", raw_row, raw_row),
        ):
            event = AuditEvent(
                actor_id=admin.id,
                action=action,
                entity="User",
                entity_id=entity_id,
                before=before,
                after=after,
                timestamp=datetime.now(UTC),
                prev_hash=prev_hash,
                hash="",
            )
            event.hash = _audit_hash(event)
            session.add(event)
            await session.flush()
            inserted.append(event.sequence)
            prev_hash = event.hash
        await session.commit()
        stored_hashes = {
            row.sequence: row.hash
            for row in (
                await session.scalars(
                    select(AuditEvent).where(AuditEvent.sequence.in_(inserted))
                )
            ).all()
        }

    app = create_app()

    async def override_session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
            headers={"X-HMS-User-Id": admin_subject},
        ) as client:
            response = await client.get(
                "/api/v1/admin/audit-events",
                params={"entity": "User", "search": entity_id, "limit": 100},
            )

        assert response.status_code == 200, response.text
        # The exact bytes handed to the client: no fixture secret may appear.
        for secret in (argon, ciphertext, nested_secret, "$argon2"):
            assert secret not in response.text

        items = response.json()["items"]
        assert {item["sequence"] for item in items} == set(inserted)
        found: list[tuple[str, object]] = []
        for item in items:
            _walk(item["before"], found)
            _walk(item["after"], found)
        assert found, "expected the sensitive keys to be present in the payloads"
        assert all(value in (REDACTED, None) for _, value in found)
        assert any(value == REDACTED for _, value in found)
        for item in items:
            assert item["hash"] == stored_hashes[item["sequence"]]

        # Presentation only: the stored rows and the chain are unchanged.
        async with session_factory() as session:
            rows = (
                await session.scalars(
                    select(AuditEvent).where(AuditEvent.sequence.in_(inserted))
                )
            ).all()
            assert all(row.after is not None for row in rows)
            assert {row.after["password_hash"] for row in rows if row.after} == {argon}
            assert await verify_audit_chain(session)
    finally:
        async with session_factory() as session:
            await session.execute(
                delete(AuditEvent).where(AuditEvent.sequence.in_(inserted))
            )
            await session.execute(
                delete(User).where(
                    User.oidc_subject.in_([admin_subject, f"hist-{tag}"])
                )
            )
            await session.commit()
