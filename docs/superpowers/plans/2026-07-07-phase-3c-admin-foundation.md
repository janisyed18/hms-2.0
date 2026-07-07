# Phase 3C Admin Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace role-only header trust with database-backed identity resolution and connect audit, user, and device administration to real backend persistence.

**Architecture:** Add a dedicated admin API router under `/api/v1/admin/*` while keeping existing core-record APIs intact. Resolve the current principal from persisted `users` rows, then use existing RBAC permissions and audit-chain infrastructure for admin operations. The staff React app keeps mock fallback behavior but uses the new admin APIs when the backend is available.

**Tech Stack:** FastAPI, SQLAlchemy async ORM, Alembic, pytest/httpx, React/Vite, Vitest/Testing Library.

---

### Task 1: Database-Backed Principal Resolution

**Files:**
- Modify: `backend/src/hms_backend/app/api/dependencies.py`
- Modify: `backend/src/hms_backend/app/modules/identity/models.py`
- Test: `backend/tests/test_admin_api.py`

- [ ] **Step 1: Write failing tests**

Add tests that:
- create a `User` with `oidc_subject="staff-ui-dev"`, `role="HMS_ADMIN"`, and no deleted timestamp
- call `GET /api/v1/admin/users` with only `X-HMS-User-Id: staff-ui-dev`
- expect `200`
- call the same endpoint for a deleted user and expect `401`
- call the endpoint for a `CUSTOMER_USER` and expect `403`

Run: `cd backend && uv run pytest tests/test_admin_api.py -k "principal" -q`
Expected: FAIL because `/api/v1/admin/users` does not exist yet and principal resolution still requires `X-HMS-Roles`.

- [ ] **Step 2: Implement minimal principal resolution**

Change `get_current_principal` so it:
- accepts `X-HMS-User-Id` as the local OIDC subject
- loads `User` by `oidc_subject`
- rejects missing/deleted users with `401`
- derives `Role` from `User.role`
- derives customer scope from `User.customer_id`
- keeps `X-HMS-Roles` only as a local fallback when no user row exists, preserving existing tests

- [ ] **Step 3: Verify green**

Run: `cd backend && uv run pytest tests/test_admin_api.py -k "principal" -q`
Expected: PASS.

### Task 2: Admin Users, Devices, And Audit APIs

**Files:**
- Create: `backend/src/hms_backend/app/api/admin.py`
- Modify: `backend/src/hms_backend/app/api/schemas.py`
- Modify: `backend/src/hms_backend/app/main.py`
- Modify: `backend/src/hms_backend/app/core/rbac.py`
- Test: `backend/tests/test_admin_api.py`

- [ ] **Step 1: Write failing tests**

Add tests that:
- list users with search/sort
- create a user and assert `AuditEvent.action == "user.created"`
- patch a user role/customer scope and assert `AuditEvent.action == "user.updated"`
- soft-delete a user and assert `AuditEvent.action == "user.deleted"`
- list audit events with `entity=User`
- list devices and patch `revoked`/`offline_window_days` with audit action `device.updated`

Run: `cd backend && uv run pytest tests/test_admin_api.py -q`
Expected: FAIL until the router and schemas exist.

- [ ] **Step 2: Implement admin router**

Expose:
- `GET /api/v1/admin/users`
- `POST /api/v1/admin/users`
- `PATCH /api/v1/admin/users/{user_id}`
- `DELETE /api/v1/admin/users/{user_id}`
- `GET /api/v1/admin/devices`
- `PATCH /api/v1/admin/devices/{device_id}`
- `GET /api/v1/admin/audit-events`

Use `Permission.USER_ADMIN` for user/device writes and `Permission.AUDIT_READ` for audit reads.

- [ ] **Step 3: Verify green**

Run: `cd backend && uv run pytest tests/test_admin_api.py -q`
Expected: PASS.

### Task 3: Structured Error Envelope

**Files:**
- Modify: `backend/src/hms_backend/app/main.py`
- Test: `backend/tests/test_admin_api.py`

- [ ] **Step 1: Write failing tests**

Add tests that a missing user header returns:

```json
{
  "error": {
    "code": "unauthorized",
    "message": "Missing HMS user identity"
  }
}
```

and a forbidden admin call returns `code: "forbidden"`.

Run: `cd backend && uv run pytest tests/test_admin_api.py -k "error_envelope" -q`
Expected: FAIL because current errors return raw FastAPI `detail`.

- [ ] **Step 2: Implement handlers**

Add FastAPI handlers for `HTTPException`, `PermissionError`, and validation errors that return `{ "error": { "code", "message", "details" } }`.

- [ ] **Step 3: Verify green**

Run: `cd backend && uv run pytest tests/test_admin_api.py -k "error_envelope" -q`
Expected: PASS.

### Task 4: Seed Admin Users And CLI Cleanup

**Files:**
- Modify: `backend/src/hms_backend/app/tooling/local_seed.py`
- Modify: `backend/src/hms_backend/app/cli.py`
- Modify: `backend/pyproject.toml`
- Test: `backend/tests/test_local_seed.py`

- [ ] **Step 1: Write failing tests**

Update local seed expectations to assert three synthetic users exist:
- `staff-ui-dev` as `HMS_ADMIN`
- `inspector-1` as `INSPECTOR`
- `reviewer-1` as `REVIEWER`

Run: `cd backend && uv run pytest tests/test_local_seed.py -q`
Expected: FAIL because seed data does not create users.

- [ ] **Step 2: Implement seed/CLI commands**

Seed admin users idempotently and expose scripts:
- `hms-api = hms_backend.app.cli:main`
- `hms-seed = hms_backend.app.tooling.local_seed:main`

- [ ] **Step 3: Verify green**

Run: `cd backend && uv run pytest tests/test_local_seed.py -q`
Expected: PASS.

### Task 5: Staff Client And Admin Workspace

**Files:**
- Modify: `web/apps/staff/src/domain/types.ts`
- Modify: `web/apps/staff/src/api/hmsClient.ts`
- Modify: `web/apps/staff/src/components/OperationalWorkspace.tsx`
- Modify: `web/apps/staff/src/components/SystemWorkspace.tsx`
- Test: `web/apps/staff/src/__tests__/hmsClient.test.ts`
- Test: `web/apps/staff/src/__tests__/App.test.tsx`

- [ ] **Step 1: Write failing client/UI tests**

Add tests that:
- map `/api/v1/admin/audit-events` into audit rows
- map/create/update/archive `/api/v1/admin/users`
- map/list/update `/api/v1/admin/devices`
- render backend audit, user, and device rows in the existing workspaces
- show a structured API error message when an admin request returns the error envelope

Run: `cd web/apps/staff && npm test -- hmsClient.test.ts App.test.tsx --run -t "admin|audit|devices|structured"`.
Expected: FAIL until client and components are wired.

- [ ] **Step 2: Implement client and UI**

Add admin domain types, API mappings, fallback mock data, and connected System/Audit workspaces. Keep existing visual style and table components.

- [ ] **Step 3: Verify green**

Run: `cd web/apps/staff && npm test -- hmsClient.test.ts App.test.tsx --run -t "admin|audit|devices|structured"`.
Expected: PASS.

### Task 6: Full Verification

**Files:**
- Modify docs as needed: `README.md`, `backend/README.md`

- [ ] **Step 1: Run backend checks**

Run:
- `cd backend && uv run ruff check . ../tooling`
- `cd backend && uv run mypy src tests ../tooling`
- `cd backend && uv run pytest`

- [ ] **Step 2: Run frontend checks**

Run:
- `cd web/apps/staff && npm test -- --run`
- `cd web/apps/staff && npm run build`
- `cd web/apps/inspector && npm test -- --run`
- `cd web/apps/inspector && npm run build`

- [ ] **Step 3: Summarize residual gaps**

Call out that this is database-backed local identity, not final external OIDC provider integration.
