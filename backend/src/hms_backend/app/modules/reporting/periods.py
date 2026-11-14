"""Reporting calendar: one organisation timezone, UTC instants everywhere else.

Event timestamps use the half-open interval ``start <= t < end``. Date-only deadlines
are compared with the organisation's current calendar date and are never filtered by
the reporting period.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from hms_backend.app.core.config import settings

Granularity = Literal["hour", "day", "week"]

MAX_BUCKETS = 120
DUE_SOON_DAYS = 7
CERTIFICATE_EXPIRY_DAYS = 60


def org_zone() -> ZoneInfo:
    return ZoneInfo(settings.reporting_timezone)


def local_midnight_utc(day: date, zone: ZoneInfo) -> datetime:
    """The UTC instant at which ``day`` begins in ``zone`` (DST-safe)."""
    return datetime.combine(day, time.min, tzinfo=zone).astimezone(UTC)


@dataclass(frozen=True)
class Reference:
    """One consistent 'now' shared by every query behind a response."""

    as_of: datetime
    timezone: str
    today: date
    due_soon_end: date
    certificate_expiry_end: date
    day_start: datetime
    day_end: datetime


def reference(now: datetime | None = None) -> Reference:
    zone = org_zone()
    as_of = (now or datetime.now(UTC)).astimezone(UTC)
    today = as_of.astimezone(zone).date()
    return Reference(
        as_of=as_of,
        timezone=settings.reporting_timezone,
        today=today,
        due_soon_end=today + timedelta(days=DUE_SOON_DAYS),
        certificate_expiry_end=today + timedelta(days=CERTIFICATE_EXPIRY_DAYS),
        day_start=local_midnight_utc(today, zone),
        day_end=local_midnight_utc(today + timedelta(days=1), zone),
    )


@dataclass(frozen=True)
class Bucket:
    start: datetime
    end: datetime


class PeriodError(ValueError):
    pass


def choose_granularity(start: datetime, end: datetime) -> Granularity:
    span = end - start
    if span <= timedelta(hours=48):
        return "hour"
    if span <= timedelta(days=100):
        return "day"
    return "week"


def build_buckets(
    start: datetime,
    end: datetime,
    granularity: Granularity,
    zone: ZoneInfo | None = None,
) -> list[Bucket]:
    """Contiguous buckets covering exactly ``[start, end)``.

    Day and week boundaries follow local midnight, so a daylight-saving day is 23 or 25
    hours long rather than being split or skipped. The first and last bucket are clipped
    to the requested interval.
    """
    zone = zone or org_zone()
    start = start.astimezone(UTC)
    end = end.astimezone(UTC)
    if start >= end:
        raise PeriodError("end_at must be later than start_at")

    boundaries: list[datetime] = []
    if granularity == "hour":
        cursor = start.astimezone(zone).replace(minute=0, second=0, microsecond=0)
        cursor = cursor.astimezone(UTC)
        while cursor < end:
            boundaries.append(cursor)
            cursor += timedelta(hours=1)
            if len(boundaries) > MAX_BUCKETS:
                raise PeriodError("reporting period is too long for hourly buckets")
    else:
        day = start.astimezone(zone).date()
        if granularity == "week":
            day -= timedelta(days=day.weekday())  # Monday
        step = timedelta(days=7 if granularity == "week" else 1)
        while True:
            instant = local_midnight_utc(day, zone)
            if instant >= end:
                break
            boundaries.append(instant)
            day += step
            if len(boundaries) > MAX_BUCKETS:
                raise PeriodError(
                    f"reporting period is too long for {granularity} buckets"
                )
        boundaries_end = local_midnight_utc(day, zone)
    buckets: list[Bucket] = []
    for index, bucket_start in enumerate(boundaries):
        if index + 1 < len(boundaries):
            bucket_end = boundaries[index + 1]
        elif granularity == "hour":
            bucket_end = bucket_start + timedelta(hours=1)
        else:
            bucket_end = boundaries_end
        clipped_start = max(bucket_start, start)
        clipped_end = min(bucket_end, end)
        if clipped_start < clipped_end:
            buckets.append(Bucket(clipped_start, clipped_end))
    return buckets
