"""Channel-adapter abstraction (spec §3.3).

Adapters isolate providers (OCI Email Delivery, Twilio) from dispatch logic, so a
provider can be swapped or supplemented without touching the dispatcher.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from hms_backend.app.modules.notifications.enums import NotificationChannel


@dataclass(frozen=True)
class OutgoingMessage:
    channel: NotificationChannel
    to_address: str
    subject: str | None
    body_text: str
    body_html: str | None = None


@dataclass(frozen=True)
class DeliveryResult:
    success: bool
    provider_message_id: str | None = None
    error: str | None = None


class ChannelAdapter(Protocol):
    channel: NotificationChannel

    async def send(self, message: OutgoingMessage) -> DeliveryResult: ...
