"""Celery application for HMS 2.0 async jobs.

Broker and result backend default to Redis. Tasks are auto-discovered from the
modules' ``tasks`` submodules. Set ``CELERY_TASK_ALWAYS_EAGER=true`` (or the
Settings flag) to run tasks inline without a broker — used by tests and trivial
local setups.

Run a worker with::

    celery -A hms_backend.app.core.celery_app:celery_app worker --loglevel=info
"""

from __future__ import annotations

from celery import Celery  # type: ignore[import-untyped]
from celery.schedules import crontab  # type: ignore[import-untyped]

from hms_backend.app.core.config import settings

celery_app = Celery(
    "hms",
    broker=settings.effective_broker_url,
    backend=settings.effective_result_backend,
    include=[
        "hms_backend.app.modules.certificates.tasks",
        "hms_backend.app.modules.notifications.tasks",
    ],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_always_eager=settings.celery_task_always_eager,
    task_eager_propagates=settings.celery_task_always_eager,
    result_expires=60 * 60 * 24 * 7,  # 7 days
    timezone="UTC",
    beat_schedule={
        # Turn committed outbox events into notification rows.
        "notifications-relay": {
            "task": "notifications.relay",
            "schedule": 30.0,
        },
        # Send pending notifications (and process retries).
        "notifications-dispatch": {
            "task": "notifications.dispatch",
            "schedule": 30.0,
        },
        # Deliver short-lived password reset envelopes without materialising
        # links in the permanent notification log.
        "notifications-password-reset-delivery": {
            "task": "notifications.password_reset_delivery",
            "schedule": 30.0,
        },
        # Daily retest reminder + overdue escalation scheduler (07:00 UTC).
        "notifications-schedule-retests": {
            "task": "notifications.schedule_retests",
            "schedule": crontab(hour=7, minute=0),
        },
    },
)


def _register_all_models() -> None:
    """Import every ORM model so SQLAlchemy's mapper registry is complete.

    The worker's task import chain only pulls in a subset of models, so
    string-based relationships (e.g. ``Inspection -> "Asset"``) would fail to
    resolve at mapper-configuration time. Importing all model modules here — and
    running ``configure_mappers`` eagerly — guarantees the registry is populated
    in the worker exactly as it is in the API process.
    """
    import importlib

    from sqlalchemy.orm import configure_mappers

    for module_path in (
        "hms_backend.app.models.foundation",
        "hms_backend.app.modules.assets.models",
        "hms_backend.app.modules.certificates.models",
        "hms_backend.app.modules.customers.models",
        "hms_backend.app.modules.identity.models",
        "hms_backend.app.modules.inspections.models",
        "hms_backend.app.modules.jobs.models",
        "hms_backend.app.modules.notifications.models",
        "hms_backend.app.modules.products.models",
        "hms_backend.app.modules.reference.models",
        "hms_backend.app.modules.scheduling.models",
    ):
        importlib.import_module(module_path)

    configure_mappers()


_register_all_models()
