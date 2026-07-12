"""User-admin privilege-boundary tests (Task 5, pure rules)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from hms_backend.app.core.rbac import Role
from hms_backend.app.modules.identity.user_admin import (
    PrivilegeError,
    can_manage_role,
    ensure_can_change_role,
    ensure_can_manage_role,
    ensure_recent_auth,
    is_recent_auth,
    manageable_roles,
    normalise_customer_ids,
)

_ALL_ROLES = frozenset(Role)
_NON_SUPER = _ALL_ROLES - {Role.SUPER_ADMIN}


def test_super_admin_manages_every_role_including_super_admin() -> None:
    assert manageable_roles(frozenset({Role.SUPER_ADMIN})) == _ALL_ROLES
    assert can_manage_role(frozenset({Role.SUPER_ADMIN}), Role.SUPER_ADMIN)


def test_hms_admin_manages_all_except_super_admin() -> None:
    managed = manageable_roles(frozenset({Role.HMS_ADMIN}))
    assert managed == _NON_SUPER
    assert not can_manage_role(frozenset({Role.HMS_ADMIN}), Role.SUPER_ADMIN)


@pytest.mark.parametrize(
    "role", [Role.INSPECTOR, Role.ASSEMBLY, Role.REVIEWER, Role.CUSTOMER_USER]
)
def test_non_admin_roles_manage_nobody(role: Role) -> None:
    assert manageable_roles(frozenset({role})) == frozenset()


def test_ensure_can_manage_role_blocks_hms_admin_over_super_admin() -> None:
    with pytest.raises(PrivilegeError):
        ensure_can_manage_role(frozenset({Role.HMS_ADMIN}), Role.SUPER_ADMIN)


def test_role_change_requires_authority_over_both_roles() -> None:
    # HMS_ADMIN cannot elevate an Inspector to Super Admin.
    with pytest.raises(PrivilegeError):
        ensure_can_change_role(
            frozenset({Role.HMS_ADMIN}), current=Role.INSPECTOR, new=Role.SUPER_ADMIN
        )
    # ...but can move them between roles it controls.
    ensure_can_change_role(
        frozenset({Role.HMS_ADMIN}), current=Role.INSPECTOR, new=Role.REVIEWER
    )


def test_customer_user_requires_exactly_one_customer() -> None:
    assert normalise_customer_ids(Role.CUSTOMER_USER, ["c1"]) == ["c1"]
    with pytest.raises(PrivilegeError):
        normalise_customer_ids(Role.CUSTOMER_USER, [])
    with pytest.raises(PrivilegeError):
        normalise_customer_ids(Role.CUSTOMER_USER, ["c1", "c2"])


def test_non_customer_roles_reject_customer_scope() -> None:
    assert normalise_customer_ids(Role.INSPECTOR, []) == []
    assert normalise_customer_ids(Role.HMS_ADMIN, ["  "]) == []
    with pytest.raises(PrivilegeError):
        normalise_customer_ids(Role.REVIEWER, ["c1"])


def test_recent_auth_window() -> None:
    now = datetime(2026, 7, 12, 12, 0, 0, tzinfo=UTC)
    fresh = int((now - timedelta(seconds=100)).timestamp())
    stale = int((now - timedelta(seconds=1000)).timestamp())
    assert is_recent_auth(fresh, now=now, max_age_seconds=300)
    assert not is_recent_auth(stale, now=now, max_age_seconds=300)
    assert not is_recent_auth(None, now=now, max_age_seconds=300)
    ensure_recent_auth(fresh, now=now, max_age_seconds=300)
    with pytest.raises(PrivilegeError):
        ensure_recent_auth(stale, now=now, max_age_seconds=300)
