# BAT Operations Console Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved BAT Operations Console visual redesign across the HMS 2.0 staff React app without changing backend contracts or production data behavior.

**Architecture:** Keep the existing React/Vite app and workspace hooks. Add small UI primitives for console panels/status rendering, refactor the app shell into grouped navigation, and restyle the existing dashboard/module/customer workspaces to match the accepted console direction.

**Tech Stack:** React, TypeScript, Vite, lucide-react, Vitest, Testing Library, CSS.

---

## File Structure

- Modify `web/apps/staff/src/components/AppShell.tsx`: grouped sidebar navigation, disabled nav states, topbar primary action, user block, global search.
- Modify `web/apps/staff/src/App.tsx`: page titles and routing for disabled/empty modules.
- Modify `web/apps/staff/src/components/OperationalWorkspace.tsx`: dashboard KPI cards, overdue retests table, fleet health ring, due-this-week, awaiting-review, audit/sync panels.
- Modify `web/apps/staff/src/components/ModuleTable.tsx`: table-first console toolbar, panel header, internal scroll frame, filter/download/action layout.
- Modify `web/apps/staff/src/components/AssetsWorkspace.tsx`: asset-register columns and labels from the spec.
- Modify `web/apps/staff/src/components/InspectionsWorkspace.tsx`: inspection-management labels and tab-like status summary.
- Modify `web/apps/staff/src/components/CertificatesWorkspace.tsx`: certificate-management labels and table shape.
- Modify `web/apps/staff/src/components/CustomerTable.tsx`: customer-management search/action header and customer cards while preserving selection/add/search behavior.
- Modify `web/apps/staff/src/components/CustomerDetail.tsx`: detail panel restyling only if needed for viewport fit.
- Modify `web/apps/staff/src/components/WorkspaceState.tsx`: disabled/empty module state styling support if needed.
- Modify `web/apps/staff/src/styles.css`: BAT console tokens, sidebar/topbar, tables, cards, status pills, responsive rules.
- Modify `web/apps/staff/src/__tests__/App.test.tsx`: add tests for grouped shell, dashboard content, asset register, inspection/certificate labels, customer cards, disabled module states, and core interactions.

## Task 1: Lock Console Requirements In Tests

**Files:**
- Modify: `web/apps/staff/src/__tests__/App.test.tsx`

- [ ] **Step 1: Add failing shell/dashboard tests**

Add assertions to the existing dashboard/shell tests:

```tsx
expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeVisible();
expect(screen.getByText("Overview")).toBeVisible();
expect(screen.getByText("Operations")).toBeVisible();
expect(screen.getByText("Management")).toBeVisible();
expect(screen.getByText("System")).toBeVisible();
expect(screen.getByRole("button", { name: "New Asset" })).toBeVisible();
expect(screen.getByText("Total Assets")).toBeVisible();
expect(screen.getByText("Overdue Retests")).toBeVisible();
expect(screen.getByText("Fleet Health")).toBeVisible();
expect(screen.getByText("Due This Week")).toBeVisible();
expect(screen.getByText("Awaiting Review")).toBeVisible();
```

- [ ] **Step 2: Add failing module surface tests**

Add assertions to existing navigation tests:

```tsx
await user.click(screen.getByRole("button", { name: /Assets/i }));
expect(await screen.findByRole("heading", { name: "Asset Register" })).toBeVisible();
expect(screen.getByRole("table", { name: "Asset records" })).toHaveTextContent("Asset ID");
expect(screen.getByRole("table", { name: "Asset records" })).toHaveTextContent("End A / End B");

await user.click(screen.getByRole("button", { name: /Inspections/i }));
expect(await screen.findByRole("heading", { name: "Inspection Management" })).toBeVisible();
expect(screen.getByRole("tab", { name: /Submitted/i })).toBeVisible();
expect(screen.getByRole("table", { name: "Inspection records" })).toHaveTextContent("Pressure Test");

await user.click(screen.getByRole("button", { name: /Certificates/i }));
expect(await screen.findByRole("heading", { name: "Certificate Management" })).toBeVisible();
expect(screen.getByRole("tab", { name: "All Certificates" })).toBeVisible();
expect(screen.getByRole("table", { name: "Certificate records" })).toHaveTextContent("Verification");

await user.click(screen.getByRole("button", { name: /Customers/i }));
expect(await screen.findByRole("heading", { name: "Customer Management" })).toBeVisible();
expect(screen.getByText("North Sea Shipping Ltd")).toBeVisible();
expect(screen.getByRole("button", { name: "Add Customer" })).toBeVisible();
```

- [ ] **Step 3: Add disabled nav test**

Add a test that clicks `Analytics`, `Retest Schedule`, `Users & Roles`, or `Devices` and expects a clean unavailable state:

```tsx
await user.click(screen.getByRole("button", { name: "Analytics" }));
expect(await screen.findByRole("heading", { name: "Analytics" })).toBeVisible();
expect(screen.getByText("This workspace is not available yet.")).toBeVisible();
```

- [ ] **Step 4: Run targeted tests and verify RED**

Run:

```bash
npm test -- --run src/__tests__/App.test.tsx
```

Expected: fail because the current UI does not yet render the BAT console headings, grouped nav labels, module tabs, customer cards, or disabled workspace state.

## Task 2: Implement Console App Shell

**Files:**
- Modify: `web/apps/staff/src/components/AppShell.tsx`
- Modify: `web/apps/staff/src/App.tsx`
- Modify: `web/apps/staff/src/styles.css`

- [ ] **Step 1: Extend `AppModule` and grouped nav**

Add disabled-route modules to `AppModule` and group navigation by section:

```ts
export type AppModule =
  | "dashboard"
  | "analytics"
  | "customers"
  | "assets"
  | "products"
  | "reference"
  | "inspections"
  | "certificates"
  | "retest"
  | "sync"
  | "audit"
  | "users"
  | "devices";
```

Use a grouped nav data structure with labels `Overview`, `Operations`, `Management`, and `System`. Keep all nav buttons clickable; unimplemented modules route to `WorkspaceState`.

- [ ] **Step 2: Refactor sidebar/topbar markup**

Render:

```tsx
<div className="brand-lockup">
  <div className="brand-shield"><ShieldCheck ... /></div>
  <div><strong>BAT HMS</strong><span>v2.0</span></div>
</div>
```

Topbar primary button text must be `New Asset`. It should call `onModuleChange("assets")` for now rather than creating data.

- [ ] **Step 3: Add unavailable module rendering**

In `App.tsx`, add title/description copy for `analytics`, `retest`, `users`, and `devices`, and render:

```tsx
<WorkspaceState title={activeCopy.title}>
  This workspace is not available yet.
</WorkspaceState>
```

- [ ] **Step 4: Run targeted tests**

Run:

```bash
npm test -- --run src/__tests__/App.test.tsx
```

Expected: shell/nav and disabled state assertions pass, while dashboard/module surface assertions can still fail until later tasks.

- [ ] **Step 5: Commit**

```bash
git add web/apps/staff/src/components/AppShell.tsx web/apps/staff/src/App.tsx web/apps/staff/src/styles.css web/apps/staff/src/__tests__/App.test.tsx
git commit -m "feat: add bat console shell navigation"
```

## Task 3: Implement Dashboard Operations Console

**Files:**
- Modify: `web/apps/staff/src/components/OperationalWorkspace.tsx`
- Modify: `web/apps/staff/src/styles.css`
- Modify: `web/apps/staff/src/__tests__/App.test.tsx`

- [ ] **Step 1: Replace dashboard layout**

For `module === "dashboard"`, render:

```tsx
<section className="console-dashboard" aria-label="Dashboard workspace">
  <div className="kpi-grid">...</div>
  <div className="dashboard-layout">
    <section className="data-panel overdue-panel">...</section>
    <aside className="dashboard-side">...</aside>
  </div>
  <section className="data-panel awaiting-panel">...</section>
</section>
```

Include visible labels `Total Assets`, `In Service`, `Overdue`, `Pending Review`, `Overdue Retests`, `Fleet Health`, `Due This Week`, and `Awaiting Review`.

- [ ] **Step 2: Keep sync and audit as console panels**

Restyle sync and audit via existing `OperationsTable`, but use `data-panel`/`console-table` classes and keep aria labels `Sync queue items` and `Audit trail events`.

- [ ] **Step 3: Run targeted tests**

Run:

```bash
npm test -- --run src/__tests__/App.test.tsx
```

Expected: dashboard assertions pass.

- [ ] **Step 4: Commit**

```bash
git add web/apps/staff/src/components/OperationalWorkspace.tsx web/apps/staff/src/styles.css web/apps/staff/src/__tests__/App.test.tsx
git commit -m "feat: redesign operations dashboard"
```

## Task 4: Implement Table-First Module Surfaces

**Files:**
- Modify: `web/apps/staff/src/components/ModuleTable.tsx`
- Modify: `web/apps/staff/src/components/AssetsWorkspace.tsx`
- Modify: `web/apps/staff/src/components/InspectionsWorkspace.tsx`
- Modify: `web/apps/staff/src/components/CertificatesWorkspace.tsx`
- Modify: `web/apps/staff/src/components/ProductsWorkspace.tsx`
- Modify: `web/apps/staff/src/components/ReferenceWorkspace.tsx`
- Modify: `web/apps/staff/src/styles.css`
- Modify: `web/apps/staff/src/__tests__/App.test.tsx`

- [ ] **Step 1: Refactor `ModuleTable` panel anatomy**

Keep the generic API, but render a BAT console toolbar, source select, filter button, table actions, and internal table frame. The table must preserve `aria-label={tableLabel}`.

- [ ] **Step 2: Update assets columns**

In `AssetsWorkspace.tsx`, change columns to:

```ts
["Asset ID", "Customer", "Product", "Bore", "End A / End B", "Location", "Retest Due", "Lifecycle", "Actions"]
```

Use known asset fields when available and safe fallbacks for bore/end values.

- [ ] **Step 3: Update inspections/certificates display labels**

Set table labels/headings to `Inspection records` and `Certificate records`, with visible module page headings from `App.tsx`: `Inspection Management` and `Certificate Management`.

Add tab-like status strips in each workspace using `role="tablist"` and `role="tab"` for the labels in the spec. These tabs are view controls only; they can be static for this pass.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
npm test -- --run src/__tests__/App.test.tsx
```

Expected: asset, inspection, and certificate assertions pass.

- [ ] **Step 5: Commit**

```bash
git add web/apps/staff/src/components/ModuleTable.tsx web/apps/staff/src/components/AssetsWorkspace.tsx web/apps/staff/src/components/InspectionsWorkspace.tsx web/apps/staff/src/components/CertificatesWorkspace.tsx web/apps/staff/src/components/ProductsWorkspace.tsx web/apps/staff/src/components/ReferenceWorkspace.tsx web/apps/staff/src/styles.css web/apps/staff/src/__tests__/App.test.tsx
git commit -m "feat: redesign core record workspaces"
```

## Task 5: Implement Customer Management Cards

**Files:**
- Modify: `web/apps/staff/src/components/CustomerTable.tsx`
- Modify: `web/apps/staff/src/components/CustomerDetail.tsx`
- Modify: `web/apps/staff/src/styles.css`
- Modify: `web/apps/staff/src/__tests__/App.test.tsx`

- [ ] **Step 1: Replace customer table first view with customer cards**

Keep the `CustomerTable` component name and props, but render:

```tsx
<section className="customer-management" aria-label="Customer workspace">
  <div className="customer-management-toolbar">...</div>
  <div className="customer-card-grid">...</div>
</section>
```

Each card must be keyboard selectable and call `onSelectCustomer(customer.id)`.

- [ ] **Step 2: Preserve CSV download and add form action**

Keep the existing `Download customer list` button and `Add Customer` button behavior.

- [ ] **Step 3: Run targeted tests**

Run:

```bash
npm test -- --run src/__tests__/App.test.tsx
```

Expected: customer cards and add/search interactions pass.

- [ ] **Step 4: Commit**

```bash
git add web/apps/staff/src/components/CustomerTable.tsx web/apps/staff/src/components/CustomerDetail.tsx web/apps/staff/src/styles.css web/apps/staff/src/__tests__/App.test.tsx
git commit -m "feat: redesign customer management workspace"
```

## Task 6: Final Visual System And Verification

**Files:**
- Modify: `web/apps/staff/src/styles.css`

- [ ] **Step 1: Finish BAT console CSS**

Apply final CSS tokens and responsive rules for:

- dark sidebar and selected nav states
- white topbar
- blue-gray workspace background
- 10-14px panel radii
- low shadows
- table internal scrolling only
- status pills
- mobile one-column layout
- reduced-motion support

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test -- --run
npm run build
```

Expected: all tests pass and Vite build succeeds.

- [ ] **Step 3: Browser QA**

Start dev server from the worktree:

```bash
npm run dev -- --host 127.0.0.1 --port 5177
```

Using Browser/IAB, verify:

- Dashboard loads at `http://127.0.0.1:5177/`
- Sidebar navigation works for Dashboard, Assets, Inspections, Certificates, Customers, Products, Reference Data, Audit Log
- Disabled modules show unavailable state
- Desktop viewport around 1366x900 has no document-level horizontal overflow
- Mobile viewport around 390x844 has no document-level horizontal overflow
- No relevant console errors or warnings

- [ ] **Step 4: Commit**

```bash
git add web/apps/staff/src/styles.css
git commit -m "style: finalize bat operations console polish"
```

## Self-Review Notes

- Spec coverage: shell, dashboard, assets, inspections, certificates, customers, products/reference inheritance, data behavior, accessibility, and responsive verification are covered.
- Placeholders: no `TBD`, `TODO`, or deferred implementation steps are present.
- Scope guard: backend/auth/migration/import/escalation/bulk-generate features remain out of scope.
