"""User-administration privilege boundaries (Task 5).

Pure, ORM-free rules for *who may manage whom*, customer-scope validity, and the
recent-authentication requirement for privileged actions. Keeping these out of
the endpoint layer makes the security matrix directly unit-testable.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from hms_backend.app.core.rbac import Role


class PrivilegeError(Exception):
    """Raised when an actor may not perform a user-administration action."""


# Which roles each actor role is allowed to create / manage.
_HMS_ADMIN_MANAGES = frozenset(
    {
        Role.HMS_ADMIN,
        Role.INSPECTOR,
        Role.ASSEMBLY,
        Role.REVIEWER,
        Role.CUSTOMER_USER,
    }
)
MANAGEABLE_ROLES: dict[Role, frozenset[Role]] = {
    Role.SUPER_ADMIN: frozenset(Role),  # everything, including SUPER_ADMIN
    Role.HMS_ADMIN: _HMS_ADMIN_MANAGES,  # everything except SUPER_ADMIN
    Role.INSPECTOR: frozenset(),
    Role.ASSEMBLY: frozenset(),
    Role.REVIEWER: frozenset(),
    Role.CUSTOMER_USER: frozenset(),
}


def manageable_roles(actor_roles: frozenset[Role]) -> frozenset[Role]:
    result: frozenset[Role] = frozenset()
    for role in actor_roles:
        result |= MANAGEABLE_ROLES.get(role, frozenset())
    return result


def can_manage_role(actor_roles: frozenset[Role], target: Role) -> bool:
    return target in manageable_roles(actor_roles)


def ensure_can_manage_role(actor_roles: frozenset[Role], target: Role) -> None:
    if not can_manage_role(actor_roles, target):
        raise PrivilegeError(f"Not permitted to manage the {target.value} role")


def ensure_can_change_role(
    actor_roles: frozenset[Role], *, current: Role, new: Role
) -> None:
    """A role change requires authority over both the current and the new role."""
    ensure_can_manage_role(actor_roles, current)
    ensure_can_manage_role(actor_roles, new)


def normalise_customer_ids(role: Role, customer_ids: Sequence[str]) -> list[str]:
    """Validate customer scope: exactly one for a Customer User, none otherwise."""
    cleaned = [value.strip() for value in customer_ids if value and value.strip()]
    if role is Role.CUSTOMER_USER:
        if len(set(cleaned)) != 1:
            raise PrivilegeError("A Customer User must have exactly one customer.")
        return [cleaned[0]]
    if cleaned:
        raise PrivilegeError(f"A {role.value} cannot be scoped to a customer.")
    return []


def is_recent_auth(
    auth_time: datetime | int | None,
    *,
    now: datetime,
    max_age_seconds: int,
) -> bool:
    if auth_time is None:
        return False
    if isinstance(auth_time, int):
        auth_time = datetime.fromtimestamp(auth_time, tz=now.tzinfo or UTC)
    if auth_time.tzinfo is None:
        auth_time = auth_time.replace(tzinfo=UTC)
    return now - auth_time <= timedelta(seconds=max_age_seconds)


def ensure_recent_auth(
    auth_time: datetime | int | None,
    *,
    now: datetime,
    max_age_seconds: int,
) -> None:
    if not is_recent_auth(auth_time, now=now, max_age_seconds=max_age_seconds):
        raise PrivilegeError(
            "This action requires a recent sign-in; please re-authenticate."
        )
