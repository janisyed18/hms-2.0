"""Celery tasks for the notification engine.

* ``notifications.relay`` — outbox -> notification rows (frequent).
* ``notifications.dispatch`` — send PENDING notifications with retry (frequent).
* ``notifications.schedule_retests`` — daily reminder/escalation scheduler.

Each builds a fresh async engine inside the running loop (like the certificate
bulk task) so it is safe under Celery's prefork pool.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from hms_backend.app.core.celery_app import celery_app
from hms_backend.app.core.config import settings
from hms_backend.app.modules.notifications.password_reset_delivery import (
    dispatch_password_reset_deliveries,
)
from hms_backend.app.modules.notifications.service import (
    dispatch_pending,
    relay_outbox,
    run_retest_scheduler,
)

Runner = Callable[[async_sessionmaker[AsyncSession]], Awaitable[dict[str, int]]]


async def _run(fn: Runner) -> dict[str, int]:
    engine = create_async_engine(settings.database_url)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        return await fn(session_factory)
    finally:
        await engine.dispose()


@celery_app.task(name="notifications.relay")  # type: ignore[untyped-decorator]
def relay_outbox_task() -> dict[str, Any]:
    return asyncio.run(_run(relay_outbox))


@celery_app.task(name="notifications.dispatch")  # type: ignore[untyped-decorator]
def dispatch_notifications_task() -> dict[str, Any]:
    return asyncio.run(_run(dispatch_pending))


@celery_app.task(name="notifications.password_reset_delivery")  # type: ignore[untyped-decorator]
def password_reset_delivery_task() -> dict[str, Any]:
    return asyncio.run(_run(dispatch_password_reset_deliveries))


@celery_app.task(  # type: ignore[untyped-decorator]
    name="notifications.schedule_retests"
)
def schedule_retests_task() -> dict[str, Any]:
    return asyncio.run(_run(run_retest_scheduler))
