# BAT Operations Console UI Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve the existing staff console's responsive shell, record-page states, table readability, and inspection detail presentation without changing the current architecture or data contracts.

**Architecture:** Reuse `AppShell`, `ModuleTable`, `WorkspaceState`, `SourceBadge`, existing hooks, CSS tokens, and Motion primitives. Add loading/error state only where the current hooks need it, and use CSS breakpoints for layout changes.

**Tech Stack:** React, TypeScript, Vite, Vitest, CSS, lucide-react, existing Motion primitives.

---

### Task 1: Add explicit workspace request state

**Files:**
- Modify: `web/apps/staff/src/hooks/useAssetsWorkspace.ts`
- Modify: `web/apps/staff/src/hooks/useInspectionsWorkspace.ts`
- Modify: `web/apps/staff/src/components/ModuleTable.tsx`
- Test: `web/apps/staff/src/__tests__/App.test.tsx`

- [ ] Add `isLoading` and `error` state to the two hooks. Set loading before the existing `Promise.all`, clear it after success, and expose a concise error message on rejection. Keep the existing mock fallback behavior unchanged when the loader resolves with `source: "mock"`.
- [ ] Pass `loading` and `error` into `ModuleTable`; render `WorkspaceState` before the table when loading or error is present, so transient empty rows are not shown as final data.
- [ ] Add regression coverage that a pending list request renders `Loading records` and a rejected non-fallback request renders an error state.
- [ ] Run `npx vitest run --pool=forks --maxWorkers=1 --minWorkers=1 web/apps/staff/src/__tests__/App.test.tsx`.

### Task 2: Fix shared shell behavior at tablet widths

**Files:**
- Modify: `web/apps/staff/src/styles/responsive.css`
- Modify: `web/apps/staff/src/styles/shell.css`
- Test: `web/apps/staff/src/__tests__/CommandCentreShell.test.tsx`

- [ ] Add a `max-width: 1120px` breakpoint that gives the top bar a stable title row and action row, keeps `.global-search` at a usable width, and allows only secondary identity text to compact.
- [ ] Keep the existing `max-width: 980px` and mobile rules as the smaller-screen fallback; do not remove the mobile drawer behavior.
- [ ] Add a shell regression assertion for the accessible global search, primary action, and page title remaining present at the supported tablet layout.

### Task 3: Standardize module table surfaces and drawer spacing

**Files:**
- Modify: `web/apps/staff/src/components/ModuleTable.tsx`
- Modify: `web/apps/staff/src/styles/command-centre.css`
- Modify: `web/apps/staff/src/styles/responsive.css`
- Test: `web/apps/staff/src/__tests__/App.test.tsx`

- [ ] Wrap the table in a semantic overflow container with a minimum content width so columns remain readable without creating document-level overflow.
- [ ] Keep table exports and row selection unchanged.
- [ ] Tighten the shared toolbar/table/pagination spacing and make the inspection detail surface occupy the available width at tablet sizes.
- [ ] Preserve the existing `WorkspaceState` empty row and verify assets/inspections still open detail views and close back to lists.

### Task 4: Verify and ship

**Files:**
- No additional source files.

- [ ] Run `npm run lint` from `web/apps/staff`.
- [ ] Run `npm run build` from `web/apps/staff`.
- [ ] Run the full Vitest suite with the single-worker command.
- [ ] Run browser smoke checks at the local app and deployed CloudFront app, including dashboard, assets, inspections, detail open/close, and responsive shell checks.
- [ ] Run `git diff --check`, commit the focused change, push the branch, and trigger the existing AWS dev deployment workflow only after all checks pass.
