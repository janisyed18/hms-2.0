from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from hms_backend.app.api.dependencies import get_current_principal
from hms_backend.app.core.config import settings
from hms_backend.app.core.rbac import ROLE_PERMISSIONS, Principal

router = APIRouter(prefix="/auth")

PrincipalDep = Annotated[Principal, Depends(get_current_principal)]


class AuthMeResponse(BaseModel):
    user_id: str
    roles: list[str]
    permissions: list[str]
    customer_ids: list[str]
    auth_mode: str


@router.get("/me", response_model=AuthMeResponse)
async def read_current_auth_session(principal: PrincipalDep) -> AuthMeResponse:
    return AuthMeResponse(
        user_id=principal.user_id,
        roles=sorted(role.value for role in principal.roles),
        permissions=sorted(
            permission.value
            for role in principal.roles
            for permission in ROLE_PERMISSIONS[role]
        ),
        customer_ids=sorted(principal.customer_ids),
        auth_mode=settings.auth_mode,
    )
