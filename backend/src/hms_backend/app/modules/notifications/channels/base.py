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
    # RFC 8058: the HTTPS URL (with its signed token) behind the mail client's own
    # "Unsubscribe" button. Only informational email carries one.
    unsubscribe_url: str | None = None


LIST_UNSUBSCRIBE_POST = "List-Unsubscribe=One-Click"


def list_unsubscribe_headers(unsubscribe_url: str | None) -> dict[str, str]:
    """The RFC 8058 headers for one message, or none.

    RFC 8058 requires an HTTPS URI, so a plain-http local URL gets no headers rather
    than headers a mail client would ignore or refuse.
    """
    if not unsubscribe_url or not unsubscribe_url.lower().startswith("https://"):
        return {}
    return {
        "List-Unsubscribe": f"<{unsubscribe_url}>",
        "List-Unsubscribe-Post": LIST_UNSUBSCRIBE_POST,
    }


@dataclass(frozen=True)
class DeliveryResult:
    success: bool
    provider_message_id: str | None = None
    error: str | None = None


class ChannelAdapter(Protocol):
    channel: NotificationChannel

    async def send(self, message: OutgoingMessage) -> DeliveryResult: ...
