"""Channel adapter registry — selects adapters from settings."""

from __future__ import annotations

from hms_backend.app.core.config import Settings
from hms_backend.app.core.config import settings as default_settings
from hms_backend.app.modules.notifications.channels.base import ChannelAdapter
from hms_backend.app.modules.notifications.channels.console import (
    ConsoleEmailAdapter,
    ConsoleSmsAdapter,
    InAppAdapter,
)
from hms_backend.app.modules.notifications.channels.email_ses import AwsSesEmailAdapter
from hms_backend.app.modules.notifications.channels.email_smtp import SmtpEmailAdapter
from hms_backend.app.modules.notifications.channels.sms_twilio import TwilioSmsAdapter
from hms_backend.app.modules.notifications.enums import NotificationChannel


def build_channel_adapters(
    settings: Settings | None = None,
) -> dict[NotificationChannel, ChannelAdapter]:
    settings = settings or default_settings
    in_app = InAppAdapter()
    if settings.notification_channel_mode == "live":
        email_adapter: ChannelAdapter
        if settings.notification_email_provider == "aws_ses":
            email_adapter = AwsSesEmailAdapter(settings)
        else:
            email_adapter = SmtpEmailAdapter(settings)
        return {
            NotificationChannel.EMAIL: email_adapter,
            NotificationChannel.SMS: TwilioSmsAdapter(settings),
            NotificationChannel.IN_APP: in_app,
        }
    return {
        NotificationChannel.EMAIL: ConsoleEmailAdapter(),
        NotificationChannel.SMS: ConsoleSmsAdapter(),
        NotificationChannel.IN_APP: in_app,
    }


_adapters: dict[NotificationChannel, ChannelAdapter] | None = None


def get_channel_adapters() -> dict[NotificationChannel, ChannelAdapter]:
    global _adapters
    if _adapters is None:
        _adapters = build_channel_adapters()
    return _adapters
