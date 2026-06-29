# Phase 2C Clean Operations UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the React staff app into the approved Clean Operations Console UI before Phase 3.

**Architecture:** Keep the current React/Vite staff app and backend contracts. Add lightweight shell-only operational modules for Dashboard, Sync Queue, and Audit, wire visible shell controls to real UI behavior, then standardize reusable empty/loading/error/action states and the visual system through existing components and CSS.

**Tech Stack:** React 19, Vite 7, TypeScript, Vitest, Testing Library, `lucide-react`, existing CSS.

---

## Scope Check

This plan covers one subsystem: the staff web UI polish pass. It does not modify backend APIs, database migrations, OIDC, sync endpoints, infrastructure, Helm, CI deployment, or Phase 3 domain workflows.

## File Structure

- Modify `web/apps/staff/src/App.tsx`: make Dashboard, Sync Queue, and Audit render as real modules.
- Modify `web/apps/staff/src/components/AppShell.tsx`: expand `AppModule`, wire all sidebar and topbar controls, and keep one icon package.
- Create `web/apps/staff/src/components/OperationalWorkspace.tsx`: read-only Dashboard, Sync Queue, and Audit workspaces backed by local UI data.
- Create `web/apps/staff/src/components/WorkspaceState.tsx`: shared loading, empty, error, source, and inline success state components.
- Modify `web/apps/staff/src/components/ModuleTable.tsx`: add useful filter summary and CSV download behavior for generic tables.
- Modify `web/apps/staff/src/components/CustomerTable.tsx`: add working filter summary and CSV download behavior for the customer table.
- Modify `web/apps/staff/src/components/CertificatesWorkspace.tsx`: use the shared state/action polish where it improves the certificate screen.
- Modify `web/apps/staff/src/components/InspectionsWorkspace.tsx`: use the shared state/action polish where it improves the inspection screen.
- Modify `web/apps/staff/src/styles.css`: implement the Clean Operations Console visual system, transitions, focus states, responsive spacing, and reduced-motion behavior.
- Modify `web/apps/staff/src/__tests__/App.test.tsx`: cover shell modules, topbar controls, and action behavior.

## Task 1: Add Failing Tests For Shell Modules And Controls

**Files:**
- Modify: `web/apps/staff/src/__tests__/App.test.tsx`

- [ ] **Step 1: Add shell module navigation and topbar interaction tests**

Append these tests before the closing `});` in `web/apps/staff/src/__tests__/App.test.tsx`:

```tsx
  it("opens dashboard, sync queue, and audit as real shell workspaces", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Dashboard" }));
    expect(await screen.findByRole("heading", { name: "Operations Dashboard" })).toBeVisible();
    expect(screen.getByText("Mock data")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Sync Queue/i }));
    expect(await screen.findByRole("heading", { name: "Sync Queue" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Sync queue items" })).toHaveTextContent(
      "Certificate issue"
    );

    await user.click(screen.getByRole("button", { name: "Audit" }));
    expect(await screen.findByRole("heading", { name: "Audit Trail" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Audit trail events" })).toHaveTextContent(
      "Inspection approved"
    );
  });

  it("opens topbar menus and applies global search navigation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.type(await screen.findByLabelText("Global search"), "certificate");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Certificates" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Environment and source details" }));
    expect(screen.getByRole("dialog", { name: "Environment details" })).toHaveTextContent(
      "Demo mode"
    );

    await user.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByRole("dialog", { name: "Notifications" })).toHaveTextContent(
      "Inspection approval"
    );

    await user.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getByRole("dialog", { name: "Help" })).toHaveTextContent("Support");

    await user.click(screen.getByRole("button", { name: "User menu" }));
    expect(screen.getByRole("dialog", { name: "User menu" })).toHaveTextContent(
      "Alex Williams"
    );
  });
```

- [ ] **Step 2: Run the focused failing tests**

Run:

```bash
cd web/apps/staff
npm test -- --run src/__tests__/App.test.tsx
```

Expected: FAIL because Dashboard, Sync Queue, Audit, and the topbar menu dialogs are not implemented yet.

- [ ] **Step 3: Commit the failing tests**

```bash
git add web/apps/staff/src/__tests__/App.test.tsx
git commit -m "test: cover phase 2c shell interactions"
```

## Task 2: Implement Shell Modules And Topbar Behavior

**Files:**
- Modify: `web/apps/staff/src/App.tsx`
- Modify: `web/apps/staff/src/components/AppShell.tsx`
- Create: `web/apps/staff/src/components/OperationalWorkspace.tsx`
- Test: `web/apps/staff/src/__tests__/App.test.tsx`

- [ ] **Step 1: Create the read-only operational workspace component**

Create `web/apps/staff/src/components/OperationalWorkspace.tsx`:

```tsx
import {
  Activity,
  BadgeCheck,
  BellRing,
  ClipboardCheck,
  CloudCog,
  RefreshCcw,
  ShieldCheck
} from "lucide-react";
import type { ReactNode } from "react";

type OperationalModule = "dashboard" | "sync" | "audit";

interface OperationalWorkspaceProps {
  module: OperationalModule;
  source: "api" | "mock";
}

const syncRows = [
  ["Certificate issue", "Queued", "CERT-VOPA-NEW-1", "2 min ago"],
  ["Inspection draft", "Ready", "997950", "9 min ago"],
  ["Asset update", "Waiting", "ORIC-100", "18 min ago"]
];

const auditRows = [
  ["Inspection approved", "Alex Williams", "ORIC-100", "2026-06-29 10:41"],
  ["Certificate issued", "Alex Williams", "CERT-VOPA-NEW-1", "2026-06-29 10:48"],
  ["Asset reviewed", "Alex Williams", "997950", "2026-06-29 11:02"]
];

export function OperationalWorkspace({ module, source }: OperationalWorkspaceProps) {
  if (module === "sync") {
    return (
      <section className="operations-page" aria-label="Sync queue workspace">
        <OperationsHeader
          eyebrow="Operations"
          icon={<RefreshCcw aria-hidden="true" size={20} />}
          source={source}
          title="Sync Queue"
          description="Read-only local queue view for records waiting on future sync APIs."
        />
        <OperationsTable
          ariaLabel="Sync queue items"
          columns={["Item", "State", "Record", "Updated"]}
          rows={syncRows}
        />
      </section>
    );
  }

  if (module === "audit") {
    return (
      <section className="operations-page" aria-label="Audit workspace">
        <OperationsHeader
          eyebrow="Governance"
          icon={<ShieldCheck aria-hidden="true" size={20} />}
          source={source}
          title="Audit Trail"
          description="Read-only local event stream for inspection, certificate, and asset activity."
        />
        <OperationsTable
          ariaLabel="Audit trail events"
          columns={["Event", "Actor", "Record", "Time"]}
          rows={auditRows}
        />
      </section>
    );
  }

  return (
    <section className="operations-page" aria-label="Dashboard workspace">
      <OperationsHeader
        eyebrow="Overview"
        icon={<Activity aria-hidden="true" size={20} />}
        source={source}
        title="Operations Dashboard"
        description="Current operational snapshot across customers, assets, inspections, and certificates."
      />
      <div className="operations-grid" aria-label="Operational highlights">
        <MetricCard icon={<ClipboardCheck size={18} />} label="Open inspections" value="4" tone="blue" />
        <MetricCard icon={<BadgeCheck size={18} />} label="Issued certificates" value="2" tone="green" />
        <MetricCard icon={<CloudCog size={18} />} label="Sync items" value="7" tone="amber" />
        <MetricCard icon={<BellRing size={18} />} label="Attention" value="3" tone="red" />
      </div>
      <div className="operations-split">
        <section className="operations-panel">
          <h3>Today</h3>
          <p>Inspection approvals, certificate issue events, and asset review items are grouped here for the staff workspace.</p>
        </section>
        <section className="operations-panel">
          <h3>Next Review</h3>
          <p>The next focused build phase can replace this read-only snapshot with backend dashboard aggregates.</p>
        </section>
      </div>
    </section>
  );
}

function OperationsHeader({
  description,
  eyebrow,
  icon,
  source,
  title
}: {
  description: string;
  eyebrow: string;
  icon: ReactNode;
  source: "api" | "mock";
  title: string;
}) {
  return (
    <header className="operations-header">
      <div className="operations-heading-icon">{icon}</div>
      <div>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <strong>{source === "api" ? "Backend" : "Mock data"}</strong>
    </header>
  );
}

function MetricCard({
  icon,
  label,
  tone,
  value
}: {
  icon: ReactNode;
  label: string;
  tone: "blue" | "green" | "amber" | "red";
  value: string;
}) {
  return (
    <div className={`operations-metric tone-${tone}`}>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function OperationsTable({
  ariaLabel,
  columns,
  rows
}: {
  ariaLabel: string;
  columns: string[];
  rows: string[][];
}) {
  return (
    <section className="table-panel operations-table-panel">
      <div className="table-frame">
        <table aria-label={ariaLabel}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.join("-")}>
                {row.map((cell, index) => (
                  <td key={`${cell}-${index}`}>{index === 0 ? <strong>{cell}</strong> : cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Extend module routing in `App.tsx`**

Update `web/apps/staff/src/App.tsx` so it imports `OperationalWorkspace`, includes copy for `dashboard`, `sync`, and `audit`, starts on `"dashboard"`, and renders operational modules:

```tsx
import { OperationalWorkspace } from "./components/OperationalWorkspace";
```

```tsx
const moduleCopy: Record<AppModule, { title: string; description: string }> = {
  dashboard: {
    title: "Operations Dashboard",
    description: "Operational snapshot across HMS records and staff workflow queues"
  },
  customers: {
    title: "Customers",
    description: "Manage customers and view hose management overview"
  },
  assets: {
    title: "Assets",
    description: "Track hose assemblies, lifecycle status, and retest scheduling"
  },
  products: {
    title: "Products",
    description: "Maintain hose product catalog records and standards"
  },
  reference: {
    title: "Reference Data",
    description: "Manage controlled standards and lookup data"
  },
  inspections: {
    title: "Inspections",
    description: "Manage draft, submitted, and approved inspection workflows"
  },
  certificates: {
    title: "Certificates",
    description: "Issue and review versioned certificate records"
  },
  sync: {
    title: "Sync Queue",
    description: "Review local sync readiness and queued operational events"
  },
  audit: {
    title: "Audit Trail",
    description: "Review read-only staff activity and record lifecycle events"
  }
};
```

```tsx
const [activeModule, setActiveModule] = useState<AppModule>("dashboard");
```

Render this branch before the customer branch:

```tsx
      {["dashboard", "sync", "audit"].includes(activeModule) ? (
        <main className="record-page">
          <div className="record-main">
            <OperationalWorkspace
              module={activeModule as "dashboard" | "sync" | "audit"}
              source={workspace.source}
            />
          </div>
        </main>
      ) : activeModule === "customers" ? (
```

- [ ] **Step 3: Wire sidebar and topbar controls in `AppShell.tsx`**

Update the React import, `AppModule`, and nav items in `web/apps/staff/src/components/AppShell.tsx`:

```tsx
import { useState, type FormEvent, type ReactNode } from "react";
```

```tsx
export type AppModule =
  | "dashboard"
  | "customers"
  | "assets"
  | "products"
  | "reference"
  | "inspections"
  | "certificates"
  | "sync"
  | "audit";
```

```tsx
const navItems = [
  { label: "Dashboard", icon: LayoutDashboard, module: "dashboard" },
  { label: "Customers", icon: UsersRound, module: "customers" },
  { label: "Assets", icon: Database, module: "assets" },
  { label: "Products", icon: Boxes, module: "products" },
  { label: "Reference Data", icon: TableProperties, module: "reference" },
  { label: "Inspections", icon: ClipboardCheck, module: "inspections" },
  { label: "Certificates", icon: FileCheck2, module: "certificates" },
  { label: "Sync Queue", icon: RefreshCcw, module: "sync", badge: "7" },
  { label: "Audit", icon: ShieldCheck, module: "audit" }
] satisfies Array<{
  label: string;
  icon: typeof LayoutDashboard;
  module: AppModule;
  badge?: string;
}>;
```

Add local state and a global search handler inside `AppShell`:

```tsx
const [openMenu, setOpenMenu] = useState<"environment" | "notifications" | "help" | "user" | null>(null);
const [isCollapsed, setIsCollapsed] = useState(false);
const [globalQuery, setGlobalQuery] = useState("");

function handleGlobalSearch(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const normalized = globalQuery.trim().toLowerCase();
  const target = navItems.find((item) => item.label.toLowerCase().includes(normalized));
  if (target && normalized) {
    onModuleChange(target.module);
    setGlobalQuery("");
  }
}
```

Replace the search label with a form:

```tsx
<form className="global-search" onSubmit={handleGlobalSearch}>
  <Search aria-hidden="true" size={17} />
  <label className="sr-only" htmlFor="global-search-input">
    Global search
  </label>
  <input
    id="global-search-input"
    placeholder="Search customers, assets, inspections..."
    value={globalQuery}
    onChange={(event) => setGlobalQuery(event.target.value)}
  />
  <kbd>/</kbd>
</form>
```

Change topbar buttons so they toggle popovers:

```tsx
<button
  aria-label="Environment and source details"
  className="environment-button"
  onClick={() => setOpenMenu(openMenu === "environment" ? null : "environment")}
  type="button"
>
```

```tsx
<button
  className="icon-button has-count"
  aria-label="Notifications"
  onClick={() => setOpenMenu(openMenu === "notifications" ? null : "notifications")}
  type="button"
>
```

```tsx
<button
  className="icon-button"
  aria-label="Help"
  onClick={() => setOpenMenu(openMenu === "help" ? null : "help")}
  type="button"
>
```

Convert the user menu container into a button:

```tsx
<button
  aria-label="User menu"
  className="user-menu"
  onClick={() => setOpenMenu(openMenu === "user" ? null : "user")}
  type="button"
>
```

Add a popover block after `.topbar-actions`:

```tsx
{openMenu ? (
  <div className="topbar-popover" role="dialog" aria-label={popoverTitle(openMenu)}>
    <strong>{popoverTitle(openMenu)}</strong>
    <p>{popoverBody(openMenu, source)}</p>
  </div>
) : null}
```

Add helper functions below `navItems`:

```tsx
function popoverTitle(menu: "environment" | "notifications" | "help" | "user") {
  if (menu === "environment") return "Environment details";
  if (menu === "notifications") return "Notifications";
  if (menu === "help") return "Help";
  return "User menu";
}

function popoverBody(menu: "environment" | "notifications" | "help" | "user", source: "api" | "mock") {
  if (menu === "environment") {
    return source === "api" ? "Backend connection active." : "Demo mode uses local mock data.";
  }
  if (menu === "notifications") {
    return "Inspection approval, certificate issue, and sync queue items are ready for review.";
  }
  if (menu === "help") {
    return "Support, release notes, and workflow guidance will stay available from this menu.";
  }
  return "Alex Williams. Administrator workspace.";
}
```

- [ ] **Step 4: Run tests and fix type imports**

Run:

```bash
cd web/apps/staff
npm test -- --run src/__tests__/App.test.tsx
```

Expected: PASS for the shell tests and existing app tests.

- [ ] **Step 5: Commit shell behavior**

```bash
git add web/apps/staff/src/App.tsx web/apps/staff/src/components/AppShell.tsx web/apps/staff/src/components/OperationalWorkspace.tsx web/apps/staff/src/__tests__/App.test.tsx
git commit -m "feat: add clean operations shell workspaces"
```

## Task 3: Add Reusable States And Working Table Actions

**Files:**
- Create: `web/apps/staff/src/components/WorkspaceState.tsx`
- Modify: `web/apps/staff/src/components/ModuleTable.tsx`
- Modify: `web/apps/staff/src/components/CustomerTable.tsx`
- Modify: `web/apps/staff/src/__tests__/App.test.tsx`

- [ ] **Step 1: Add action behavior tests**

Append this test before the closing `});`:

```tsx
  it("uses working filter summaries and download actions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    const objectUrl = "blob:hms-export";
    const createObjectURL = vi.fn().mockReturnValue(objectUrl);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Customers" }));
    await user.click(screen.getByRole("button", { name: "More Filters" }));
    expect(screen.getByRole("status", { name: "Customer filter summary" })).toHaveTextContent(
      "Status"
    );

    await user.click(screen.getByRole("button", { name: "Download customer list" }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Certificates" }));
    await user.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("status", { name: "Certificate records filter summary" })).toHaveTextContent(
      "Source"
    );

    await user.click(screen.getByRole("button", { name: "Download Certificate records" }));
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });
```

- [ ] **Step 2: Run the focused failing test**

```bash
cd web/apps/staff
npm test -- --run src/__tests__/App.test.tsx -t "uses working filter summaries"
```

Expected: FAIL because filter summaries and CSV downloads are not implemented.

- [ ] **Step 3: Create shared state components**

Create `web/apps/staff/src/components/WorkspaceState.tsx`:

```tsx
import { AlertCircle, CheckCircle2, Inbox, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

interface WorkspaceStateProps {
  action?: ReactNode;
  children: ReactNode;
  title: string;
  tone?: "empty" | "error" | "loading" | "success";
}

const icons = {
  empty: Inbox,
  error: AlertCircle,
  loading: Loader2,
  success: CheckCircle2
};

export function WorkspaceState({
  action,
  children,
  title,
  tone = "empty"
}: WorkspaceStateProps) {
  const Icon = icons[tone];
  return (
    <section className={`workspace-state state-${tone}`} aria-live="polite">
      <Icon aria-hidden="true" className={tone === "loading" ? "is-spinning" : ""} size={22} />
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
      {action ? <div className="workspace-state-action">{action}</div> : null}
    </section>
  );
}

export function SourceBadge({ source }: { source: "api" | "mock" }) {
  return <span className={`source-badge source-${source}`}>{source === "api" ? "Backend" : "Mock data"}</span>;
}
```

- [ ] **Step 4: Add CSV and filter summary support to `ModuleTable.tsx`**

Add `useState` to the React imports and helper functions:

```tsx
import { useState, type ReactNode } from "react";
import { WorkspaceState } from "./WorkspaceState";
```

```tsx
function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows
    .map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
```

Extend `ModuleTableProps<TItem>`:

```tsx
  exportRows: (item: TItem) => string[];
```

Inside `ModuleTable`, add:

```tsx
const [filtersOpen, setFiltersOpen] = useState(false);
const exportData = [columns.map((column) => column.header), ...items.map(exportRows)];
```

Change the Filters button:

```tsx
<button
  aria-expanded={filtersOpen}
  className="secondary-button"
  onClick={() => setFiltersOpen((current) => !current)}
  type="button"
>
  <Filter aria-hidden="true" size={16} />
  Filters
</button>
```

Render the summary after the toolbar:

```tsx
{filtersOpen ? (
  <div className="filter-summary" role="status" aria-label={`${tableLabel} filter summary`}>
    <strong>Active view</strong>
    <span>Source: {source === "api" ? "Backend" : "Mock data"}</span>
    <span>Search: {query.trim() || "All records"}</span>
  </div>
) : null}
```

Change the download button:

```tsx
<button
  className="icon-button light"
  aria-label={`Download ${tableLabel}`}
  onClick={() => downloadCsv(`${tableLabel.toLowerCase().replaceAll(" ", "-")}.csv`, exportData)}
  type="button"
>
  <Download size={17} />
</button>
```

Render a shared empty state in the table body:

```tsx
{items.length === 0 ? (
  <tr>
    <td colSpan={columns.length}>
      <WorkspaceState title="No records found">Adjust the search text or filter controls to expand the current view.</WorkspaceState>
    </td>
  </tr>
) : null}
```

- [ ] **Step 5: Pass `exportRows` from module workspaces**

Update each `ModuleTable` usage:

```tsx
exportRows={(asset) => [
  asset.assetNumber,
  asset.customer.name,
  asset.product.name,
  asset.lifecycleStatus,
  asset.nextRetestDueAt ?? ""
]}
```

```tsx
exportRows={(product) => [product.code, product.name, product.category, product.standardCode ?? ""]}
```

```tsx
exportRows={(standard) => [standard.code, standard.name]}
```

```tsx
exportRows={(inspection) => [
  inspection.status,
  inspection.asset.assetNumber,
  inspection.customer.name,
  inspection.inspectionType,
  inspection.result ?? "",
  pressureLabel(inspection)
]}
```

```tsx
exportRows={(certificate) => [
  certificate.status,
  certificate.number,
  certificate.asset.assetNumber,
  certificate.customer.name,
  certificate.validUntil ?? "",
  certificate.publicToken
]}
```

- [ ] **Step 6: Add CustomerTable filter and CSV behavior**

Add `useState` and CSV helpers to `web/apps/staff/src/components/CustomerTable.tsx`:

```tsx
import { useState } from "react";
```

```tsx
function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows
    .map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
```

Inside `CustomerTable`, add:

```tsx
const [filtersOpen, setFiltersOpen] = useState(false);
const exportRows = [
  ["Customer Name", "Location", "Assets", "Inspection Due", "Certificate Status", "Risk Level", "Last Activity"],
  ...customers.map((customer) => [
    customer.name,
    locationLabel(customer),
    String(customer.metrics.assetCount),
    customer.metrics.inspectionDueLabel,
    customer.metrics.certificateStatusLabel,
    customer.riskLevel,
    customer.lastActivity
  ])
];
```

Change More Filters:

```tsx
<button
  aria-expanded={filtersOpen}
  className="secondary-button"
  onClick={() => setFiltersOpen((current) => !current)}
  type="button"
>
  <Filter aria-hidden="true" size={16} />
  More Filters
</button>
```

Render the customer filter summary after the toolbar:

```tsx
{filtersOpen ? (
  <div className="filter-summary" role="status" aria-label="Customer filter summary">
    <strong>Active view</strong>
    <span>Status: {statusFilter}</span>
    <span>Risk: {riskFilter}</span>
    <span>Search: {query.trim() || "All customers"}</span>
  </div>
) : null}
```

Change the customer download button:

```tsx
<button
  className="icon-button light"
  aria-label="Download customer list"
  onClick={() => downloadCsv("customers.csv", exportRows)}
  type="button"
>
  <Download size={17} />
</button>
```

- [ ] **Step 7: Run tests and commit**

```bash
cd web/apps/staff
npm test -- --run src/__tests__/App.test.tsx
```

Expected: PASS.

```bash
git add web/apps/staff/src/components/WorkspaceState.tsx web/apps/staff/src/components/ModuleTable.tsx web/apps/staff/src/components/CustomerTable.tsx web/apps/staff/src/components/AssetsWorkspace.tsx web/apps/staff/src/components/ProductsWorkspace.tsx web/apps/staff/src/components/ReferenceWorkspace.tsx web/apps/staff/src/components/InspectionsWorkspace.tsx web/apps/staff/src/components/CertificatesWorkspace.tsx web/apps/staff/src/__tests__/App.test.tsx
git commit -m "feat: add clean workspace states and table actions"
```

## Task 4: Apply Clean Operations Visual Polish

**Files:**
- Modify: `web/apps/staff/src/styles.css`
- Test: `web/apps/staff/src/__tests__/App.test.tsx`

- [ ] **Step 1: Replace root tokens with the approved visual system**

In `web/apps/staff/src/styles.css`, update `:root` tokens:

```css
:root {
  --bg: #ffffff;
  --workspace: #f4f7fb;
  --panel: #ffffff;
  --panel-subtle: #f8fafc;
  --ink: #101828;
  --muted: #667085;
  --soft: #98a2b3;
  --border: #d9e2ef;
  --border-strong: #c4cfdd;
  --nav: #0f172a;
  --nav-2: #111c33;
  --accent: #2563eb;
  --accent-2: #3b82f6;
  --success: #0f8f64;
  --danger: #c2410c;
  --warning: #b7791f;
  --focus: 0 0 0 4px rgba(37, 99, 235, 0.16);
  --shadow: 0 18px 50px rgba(15, 23, 42, 0.1);
  --shadow-soft: 0 10px 28px rgba(15, 23, 42, 0.07);
  color: var(--ink);
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
  font-synthesis: none;
  letter-spacing: 0;
}
```

- [ ] **Step 2: Add universal interaction polish**

Add after the base button rules:

```css
button,
a,
input,
select {
  transition:
    background-color 160ms ease,
    border-color 160ms ease,
    box-shadow 160ms ease,
    color 160ms ease,
    transform 160ms ease;
}

button:hover:not(:disabled) {
  transform: translateY(-1px);
}

button:active:not(:disabled) {
  transform: translateY(0);
}

button:focus-visible,
input:focus-visible,
select:focus-visible,
tr:focus-visible {
  outline: 0;
  box-shadow: var(--focus);
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.56;
  transform: none;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.001ms !important;
  }
}
```

- [ ] **Step 3: Refine shell, cards, tables, and drawer classes**

Adjust the existing class blocks for `.app-shell`, `.sidebar`, `.topbar`, `.table-panel`, `.toolbar`, `.field`, `.primary-button`, `.secondary-button`, `.icon-button`, `.detail-panel`, `.drawer-backdrop`, and `.customer-drawer` using these targets:

```css
.app-shell {
  display: grid;
  grid-template-columns: 188px minmax(0, 1fr);
  min-height: 100vh;
  background:
    radial-gradient(circle at top left, rgba(37, 99, 235, 0.08), transparent 28rem),
    var(--workspace);
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  min-height: 84px;
  padding: 18px 28px;
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(18px);
}

.table-panel,
.detail-panel,
.inspection-dashboard,
.operations-header,
.operations-panel {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: var(--shadow-soft);
}

.toolbar {
  gap: 12px;
  padding: 18px;
}

.field,
.global-search {
  min-height: 42px;
  border-radius: 10px;
  background: var(--panel-subtle);
}

.primary-button {
  min-height: 38px;
  border: 1px solid rgba(37, 99, 235, 0.18);
  background: linear-gradient(180deg, var(--accent-2), var(--accent));
  box-shadow: 0 10px 24px rgba(37, 99, 235, 0.2);
}

.secondary-button,
.detail-link {
  min-height: 38px;
  background: #ffffff;
}

.icon-button {
  width: 38px;
  height: 38px;
  border-radius: 10px;
}

.drawer-backdrop {
  animation: fade-in 160ms ease both;
}

.customer-drawer {
  animation: drawer-in 220ms ease both;
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes drawer-in {
  from {
    opacity: 0;
    transform: translateX(18px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
```

- [ ] **Step 4: Add styles for new operational and state components**

Append:

```css
.topbar-popover {
  position: absolute;
  right: 28px;
  top: 70px;
  z-index: 30;
  width: min(340px, calc(100vw - 40px));
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: #ffffff;
  box-shadow: var(--shadow);
}

.topbar-popover strong {
  display: block;
  font-size: 13px;
}

.topbar-popover p {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.operations-page {
  display: grid;
  gap: 18px;
}

.operations-header {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 14px;
  align-items: center;
  padding: 20px;
}

.operations-heading-icon,
.operations-metric svg {
  color: var(--accent);
}

.operations-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.operations-metric {
  display: grid;
  gap: 8px;
  min-height: 118px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: #ffffff;
  box-shadow: var(--shadow-soft);
}

.operations-metric span {
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
}

.operations-metric strong {
  font-size: 30px;
  line-height: 1;
}

.operations-split {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.operations-panel {
  padding: 18px;
}

.workspace-state {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px;
  color: var(--muted);
}

.workspace-state strong {
  display: block;
  color: var(--ink);
  font-size: 13px;
}

.workspace-state p {
  margin: 4px 0 0;
  font-size: 12px;
}

.is-spinning {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.filter-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin: 0 18px 14px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-subtle);
  color: var(--muted);
  font-size: 12px;
}

.filter-summary strong {
  color: var(--ink);
}
```

- [ ] **Step 5: Tighten responsive behavior**

Update mobile media queries so operational panels and tables do not overflow:

```css
@media (max-width: 980px) {
  .app-shell {
    grid-template-columns: 1fr;
  }

  .sidebar {
    position: relative;
    height: auto;
  }

  .topbar {
    align-items: stretch;
  }

  .inspection-layout,
  .operations-header,
  .operations-split {
    grid-template-columns: 1fr;
  }

  .topbar-actions,
  .toolbar {
    flex-wrap: wrap;
  }

  .global-search,
  .field {
    width: 100%;
  }

  .operations-grid,
  .inspection-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .operations-grid,
  .inspection-metrics,
  .operations-split {
    grid-template-columns: 1fr;
  }

  .record-page,
  .customer-page {
    padding: 14px;
  }
}
```

- [ ] **Step 6: Run frontend tests and build**

```bash
cd web/apps/staff
npm test -- --run
npm run build
```

Expected: PASS for both commands.

- [ ] **Step 7: Commit visual polish**

```bash
git add web/apps/staff/src/styles.css
git commit -m "style: apply clean operations ui polish"
```

## Task 5: Browser Verification And Final Fixes

**Files:**
- Modify only files needed to fix test or browser findings.

- [ ] **Step 1: Start or reuse the local preview**

If the current Vite preview at `http://127.0.0.1:5175/` is running, reuse it. If not, run:

```bash
cd web/apps/staff
npm run dev -- --host 127.0.0.1 --port 5175
```

Expected: Vite serves the staff app at `http://127.0.0.1:5175/`.

- [ ] **Step 2: Verify desktop in the browser**

Open `http://127.0.0.1:5175/` and verify:

- Dashboard renders first.
- Customers, Assets, Products, Reference Data, Inspections, Certificates, Sync Queue, and Audit are reachable from the sidebar.
- Topbar search navigates to Certificates when entering `certificate`.
- Notifications, Help, Environment, and User menu open visible popovers.
- Filter buttons open summaries.
- Download buttons trigger a CSV object URL.
- No text overlaps at 1280px width.

- [ ] **Step 3: Verify mobile in the browser**

Set the viewport to 390px wide and verify:

- Sidebar, topbar, operation cards, tables, and detail panels stack cleanly.
- No horizontal page overflow is present.
- Primary buttons and icon buttons remain tappable and readable.
- Popovers fit within the viewport.

- [ ] **Step 4: Run full verification**

```bash
cd web/apps/staff
npm test -- --run
npm run build
```

Expected: PASS.

- [ ] **Step 5: Final commit if verification fixes were required**

If Task 5 required code changes:

```bash
git add web/apps/staff/src
git commit -m "fix: stabilize clean operations ui"
```

If Task 5 did not require code changes, do not create an empty commit.
