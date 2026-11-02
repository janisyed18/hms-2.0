"""Every mutating route reaches the AuditEvent writer and, where required, SyncChange.

AGENTS.md: "Every mutation must produce an AuditEvent and SyncChange", with the
exception model written under "Audit and sync" there. This is a static guard. It
follows each mutating handler's calls through the application's own functions and
records the call chain to the writers:

* AuditEvent writers: ``append_audit_event``, and ``record_create`` /
  ``record_update`` / ``soft_delete`` (which call it).
* SyncChange writers: ``stage_sync_change``, and the same three helpers (which call
  it).

Rules, in order:

1. Audit: every mutating route reaches an AuditEvent writer, except the few in
   ``AUDIT_EXEMPT``, each with a reason, each named in AGENTS.md, and the set capped at
   ``MAX_AUDIT_EXEMPT``. Adding one means changing the policy text and the cap.
2. Sync: SyncChange is required for the offline sync catalogue (``SYNC_MODELS``). Routes
   in ``SERVER_ONLY_MODULES`` mutate server-only data (identity, devices, notification
   state, jobs) and need none; every other route must reach a SyncChange writer.

It proves reachability, not that the right event is written; the flow tests prove that.
"""

from __future__ import annotations

import ast
import inspect
import re
import textwrap
from collections import deque
from collections.abc import Iterable, Iterator
from pathlib import Path
from types import FunctionType
from typing import Any, cast

from fastapi.routing import APIRoute

from hms_backend.app.main import create_app

MODULE_PREFIX = "hms_backend.app"
MUTATING = {"POST", "PUT", "PATCH", "DELETE"}
MAX_DEPTH = 6
STORE_HELPERS = {"record_create", "record_update", "soft_delete"}
AUDIT_WRITERS = {"append_audit_event"} | STORE_HELPERS
SYNC_WRITERS = {"stage_sync_change"} | STORE_HELPERS

# Handlers in these modules change server-only data, which devices never receive.
SERVER_ONLY_MODULES = {
    "hms_backend.app.api.auth",
    "hms_backend.app.api.browser_auth",
    "hms_backend.app.api.admin",
    "hms_backend.app.api.notifications",
    "hms_backend.app.api.jobs",
}

# (METHOD, path) -> why no AuditEvent is written. Each must be named in AGENTS.md.
AUDIT_EXEMPT: dict[tuple[str, str], str] = {
    ("POST", "/api/v1/notifications/me/read-all"): (
        "per-user read flags on the user's own notifications; UI state, not consent "
        "and not a business record"
    ),
    ("POST", "/api/v1/notifications/{notification_id}/read"): (
        "per-user read flag on the user's own notification; UI state, not consent "
        "and not a business record"
    ),
    ("POST", "/api/v1/notifications/webhooks/{provider}"): (
        "provider delivery receipts (signature or secret verified); they update "
        "delivery status on the notification log itself"
    ),
}
MAX_AUDIT_EXEMPT = 3

AGENTS_MD = Path(__file__).resolve().parents[2] / "AGENTS.md"


def _routes(routes: Iterable[Any], prefix: str = "") -> Iterator[tuple[str, APIRoute]]:
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


def mutating_handlers() -> dict[tuple[str, str], FunctionType]:
    found: dict[tuple[str, str], FunctionType] = {}
    for path, route in _routes(create_app().routes):
        for method in sorted((route.methods or set()) & MUTATING):
            found[(method, path)] = cast(FunctionType, route.endpoint)
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


def _callees(function: FunctionType, names: set[str]) -> list[FunctionType]:
    module = inspect.getmodule(function)
    scope = dict(vars(module)) if module else {}
    found: list[FunctionType] = []

    def members(owner: type) -> None:
        found.extend(
            member
            for name, member in vars(owner).items()
            if name in names and isinstance(member, FunctionType)
        )

    for name in names:
        target = scope.get(name)
        if isinstance(target, FunctionType):
            found.append(target)
        elif isinstance(target, type) and target.__module__.startswith(MODULE_PREFIX):
            members(target)  # ``Service().method(...)``
    for value in scope.values():  # ``_service.method(...)``
        owner = type(value)
        if owner.__module__.startswith(MODULE_PREFIX) and not isinstance(
            value, (FunctionType, type)
        ):
            members(owner)
    qualname = function.__qualname__
    own_class = scope.get(qualname.split(".")[0]) if "." in qualname else None
    if isinstance(own_class, type):
        members(own_class)  # ``self.helper(...)``
    return [f for f in found if f.__module__.startswith(MODULE_PREFIX)]


def writer_path(handler: FunctionType, writers: set[str]) -> list[str] | None:
    """The shortest call chain from the handler to one of ``writers``, or None."""
    start = (handler, [handler.__name__])
    queue: deque[tuple[FunctionType, list[str]]] = deque([start])
    seen: set[FunctionType] = {handler}
    while queue:
        function, chain = queue.popleft()
        names = _called_names(function)
        hit = sorted(names & writers)
        if hit:
            return [*chain, hit[0]]
        if len(chain) > MAX_DEPTH:
            continue
        for callee in _callees(function, names):
            if callee not in seen:
                seen.add(callee)
                queue.append((callee, [*chain, callee.__name__]))
    return None


def matrix() -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for (method, path), handler in sorted(
        mutating_handlers().items(), key=lambda item: (item[0][1], item[0][0])
    ):
        audit = writer_path(handler, AUDIT_WRITERS)
        sync = writer_path(handler, SYNC_WRITERS)
        rows.append(
            {
                "route": f"{method} {path}",
                "module": handler.__module__,
                "audit": audit,
                "sync": sync,
                "audit_exempt": AUDIT_EXEMPT.get((method, path)),
            }
        )
    return rows


def test_every_mutating_route_writes_an_audit_event_or_is_a_listed_exemption() -> None:
    rows = matrix()
    assert rows, "no mutating routes found: the guard is not looking at the app"
    missing = [
        r["route"] for r in rows if r["audit"] is None and r["audit_exempt"] is None
    ]
    assert not missing, (
        "These routes change data but never reach an AuditEvent writer. Audit them; an "
        "exemption needs a reason, a line in AGENTS.md and a higher cap:\n"
        + "\n".join(f"  {route}" for route in missing)
    )


def test_every_route_outside_the_server_only_modules_writes_a_sync_change() -> None:
    missing = [
        r["route"]
        for r in matrix()
        if r["sync"] is None and r["module"] not in SERVER_ONLY_MODULES
    ]
    assert not missing, (
        "These routes mutate offline-synced data (outside the server-only modules) "
        "but never reach a SyncChange writer:\n" + "\n".join(f"  {m}" for m in missing)
    )


def test_the_audit_exemption_list_is_small_real_and_written_down() -> None:
    handlers = mutating_handlers()
    assert len(AUDIT_EXEMPT) <= MAX_AUDIT_EXEMPT
    stale = [key for key in AUDIT_EXEMPT if key not in handlers]
    assert not stale, f"exempt routes that no longer exist: {stale}"
    for key, reason in AUDIT_EXEMPT.items():
        assert reason.strip()
        assert writer_path(handlers[key], AUDIT_WRITERS) is None, (
            f"{key} writes an AuditEvent now; remove it from AUDIT_EXEMPT"
        )
    policy = AGENTS_MD.read_text(encoding="utf-8")
    section = re.search(r"## Audit and sync.*?(?=\n## |\Z)", policy, re.S)
    assert section, "AGENTS.md needs an 'Audit and sync' section"
    for _, path in AUDIT_EXEMPT:
        assert path in section.group(0), f"{path} is not named in AGENTS.md"


def test_server_only_modules_are_not_where_the_sync_catalogue_is_written() -> None:
    """The catalogue entities are written by the records and sync routers."""
    from hms_backend.app.api.sync_bootstrap import SYNC_MODELS

    assert SYNC_MODELS, "the sync catalogue is empty"
    for module in SERVER_ONLY_MODULES:
        source = inspect.getsource(__import__(module, fromlist=["x"]))
        written = re.findall(r"session\.add\(\s*(\w+)\(", source)
        assert not (set(written) & set(SYNC_MODELS)), (
            f"{module} creates catalogue entities {set(written) & set(SYNC_MODELS)}; "
            "they belong in a router that writes SyncChange"
        )
