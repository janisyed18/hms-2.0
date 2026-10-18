"""The one place that decides which network address a request came from.

Behind CloudFront and the ALB the socket peer is the load balancer, shared by every
user, so it cannot identify a client. The forwarding header can, but only part of it:

    viewer -> CloudFront -> ALB -> API
    X-Forwarded-For seen by the API:
        "<anything the viewer sent>, <viewer IP>, <CloudFront IP>"

CloudFront appends the address it saw as the viewer, then the ALB (default ``append``
mode) appends CloudFront's address. Everything to the *left* of those two entries is
attacker-controlled, so the leading value must never be used. The viewer address is
the entry ``SECURITY_TRUSTED_PROXY_HOPS`` positions from the right (2 in this
deployment: CloudFront and the ALB).

Forwarded values are trusted only when the request proves it arrived through our
edge by presenting the shared edge secret (the same secret ``EdgeOriginMiddleware``
enforces). Otherwise, or on any malformed input, the socket peer is used, so a forged
header can only ever make the result *less* specific, never attacker-chosen.
"""

from __future__ import annotations

import hmac
import ipaddress
from collections.abc import Iterable

from starlette.requests import Request
from starlette.types import Scope

from hms_backend.app.core.config import settings

EDGE_SECRET_HEADER = "x-hms-edge-secret"
FORWARDED_FOR_HEADER = "x-forwarded-for"
UNKNOWN_KEY = "unknown"
# 45 is the longest textual IPv6 address (IPv4-mapped); anything longer is not one.
_MAX_ADDRESS_LENGTH = 64


def normalize_ip(raw: str | None) -> str | None:
    """Return the canonical text of an IPv4/IPv6 address, or None if it is not one.

    Accepts a bare address, ``a.b.c.d:port`` and ``[v6]``/``[v6]:port``. IPv4-mapped
    IPv6 addresses collapse to IPv4 so one client has one identity.
    """
    if raw is None:
        return None
    value = raw.strip()
    if not value or len(value) > _MAX_ADDRESS_LENGTH:
        return None
    if value.startswith("["):
        end = value.find("]")
        if end == -1:
            return None
        remainder = value[end + 1 :]
        if remainder and not (remainder.startswith(":") and remainder[1:].isdigit()):
            return None
        value = value[1:end]
    elif value.count(":") == 1:
        host, _, port = value.partition(":")
        if not port.isdigit():
            return None
        value = host
    if "%" in value:  # IPv6 zone identifiers are never a client identity
        return None
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return address.compressed


def rate_limit_key(address: str | None) -> str:
    """Key for per-client throttling.

    IPv4 is keyed by address. IPv6 is keyed by its /64, because one subscriber
    routinely controls an entire /64 and could otherwise rotate addresses to evade
    the limit.
    """
    normalized = normalize_ip(address)
    if normalized is None:
        return UNKNOWN_KEY
    parsed = ipaddress.ip_address(normalized)
    if isinstance(parsed, ipaddress.IPv6Address):
        return str(ipaddress.ip_network(f"{normalized}/64", strict=False))
    return normalized


def edge_authenticated(presented_secret: str | None) -> bool:
    expected = settings.security_edge_shared_secret
    if not expected or presented_secret is None:
        return False
    return hmac.compare_digest(presented_secret.encode(), expected.encode())


def resolve_client_address(
    *,
    peer: str | None,
    forwarded_for: Iterable[str],
    edge_secret: str | None,
) -> str | None:
    """Resolve the client address; see the module docstring for the trust model."""
    hops = settings.security_trusted_proxy_hops
    if hops > 0 and edge_authenticated(edge_secret):
        # Several header lines are equivalent to one comma-joined line (RFC 9110).
        entries = [part.strip() for line in forwarded_for for part in line.split(",")]
        if len(entries) >= hops:
            candidate = normalize_ip(entries[-hops])
            if candidate is not None:
                return candidate
        # Fewer entries than expected hops, or a malformed one: the request did not
        # have the chain we trust. Fall back to the peer rather than guess.
    return normalize_ip(peer)


def client_address(request: Request) -> str | None:
    return resolve_client_address(
        peer=request.client.host if request.client else None,
        forwarded_for=request.headers.getlist(FORWARDED_FOR_HEADER),
        edge_secret=request.headers.get(EDGE_SECRET_HEADER),
    )


def client_address_from_scope(scope: Scope) -> str | None:
    """Same resolution for raw ASGI scopes (middleware runs before ``Request``)."""
    forwarded: list[str] = []
    edge_secret: str | None = None
    for key, value in scope["headers"]:
        name = key.decode("latin-1").lower()
        if name == FORWARDED_FOR_HEADER:
            forwarded.append(value.decode("latin-1"))
        elif name == EDGE_SECRET_HEADER:
            edge_secret = value.decode("latin-1")
    client = scope.get("client")
    return resolve_client_address(
        peer=client[0] if client else None,
        forwarded_for=forwarded,
        edge_secret=edge_secret,
    )
