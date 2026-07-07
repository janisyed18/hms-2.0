"""Idempotency keys for notification de-duplication (spec §3.5; N-07).

The key is derived from the triggering event, the recipient and the channel, so
retried outbox events or overlapping scheduler runs never produce a duplicate
send to the same recipient on the same channel.
"""

from __future__ import annotations

import hashlib

from hms_backend.app.modules.notifications.enums import (
    NotificationChannel,
    RecipientType,
)


def notification_idempotency_key(
    *,
    event_ref: str,
    recipient_type: RecipientType,
    recipient_id: str,
    channel: NotificationChannel,
) -> str:
    """Deterministic SHA-256 key unique per (event, recipient, channel)."""
    raw = "|".join(
        [
            "hms-notify-v1",
            event_ref,
            recipient_type.value,
            recipient_id,
            channel.value,
        ]
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
