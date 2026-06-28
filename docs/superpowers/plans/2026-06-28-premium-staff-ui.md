# Premium Staff UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first BAT HMS 2.0 staff web app slice as a premium customer operations workspace that can run against the FastAPI backend or mock data.

**Architecture:** Create `web/apps/staff` as a React + Vite + TypeScript app. Keep API transport, mock data, view-model state, and visual components separated so backend integration and UI polish can evolve independently.

**Tech Stack:** React, Vite, TypeScript, Vitest, Testing Library, lucide-react, CSS modules through a single app stylesheet.

---

### Task 1: App Scaffold And Test Harness

**Files:**
- Create: `web/apps/staff/package.json`
- Create: `web/apps/staff/index.html`
- Create: `web/apps/staff/tsconfig.json`
- Create: `web/apps/staff/vite.config.ts`
- Create: `web/apps/staff/src/test/setup.ts`

- [x] **Step 1: Add Vite/Vitest configuration**

Create a React/Vite app with a dev proxy for `/api` and `/health` to `http://127.0.0.1:8000`. Configure Vitest with jsdom and Testing Library setup.

- [ ] **Step 2: Install dependencies**

Run: `npm install`

Expected: `package-lock.json` and `node_modules` are created for the staff app.

### Task 2: API Client And Mock Fallback

**Files:**
- Create: `web/apps/staff/src/api/hmsClient.ts`
- Create: `web/apps/staff/src/domain/types.ts`
- Create: `web/apps/staff/src/data/mockCustomers.ts`
- Test: `web/apps/staff/src/__tests__/hmsClient.test.ts`

- [x] **Step 1: Write failing tests**

Tests must prove the client sends `x-hms-user-id` and `x-hms-roles`, maps `/api/v1/customers` response data, and falls back to mock customers when the backend cannot be reached.

- [ ] **Step 2: Run red test**

Run: `npm test -- --run src/__tests__/hmsClient.test.ts`

Expected: FAIL because `hmsClient.ts` and mock/domain modules are not implemented.

- [ ] **Step 3: Implement API client**

Add typed fetch helpers for list/create/update customer plus create location/contact. Expose `loadCustomersWithFallback` for the UI.

- [ ] **Step 4: Run green test**

Run: `npm test -- --run src/__tests__/hmsClient.test.ts`

Expected: PASS.

### Task 3: Premium Customer Workspace UI

**Files:**
- Create: `web/apps/staff/src/App.tsx`
- Create: `web/apps/staff/src/main.tsx`
- Create: `web/apps/staff/src/styles.css`
- Create: `web/apps/staff/src/hooks/useCustomerWorkspace.ts`
- Create: `web/apps/staff/src/components/AppShell.tsx`
- Create: `web/apps/staff/src/components/CustomerTable.tsx`
- Create: `web/apps/staff/src/components/CustomerDetail.tsx`
- Create: `web/apps/staff/src/components/ActivityFeed.tsx`
- Create: `web/apps/staff/src/components/CustomerForm.tsx`
- Test: `web/apps/staff/src/__tests__/App.test.tsx`

- [x] **Step 1: Write failing UI tests**

Tests must prove the workspace renders the premium staff shell, shows mock customers, selects a customer, filters rows, and creates a local customer record when the backend is unavailable.

- [ ] **Step 2: Run red test**

Run: `npm test -- --run src/__tests__/App.test.tsx`

Expected: FAIL because UI modules are not implemented.

- [ ] **Step 3: Implement UI**

Build a table-first enterprise workspace matching the approved concept: dark graphite sidebar, top search/status bar, filters, customer table, selected customer detail panel, location/contact tabs, summary metrics, and activity rail.

- [ ] **Step 4: Run green test**

Run: `npm test -- --run src/__tests__/App.test.tsx`

Expected: PASS.

### Task 4: Verification And Handoff

**Files:**
- Modify: frontend files only when visual or test fixes are required.

- [ ] **Step 1: Run full frontend checks**

Run: `npm test -- --run` and `npm run build`.

Expected: both pass.

- [ ] **Step 2: Run backend regression checks**

Run from `backend`: `uv run pytest`.

Expected: backend tests remain passing.

- [ ] **Step 3: Browser verification**

Start the staff dev server, open the app, test row selection/filtering/create flow, capture a screenshot, and compare it with the approved concept via `view_image`.

- [ ] **Step 4: Commit**

Commit the staff app and plan without committing production PDFs or local `.superpowers` artifacts.
