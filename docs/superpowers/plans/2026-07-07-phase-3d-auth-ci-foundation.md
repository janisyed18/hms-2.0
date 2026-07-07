# Phase 3D Auth and CI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a clear auth boundary, role-aware staff navigation, and broader CI validation.

**Architecture:** Backend auth is centralized in `api/dependencies.py`, with token validation isolated in `core/auth.py` and a read-only `/api/v1/auth/me` session endpoint. The staff UI consumes a `StaffSession` and filters modules by permission. CI validates all current service surfaces plus Docker Compose builds.

**Tech Stack:** FastAPI, SQLAlchemy async sessions, Pydantic settings, React/Vite, Vitest, GitHub Actions, Docker Compose.

---

### Task 1: Backend Auth Boundary

**Files:**
- Modify: `backend/src/hms_backend/app/core/config.py`
- Create: `backend/src/hms_backend/app/core/auth.py`
- Modify: `backend/src/hms_backend/app/api/dependencies.py`
- Create: `backend/src/hms_backend/app/api/auth.py`
- Modify: `backend/src/hms_backend/app/main.py`
- Test: `backend/tests/test_auth_boundary.py`

- [x] **Step 1: Write failing tests for bearer mode and dev fallback controls**
- [x] **Step 2: Run targeted backend auth tests and confirm failure**
- [x] **Step 3: Add auth settings, HS256 bearer validation, persisted user resolution, and `/auth/me`**
- [x] **Step 4: Run targeted backend auth tests and confirm pass**

### Task 2: Staff Session and Role-Aware UI

**Files:**
- Modify: `web/apps/staff/src/domain/types.ts`
- Modify: `web/apps/staff/src/data/mockAdmin.ts`
- Modify: `web/apps/staff/src/api/hmsClient.ts`
- Modify: `web/apps/staff/src/App.tsx`
- Modify: `web/apps/staff/src/components/AppShell.tsx`
- Test: `web/apps/staff/src/__tests__/hmsClient.test.ts`
- Test: `web/apps/staff/src/__tests__/App.test.tsx`

- [x] **Step 1: Write failing tests for bearer headers, auth-session mapping, and inspector navigation**
- [x] **Step 2: Run targeted staff tests and confirm failure**
- [x] **Step 3: Add staff session types, client auth helpers, and module filtering**
- [x] **Step 4: Run targeted staff tests and confirm pass**

### Task 3: CI and Local Documentation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `backend/.env.example`
- Modify: `backend/README.md`
- Modify: `docker-compose.yml`

- [x] **Step 1: Add certificate-service lint/type/test job**
- [x] **Step 2: Add Docker Compose config/build validation job**
- [x] **Step 3: Document auth modes and local env settings**

### Task 4: Verification

**Files:**
- All changed files

- [x] **Step 1: Run backend ruff, mypy, and pytest**
- [x] **Step 2: Run certificate-service ruff, mypy, and pytest**
- [x] **Step 3: Run staff tests/build**
- [x] **Step 4: Run inspector tests/build**
- [x] **Step 5: Run Docker Compose config/build smoke if time allows**
