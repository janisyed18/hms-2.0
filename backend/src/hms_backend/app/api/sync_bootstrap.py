"""Paged, resumable sync bootstrap.

The bootstrap hands an offline client the records it may see. It used to read every row
of every synced table and check visibility row by row, which costs queries proportional
to the table size and answers in one unbounded response. This module replaces that with
keyset pages whose scope is pushed down into SQL.

Protocol version 2
------------------
* The client sends ``X-HMS-Sync-Protocol: 2`` (the Inspector app does, from app version
  0.2.0). The header, not a query parameter, is the capability signal, so an old
  deployed client that knows nothing about paging is recognised and handled by
  ``_legacy_bootstrap`` in ``sync.py``.
* A page holds at most ``limit`` items (records plus work contexts together): default
  :data:`DEFAULT_PAGE_SIZE`, hard maximum :data:`MAX_PAGE_SIZE`.
* The traversal is a fixed sequence of sections: each synced entity in
  ``BOOTSTRAP_ENTITY_ORDER`` ordered by ``id``, then the inspector work contexts ordered
  by ``(appointment_id, assignment_id)``. A position is ``(section, last key)`` and the
  next page resumes strictly after it, so the order is deterministic and nothing is
  repeated or skipped.
* Page one pins the snapshot watermark ``S = max(SyncChange.seq)`` *before* reading any
  data. Every later page carries ``S`` unchanged. After the last page the client asks
  ``/sync/changes?since=S``: a change committed after ``S`` is either already in the
  pages it read (harmless, applied again idempotently) or in that feed, so none is lost.
* Visibility that does not come from a row's own change (an inspector being assigned or
  unassigned) is not in the change feed, so the token also carries a fingerprint of the
  caller's scope taken before any data is read. The last page recomputes it; if it
  differs, ``scope_changed`` tells the client to discard the partial result and start
  again.

Continuation token
------------------
A stateless, HMAC-signed value: ``base64url(json).base64url(hmac)``. It binds the token
version, protocol, ``S``, position, the user, the device, the scope fingerprint and the
issue time. It is *not* authorisation: every request re-runs the device and principal
checks and applies the caller's *current* scope in SQL, so a token only says where to
resume. The key is derived from the existing ``AUTH_BEARER_HMAC_SECRET`` with a
domain-separation label, so no new secret is introduced.

Old-client compatibility (temporary)
------------------------------------
A client that does not send the protocol header gets the single-response shape, but only
while everything it may see fits in :data:`LEGACY_BOOTSTRAP_MAX_ROWS` items. It is read
with the same scoped, keyset queries (never a table scan), materialising at most that
many items plus one. A larger dataset is answered ``426 Upgrade Required``; the response
is never a truncated success. Removal condition: delete the legacy branch once no
registered device reports an app version below 0.2.0 (``devices.app_version``) and the
Inspector release carrying the paged client has been live for one offline window
(``Device.offline_window_days``, 7 days).
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any

from sqlalchemy import ColumnElement, Select, func, literal, select, tuple_
from sqlalchemy.dialects.postgresql import aggregate_order_by
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import lazyload, selectinload
from sqlalchemy.orm.interfaces import ORMOption

from hms_backend.app.core.config import settings
from hms_backend.app.core.inspector_access import (
    assigned_assets,
    assigned_bookings,
    is_inspector_scoped,
)
from hms_backend.app.core.rbac import Principal, is_customer_scoped
from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.certificates.models import Certificate
from hms_backend.app.modules.customers.models import (
    Customer,
    CustomerContact,
    CustomerLocation,
)
from hms_backend.app.modules.inspections.models import (
    Inspection,
    InspectionAppointment,
    InspectionAppointmentRevision,
    InspectionBooking,
    InspectionBookingAsset,
    PressureTestResult,
)
from hms_backend.app.modules.products.models import Product, ProductPressureRating
from hms_backend.app.modules.reference.models import (
    AttachMethod,
    Coupling,
    CouplingAddOn,
    Material,
    NominalBore,
    Standard,
)
from hms_backend.app.modules.scheduling.models import RetestSchedule

# Capabilities, not one number. Paging (2) is what page tokens are bound to; the native
# inspection lifecycle (3) is a separate capability a client opts into with its header,
# so adding it never invalidates a protocol-2 client's paging or its tokens.
PAGING_PROTOCOL_VERSION = 2
LIFECYCLE_PROTOCOL_VERSION = 3
CURRENT_SYNC_PROTOCOL_VERSION = 3
# The version a page token carries: the paging format, shared by protocols 2 and 3.
PROTOCOL_VERSION = PAGING_PROTOCOL_VERSION
DEFAULT_PAGE_SIZE = 200
MAX_PAGE_SIZE = 500
# Temporary: see the module docstring for the removal condition.
LEGACY_BOOTSTRAP_MAX_ROWS = 2_000

TOKEN_VERSION = 1
TOKEN_MAX_AGE_SECONDS = 6 * 60 * 60
_TOKEN_LABEL = b"hms-sync-bootstrap-page-token-v1"
_CLOCK_SKEW_SECONDS = 60

SYNC_MODELS: dict[str, type[Any]] = {
    "AttachMethod": AttachMethod,
    "Coupling": Coupling,
    "CouplingAddOn": CouplingAddOn,
    "Material": Material,
    "NominalBore": NominalBore,
    "Standard": Standard,
    "Product": Product,
    "ProductPressureRating": ProductPressureRating,
    "Customer": Customer,
    "CustomerLocation": CustomerLocation,
    "CustomerContact": CustomerContact,
    "Asset": Asset,
    "RetestSchedule": RetestSchedule,
    "Inspection": Inspection,
    "PressureTestResult": PressureTestResult,
    "Certificate": Certificate,
}

BOOTSTRAP_ENTITY_ORDER = [
    "AttachMethod",
    "Coupling",
    "CouplingAddOn",
    "Material",
    "NominalBore",
    "Standard",
    "Product",
    "ProductPressureRating",
    "Customer",
    "CustomerLocation",
    "CustomerContact",
    "Asset",
    "RetestSchedule",
    "Inspection",
    "PressureTestResult",
    "Certificate",
]

UNSCOPED_ENTITIES = {
    "AttachMethod",
    "Coupling",
    "CouplingAddOn",
    "Material",
    "NominalBore",
    "Standard",
    "Product",
    "ProductPressureRating",
}

# The sections after the entities: the inspector work contexts.
WORK_CONTEXT_SECTION = len(BOOTSTRAP_ENTITY_ORDER)
SECTION_COUNT = WORK_CONTEXT_SECTION + 1

Key = tuple[str, ...]
ContextRow = tuple[str, str, str, str, str]


class PageTokenError(ValueError):
    """The continuation token cannot be trusted or does not apply to this caller."""


class PagingUnavailableError(RuntimeError):
    """No signing key is configured, so continuation tokens cannot be issued."""


@dataclass(frozen=True)
class PageToken:
    snapshot: int
    section: int
    key: Key | None
    user_id: str
    device_id: str
    fingerprint: str
    issued_at: int


@dataclass(frozen=True)
class BootstrapPage:
    rows: list[tuple[str, Any]]
    contexts: list[ContextRow]
    # Where the next page resumes; None when this page was the last.
    next_position: tuple[int, Key | None] | None


# --- continuation token ---------------------------------------------------------------

_EPHEMERAL_KEY = secrets.token_bytes(32)


def _signing_key() -> bytes:
    secret = settings.auth_bearer_hmac_secret
    if secret:
        return hmac.new(secret.encode(), _TOKEN_LABEL, hashlib.sha256).digest()
    if settings.is_local_or_test:
        # Local runs without a configured secret: a per-process key is enough, since
        # nothing outlives the process.
        return _EPHEMERAL_KEY
    raise PagingUnavailableError("AUTH_BEARER_HMAC_SECRET is not configured")


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def _unb64(value: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (binascii.Error, ValueError) as exc:
        raise PageTokenError("Malformed page token") from exc


def encode_page_token(token: PageToken) -> str:
    body = json.dumps(
        {
            "v": TOKEN_VERSION,
            "pv": PROTOCOL_VERSION,
            "s": token.snapshot,
            "i": token.section,
            "k": None if token.key is None else list(token.key),
            "u": token.user_id,
            "d": token.device_id,
            "f": token.fingerprint,
            "t": token.issued_at,
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    signature = hmac.new(_signing_key(), body, hashlib.sha256).digest()
    return f"{_b64(body)}.{_b64(signature)}"


def _whole(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise PageTokenError("Malformed page token")
    return value


def decode_page_token(
    raw: str, *, user_id: str, device_id: str, now: float | None = None
) -> PageToken:
    """Verify ``raw`` and that it was issued to this user and device."""
    encoded_body, separator, encoded_signature = raw.partition(".")
    if not separator or not encoded_body or not encoded_signature:
        raise PageTokenError("Malformed page token")
    body = _unb64(encoded_body)
    expected = hmac.new(_signing_key(), body, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, _unb64(encoded_signature)):
        raise PageTokenError("Page token signature is invalid")
    try:
        data = json.loads(body)
    except ValueError as exc:
        raise PageTokenError("Malformed page token") from exc
    if not isinstance(data, dict):
        raise PageTokenError("Malformed page token")
    if data.get("v") != TOKEN_VERSION or data.get("pv") != PROTOCOL_VERSION:
        raise PageTokenError("Unsupported page token version")

    snapshot = _whole(data.get("s"))
    section = _whole(data.get("i"))
    issued_at = _whole(data.get("t"))
    if snapshot < 0 or not 0 <= section < SECTION_COUNT:
        raise PageTokenError("Page token position is invalid")
    raw_key = data.get("k")
    key: Key | None
    if raw_key is None:
        key = None
    else:
        width = 2 if section == WORK_CONTEXT_SECTION else 1
        if (
            not isinstance(raw_key, list)
            or len(raw_key) != width
            or not all(isinstance(part, str) and part for part in raw_key)
        ):
            raise PageTokenError("Page token position is invalid")
        key = tuple(raw_key)
    fingerprint, token_user, token_device = data.get("f"), data.get("u"), data.get("d")
    if not (
        isinstance(fingerprint, str)
        and isinstance(token_user, str)
        and isinstance(token_device, str)
    ):
        raise PageTokenError("Malformed page token")
    if token_user != user_id or token_device != device_id:
        raise PageTokenError("Page token was issued to a different user or device")
    current = time.time() if now is None else now
    if issued_at > current + _CLOCK_SKEW_SECONDS:
        raise PageTokenError("Page token is from the future")
    if current - issued_at > TOKEN_MAX_AGE_SECONDS:
        raise PageTokenError("Page token has expired")
    return PageToken(
        snapshot=snapshot,
        section=section,
        key=key,
        user_id=token_user,
        device_id=token_device,
        fingerprint=fingerprint,
        issued_at=issued_at,
    )


# --- scope, pushed down into SQL ------------------------------------------------------


def _inspector_inspection_ids(principal: Principal) -> Select[tuple[str]]:
    return select(Inspection.id).where(
        Inspection.booking_id.in_(assigned_bookings(principal)),
        Inspection.asset_id.in_(assigned_assets(principal)),
    )


def _customer_asset_ids(customer_ids: frozenset[str]) -> Select[tuple[str]]:
    return select(Asset.id).where(Asset.customer_id.in_(customer_ids))


def scope_clauses(
    principal: Principal, entity_name: str
) -> list[ColumnElement[bool]] | None:
    """SQL conditions that make a row visible to ``principal``.

    ``[]`` means every row; ``None`` means the entity is never visible to them. This is
    the set-based equivalent of the per-row check ``/sync/changes`` still applies to the
    handful of rows in a change page.
    """
    if entity_name in UNSCOPED_ENTITIES:
        return []
    model = SYNC_MODELS[entity_name]
    if is_inspector_scoped(principal):
        if entity_name == "Asset":
            return [model.id.in_(assigned_assets(principal))]
        if entity_name == "Customer":
            return [
                model.id.in_(
                    select(InspectionBooking.customer_id).where(
                        InspectionBooking.id.in_(assigned_bookings(principal))
                    )
                )
            ]
        if entity_name == "CustomerLocation":
            return [
                model.id.in_(
                    select(InspectionBooking.location_id).where(
                        InspectionBooking.id.in_(assigned_bookings(principal))
                    )
                )
            ]
        if entity_name == "RetestSchedule":
            return [model.asset_id.in_(assigned_assets(principal))]
        if entity_name == "Inspection":
            return [
                model.booking_id.in_(assigned_bookings(principal)),
                model.asset_id.in_(assigned_assets(principal)),
            ]
        if entity_name == "PressureTestResult":
            return [model.inspection_id.in_(_inspector_inspection_ids(principal))]
        return None
    if not is_customer_scoped(principal):
        return []
    customers = principal.customer_ids
    if entity_name == "Customer":
        return [model.id.in_(customers)]
    if entity_name in {
        "CustomerLocation",
        "CustomerContact",
        "Asset",
        "RetestSchedule",
    }:
        return [model.customer_id.in_(customers)]
    if entity_name == "Inspection":
        return [model.asset_id.in_(_customer_asset_ids(customers))]
    if entity_name == "PressureTestResult":
        return [
            model.inspection_id.in_(
                select(Inspection.id).where(
                    Inspection.asset_id.in_(_customer_asset_ids(customers))
                )
            )
        ]
    if entity_name == "Certificate":
        return [model.asset_id.in_(_customer_asset_ids(customers))]
    return None


def work_context_select(principal: Principal) -> Select[ContextRow]:
    """The inspector's current work contexts, in a stable order."""
    return (
        select(
            InspectionAppointment.id,
            InspectionAppointment.booking_id,
            InspectionAppointmentRevision.id,
            InspectionBookingAsset.id,
            InspectionBookingAsset.asset_id,
        )
        .join(
            InspectionAppointmentRevision,
            InspectionAppointmentRevision.appointment_id == InspectionAppointment.id,
        )
        .join(
            InspectionBookingAsset,
            InspectionBookingAsset.booking_id == InspectionAppointment.booking_id,
        )
        .where(
            InspectionAppointment.booking_id.in_(assigned_bookings(principal)),
            InspectionAppointmentRevision.revision_number
            == InspectionAppointment.current_revision_number,
            InspectionAppointmentRevision.inspector_user_id
            == principal.assignment_user_id,
            InspectionAppointmentRevision.deleted_at.is_(None),
            InspectionBookingAsset.deleted_at.is_(None),
        )
        .order_by(InspectionAppointment.id, InspectionBookingAsset.id)
    )


def _load_options(entity_name: str) -> list[ORMOption]:
    """Load only the row, plus what an asset's payload needs.

    Most models eager-load their relationships ("selectin"), and those chain: a
    customer pulls in all of its assets, each of which pulls in its ends, inspections
    and certificates. A page of 200 rows would drag a customer's whole portfolio into
    memory. The payload is the row's own columns, except an asset's pressure rating,
    which reads its ends and its product's ratings; those are loaded for the page's
    assets only.
    """
    options: list[ORMOption] = [lazyload("*")]
    if entity_name == "Asset":
        options += [
            selectinload(Asset.ends).lazyload("*"),
            selectinload(Asset.product).options(
                lazyload("*"),
                selectinload(Product.pressure_ratings).lazyload("*"),
            ),
        ]
    return options


async def _entity_rows(
    session: AsyncSession,
    principal: Principal,
    entity_name: str,
    after: Key | None,
    count: int,
) -> list[Any]:
    clauses = scope_clauses(principal, entity_name)
    if clauses is None:
        return []
    model = SYNC_MODELS[entity_name]
    statement = (
        select(model)
        .where(model.deleted_at.is_(None), *clauses)
        .options(*_load_options(entity_name))
    )
    if after is not None:
        statement = statement.where(model.id > after[0])
    return list(
        (await session.scalars(statement.order_by(model.id).limit(count))).all()
    )


async def _context_rows(
    session: AsyncSession,
    principal: Principal,
    after: Key | None,
    count: int,
) -> list[ContextRow]:
    if not is_inspector_scoped(principal):
        return []
    statement = work_context_select(principal)
    if after is not None:
        statement = statement.where(
            tuple_(InspectionAppointment.id, InspectionBookingAsset.id)
            > tuple_(*(literal(part) for part in after))
        )
    result = await session.execute(statement.limit(count))
    return [(a, b, r, i, s) for a, b, r, i, s in result.all()]


async def read_page(
    session: AsyncSession,
    principal: Principal,
    *,
    section: int,
    after: Key | None,
    budget: int,
) -> BootstrapPage:
    """Read up to ``budget`` items starting strictly after ``(section, after)``.

    Each section is asked for one row more than the space left, so the page knows
    whether anything follows without a separate count; once the page is full the
    remaining sections are probed with a single row each.
    """
    rows: list[tuple[str, Any]] = []
    contexts: list[ContextRow] = []
    position: tuple[int, Key | None] = (section, after)
    remaining = budget
    for index in range(section, SECTION_COUNT):
        resume = after if index == section else None
        if index == WORK_CONTEXT_SECTION:
            fetched_contexts = await _context_rows(
                session, principal, resume, remaining + 1
            )
            taken_contexts = fetched_contexts[:remaining]
            contexts.extend(taken_contexts)
            if taken_contexts:
                last = taken_contexts[-1]
                position = (index, (last[0], last[3]))
            more = len(fetched_contexts) > len(taken_contexts)
            remaining -= len(taken_contexts)
        else:
            name = BOOTSTRAP_ENTITY_ORDER[index]
            fetched = await _entity_rows(
                session, principal, name, resume, remaining + 1
            )
            taken = fetched[:remaining]
            rows.extend((name, row) for row in taken)
            if taken:
                position = (index, (taken[-1].id,))
            more = len(fetched) > len(taken)
            remaining -= len(taken)
        if more:
            return BootstrapPage(rows, contexts, position)
    return BootstrapPage(rows, contexts, None)


# --- scope fingerprint ----------------------------------------------------------------


async def _digest(session: AsyncSession, statement: Select[tuple[str]]) -> str:
    """Digest of the sorted values of a one-column text query, without loading rows."""
    values = statement.subquery()
    value = values.c[0]
    if session.get_bind().dialect.name == "postgresql":
        joined = await session.scalar(
            select(func.string_agg(value, aggregate_order_by(literal(","), value)))
        )
    else:
        # SQLite (tests, local development) has no ordered aggregate; sort first.
        ordered = select(value).order_by(value).subquery()
        joined = await session.scalar(select(func.group_concat(ordered.c[0], ",")))
    return hashlib.sha256((joined or "").encode()).hexdigest()


def _text(*columns: Any) -> ColumnElement[str]:
    expression: ColumnElement[str] = literal("")
    for column in columns:
        expression = expression + literal(":") + func.coalesce(column, "")
    return expression


async def scope_fingerprint(session: AsyncSession, principal: Principal) -> str:
    """A digest of everything that decides what ``principal`` may see.

    Changes to an inspector's assignments do not appear in the change feed, so the
    bootstrap compares this value before and after its pages instead.
    """
    if is_inspector_scoped(principal):
        contexts = work_context_select(principal).subquery()
        parts = [
            await _digest(
                session,
                select(
                    _text(
                        InspectionBooking.id,
                        InspectionBooking.customer_id,
                        InspectionBooking.location_id,
                    )
                ).where(InspectionBooking.id.in_(assigned_bookings(principal))),
            ),
            await _digest(session, assigned_assets(principal)),
            await _digest(
                session,
                select(_text(*(contexts.c[index] for index in range(5)))),
            ),
        ]
        return hashlib.sha256("|".join(parts).encode()).hexdigest()[:32]
    if is_customer_scoped(principal):
        joined = ",".join(sorted(principal.customer_ids))
        return hashlib.sha256(joined.encode()).hexdigest()[:32]
    return "unscoped"
