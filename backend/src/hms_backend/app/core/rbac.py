from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from sqlalchemy import false
from sqlalchemy.sql import Select


class Role(StrEnum):
    SUPER_ADMIN = "SUPER_ADMIN"
    HMS_ADMIN = "HMS_ADMIN"
    INSPECTOR = "INSPECTOR"
    ASSEMBLY = "ASSEMBLY"
    REVIEWER = "REVIEWER"
    CUSTOMER_USER = "CUSTOMER_USER"


class Permission(StrEnum):
    CUSTOMER_READ = "customer:read"
    CUSTOMER_WRITE = "customer:write"
    ASSET_READ = "asset:read"
    ASSET_WRITE = "asset:write"
    INSPECTION_WRITE = "inspection:write"
    CERTIFICATE_APPROVE = "certificate:approve"
    REFERENCE_ADMIN = "reference:admin"
    USER_ADMIN = "user:admin"
    DEVICE_ADMIN = "device:admin"
    AUDIT_READ = "audit:read"


ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    Role.SUPER_ADMIN: frozenset(Permission),
    Role.HMS_ADMIN: frozenset(
        {
            Permission.CUSTOMER_READ,
            Permission.CUSTOMER_WRITE,
            Permission.ASSET_READ,
            Permission.ASSET_WRITE,
            Permission.REFERENCE_ADMIN,
            Permission.USER_ADMIN,
            Permission.DEVICE_ADMIN,
            Permission.AUDIT_READ,
        }
    ),
    Role.INSPECTOR: frozenset(
        {
            Permission.CUSTOMER_READ,
            Permission.ASSET_READ,
            Permission.INSPECTION_WRITE,
        }
    ),
    Role.ASSEMBLY: frozenset(
        {
            Permission.CUSTOMER_READ,
            Permission.ASSET_READ,
            Permission.ASSET_WRITE,
        }
    ),
    Role.REVIEWER: frozenset(
        {
            Permission.CUSTOMER_READ,
            Permission.ASSET_READ,
            Permission.CERTIFICATE_APPROVE,
        }
    ),
    Role.CUSTOMER_USER: frozenset(
        {
            Permission.CUSTOMER_READ,
            Permission.ASSET_READ,
        }
    ),
}


@dataclass(frozen=True)
class Principal:
    user_id: str
    roles: frozenset[Role]
    customer_ids: frozenset[str]
    # Unix seconds of the credential presentation (from the token ``auth_time``
    # claim), used to gate privileged actions on a recent sign-in. None for
    # dev-header identities.
    auth_time: int | None = None


def has_permission(principal: Principal, permission: Permission) -> bool:
    return any(permission in ROLE_PERMISSIONS[role] for role in principal.roles)


def require_permission(principal: Principal, permission: Permission) -> None:
    if not has_permission(principal, permission):
        raise PermissionError(f"Missing permission: {permission}")


def is_customer_scoped(principal: Principal) -> bool:
    elevated_roles = {
        Role.SUPER_ADMIN,
        Role.HMS_ADMIN,
        Role.INSPECTOR,
        Role.ASSEMBLY,
        Role.REVIEWER,
    }
    return Role.CUSTOMER_USER in principal.roles and principal.roles.isdisjoint(
        elevated_roles
    )


def apply_customer_scope(
    statement: Select[tuple[Any, ...]],
    customer_model: type[Any],
    principal: Principal,
) -> Select[tuple[Any, ...]]:
    if not is_customer_scoped(principal):
        return statement
    if not principal.customer_ids:
        return statement.where(false())
    return statement.where(customer_model.id.in_(principal.customer_ids))
