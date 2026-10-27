"""One wording for every notification category, in every app.

The Staff app (which also serves the customer portal) and the Inspector each carry a
copy of ``presentation.ts``: the apps build and ship separately, so they cannot import
one file. This keeps the copies identical and keeps them covering every category the
backend can send.
"""

from __future__ import annotations

import re
from pathlib import Path

from hms_backend.app.modules.notifications.enums import NotificationCategory

ROOT = Path(__file__).resolve().parents[2] / "web" / "apps"
STAFF = ROOT / "staff" / "src" / "notifications" / "presentation.ts"
INSPECTOR = ROOT / "inspector" / "src" / "notifications" / "presentation.ts"


def _categories(text: str) -> set[str]:
    return set(re.findall(r"^  ([A-Z][A-Z_]+): \{ icon:", text, flags=re.MULTILINE))


def test_the_two_copies_are_identical() -> None:
    assert STAFF.read_text() == INSPECTOR.read_text()


def test_every_category_has_wording_and_nothing_else_does() -> None:
    expected = {category.value for category in NotificationCategory}
    assert _categories(STAFF.read_text()) == expected
