"""Every route that changes data either reaches the audit ledger or is listed here.

AGENTS.md makes "every mutation produces an AuditEvent" non-negotiable. This is a
static guard: it follows each mutating handler's calls (through the application's own
functions) looking for the audit writers. A new mutating route that reaches none of
them fails until someone either audits it or adds it to ``EXEMPT`` with the reason.
It proves reachability, not that the right event is written; the end-to-end flow
tests prove content.
"""

from __future__ import annotations

import ast
import inspect
import textwrap
from collections.abc import Iterable, Iterator
from types import FunctionType

from fastapi.routing import APIRoute

from hms_backend.app.main import create_app

MODULE_PREFIX = "hms_backend.app"
AUDIT_WRITERS = {"append_audit_event", "record_create", "record_update"}
MAX_DEPTH = 5
MUTATING = {"POST", "PUT", "PATCH", "DELETE"}

# (METHOD, path) -> why no AuditEvent is expected.
EXEMPT: dict[tuple[str, str], str] = {
    ("POST", "/api/v1/auth/browser/logout"): (
        "revokes the caller's own refresh session; sign-in and refresh-reuse events "
        "are audited. Revisit if session revocation must appear in the audit chain."
    ),
    ("POST", "/api/v1/auth/browser/mfa/enrollment"): (
        "stores a pending, unconfirmed authenticator secret; confirming it is audited "
        "as auth.mfa.enrolled."
    ),
    ("POST", "/api/v1/notifications/me/read-all"): (
        "per-user read flags on the user's own notifications, not a business record."
    ),
    ("POST", "/api/v1/notifications/{notification_id}/read"): (
        "per-user read flag on the user's own notification, not a business record."
    ),
    ("PUT", "/api/v1/notifications/preferences"): (
        "the user's own channel preferences; held in notification_preferences. "
        "Revisit if consent changes need an audit trail."
    ),
    ("POST", "/api/v1/notifications/phone/verify/request"): (
        "issues a one-time code for the caller's own phone; the code is not audited."
    ),
    ("POST", "/api/v1/notifications/phone/verify/confirm"): (
        "marks the caller's own phone verified; held on the verification record."
    ),
    ("POST", "/api/v1/notifications/unsubscribe"): (
        "public, signed opt-out of one category; held in notification_preferences. "
        "Revisit if consent changes need an audit trail."
    ),
    ("POST", "/api/v1/notifications/webhooks/{provider}"): (
        "provider delivery receipts (signature or secret verified); updates delivery "
        "status only."
    ),
}


def _routes(routes: Iterable, prefix: str = "") -> Iterator[tuple[str, APIRoute]]:
    """Yield (full path, route), looking inside routers added with include_router."""
    for route in routes:
        if isinstance(route, APIRoute):
            yield prefix + route.path, route
            continue
        original = getattr(route, "original_router", None)
        if original is not None:
            context = getattr(route, "include_context", None)
            yield from _routes(original.routes, prefix + getattr(context, "prefix", ""))
        elif getattr(route, "routes", None):
            yield from _routes(route.routes, prefix)


def _mutating_handlers() -> dict[tuple[str, str], FunctionType]:
    found: dict[tuple[str, str], FunctionType] = {}
    for path, route in _routes(create_app().routes):
        for method in sorted(route.methods & MUTATING):
            found[(method, path)] = route.endpoint
    return found


def _called_names(function: FunctionType) -> set[str]:
    try:
        tree = ast.parse(textwrap.dedent(inspect.getsource(function)))
    except (OSError, TypeError, SyntaxError):
        return set()
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, ast.Attribute):
            names.add(node.attr)
    return names


def reaches_audit(function: FunctionType, seen: set[object], depth: int = 0) -> bool:
    if depth > MAX_DEPTH or function in seen:
        return False
    seen.add(function)
    names = _called_names(function)
    if names & AUDIT_WRITERS:
        return True
    module = inspect.getmodule(function)
    scope = dict(vars(module)) if module else {}
    candidates: list[FunctionType] = []
    for name in names:
        target = scope.get(name)
        if isinstance(target, FunctionType):
            candidates.append(target)
    # ``_service.login(...)``: look in the classes of module-level objects.
    for value in scope.values():
        owner = type(value)
        if owner.__module__.startswith(MODULE_PREFIX) and not isinstance(
            value, (FunctionType, type)
        ):
            candidates.extend(
                member
                for name, member in vars(owner).items()
                if name in names and isinstance(member, FunctionType)
            )
    # ``PasswordResetService().confirm(...)``: classes the module imports.
    for name in names:
        built = scope.get(name)
        if isinstance(built, type) and built.__module__.startswith(MODULE_PREFIX):
            candidates.extend(
                member
                for member_name, member in vars(built).items()
                if member_name in names and isinstance(member, FunctionType)
            )
    # ``self.helper(...)`` inside a method: the method's own class.
    qualname = function.__qualname__
    owner_name = qualname.split(".")[0] if "." in qualname else ""
    own_class = scope.get(owner_name)
    if isinstance(own_class, type):
        candidates.extend(
            member
            for name, member in vars(own_class).items()
            if name in names and isinstance(member, FunctionType)
        )
    return any(
        reaches_audit(target, seen, depth + 1)
        for target in candidates
        if target.__module__.startswith(MODULE_PREFIX)
    )


def test_every_mutating_route_reaches_the_audit_ledger_or_is_exempt() -> None:
    handlers = _mutating_handlers()
    assert handlers, "no mutating routes found: the guard is not looking at the app"
    unaudited = sorted(
        key
        for key, handler in handlers.items()
        if key not in EXEMPT and not reaches_audit(handler, set())
    )
    assert not unaudited, (
        "These routes change data but never reach append_audit_event/record_create/"
        "record_update. Audit them, or add them to EXEMPT with a reason:\n"
        + "\n".join(f"  {method} {path}" for method, path in unaudited)
    )


def test_exemptions_name_real_routes_and_say_why() -> None:
    handlers = _mutating_handlers()
    stale = sorted(key for key in EXEMPT if key not in handlers)
    assert not stale, f"EXEMPT lists routes that no longer exist: {stale}"
    assert all(reason.strip() for reason in EXEMPT.values())
    for key, reason in EXEMPT.items():
        assert not reaches_audit(handlers[key], set()), (
            f"{key} is audited now; remove it from EXEMPT ({reason})"
        )
