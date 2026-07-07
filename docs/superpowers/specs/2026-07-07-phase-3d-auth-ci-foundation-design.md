# Phase 3D Auth and CI Foundation Design

## Goal

Phase 3D establishes a production-ready foundation for authentication boundaries, role-aware staff UI access, and CI validation without attempting full external OIDC/JWKS integration yet.

## Auth Boundary

The backend supports two explicit modes:

- `dev`: local development mode. HMS identity headers are accepted and resolved against persisted `users` records. Header-provided roles are allowed only as a local fallback when configured.
- `bearer`: deployment mode. HMS dev headers are ignored. Requests must provide an `Authorization: Bearer <token>` header. The first adapter validates HS256 JWTs with configured secret, issuer, audience, and time claims, then resolves the token subject against persisted HMS users.

This isolates local test convenience from deployment behavior. Later OIDC integration can replace or extend the bearer adapter without changing API route authorization.

## Staff UI Authorization

The staff UI derives visible modules from the resolved staff session permissions. Admin-only modules such as Users & Roles, Devices, and Audit Log are hidden from roles that lack the corresponding backend permissions. The UI still falls back to a mock admin session when the backend is unavailable so demos remain usable.

## CI Foundation

CI validates backend lint/type/tests, staff web tests/build, inspector web tests/build, certificate-service lint/type/tests, and Docker Compose build. This catches most integration breakages before a branch is merged.

## Out of Scope

External OIDC discovery, JWKS key rotation, Terraform/Helm deployment, and artifact scanning remain later production-readiness tasks.
