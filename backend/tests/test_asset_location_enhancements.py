from datetime import date

from hms_backend.app.api.records import _add_calendar_years
from hms_backend.app.modules.assets.models import AssetNumberCounter
from hms_backend.app.modules.customers.models import CustomerLocationContact


def test_next_inspection_date_uses_calendar_years_and_handles_leap_day() -> None:
    assert _add_calendar_years(date(2026, 1, 15)) == date(2027, 1, 15)
    assert _add_calendar_years(date(2024, 2, 29)) == date(2025, 2, 28)


def test_location_contact_and_asset_counter_are_persistent_models() -> None:
    assert CustomerLocationContact.__tablename__ == "customer_location_contacts"
    assert AssetNumberCounter.__tablename__ == "asset_number_counters"
