from __future__ import annotations

import pytest
from pydantic import ValidationError

from hms_backend.app.api.auth import LoginRequest
from hms_backend.app.api.browser_auth import BrowserLoginRequest
from hms_backend.app.api.schemas import CustomerCreate
from hms_backend.app.api.sync_schemas import SyncPushRequest


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        (
            LoginRequest,
            {"email": "user@example.test", "password": "password", "role": "ADMIN"},
        ),
        (
            BrowserLoginRequest,
            {"email": "user@example.test", "password": "password", "role": "ADMIN"},
        ),
        (
            CustomerCreate,
            {"name": "Customer", "code": "CUST", "is_super_admin": True},
        ),
        (
            SyncPushRequest,
            {"operations": [], "force": True},
        ),
    ],
)
def test_request_models_reject_unknown_fields(
    model: type[object], payload: dict[str, object]
) -> None:
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        model.model_validate(payload)  # type: ignore[attr-defined]
