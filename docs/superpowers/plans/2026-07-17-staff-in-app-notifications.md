# Staff In-App Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a real, persisted unread notification feed in the staff top bar.

**Architecture:** Extend the existing notification model and `/notifications/me`
feed with `read_at` and one recipient-scoped idempotent read action. Reuse the
existing `HmsApiClient`, `AppShell`, Lucide icons, Motion, and CSS tokens; no new
state or UI library is introduced.

**Tech Stack:** FastAPI, SQLAlchemy, Alembic, React, TypeScript, Vitest, CSS.

---

### Task 1: Persist and expose read state

**Files:**
- Modify: `backend/src/hms_backend/app/modules/notifications/models.py`
- Modify: `backend/src/hms_backend/app/api/schemas.py`
- Modify: `backend/src/hms_backend/app/api/notifications.py`
- Create: `backend/alembic/versions/20260717_0011_notification_read_state.py`
- Test: `backend/tests/test_notifications_api.py`

- [x] Write tests proving the feed includes only current-user `IN_APP` rows,
  reports the unread total, records read state, and returns `404` for a second
  user's row.
- [x] Add `read_at`, return it in the response, filter the current-user feed to
  `IN_APP`, and add `POST /notifications/{id}/read` with recipient scoping.
- [x] Generate the additive Alembic migration and run the notification API test.

### Task 2: Replace the placeholder top-bar notification UI

**Files:**
- Modify: `web/apps/staff/src/api/hmsClient.ts`
- Modify: `web/apps/staff/src/components/AppShell.tsx`
- Modify: `web/apps/staff/src/styles/shell.css`
- Test: `web/apps/staff/src/__tests__/App.test.tsx`
- Test: `web/apps/staff/src/__tests__/hmsClient.test.ts`

- [x] Write frontend tests for loading real rows, rendering the unread count,
  and opening an unread item to issue the persisted read request.
- [x] Add only the client methods and types needed for the existing feed and
  read action.
- [x] Load the feed in `AppShell`, render loading/empty/error/feed states, and
  mark a clicked row read before routing it to an existing asset or customer
  workspace.
- [x] Use the existing Lucide icons and Motion/CSS tokens for a 180–220ms
  popover/list transition that disables motion when requested.

### Task 3: Verify and ship

**Files:**
- No additional source files.

- [ ] Run the focused backend and frontend tests, then the full staff suite and
  production build.
- [ ] Run `git diff --check` and the Ponytail complexity review.
- [ ] Commit the focused implementation, push the deployment branch, dispatch
  the AWS dev workflow, and verify `/health/ready` plus the published staff
  bundle.
