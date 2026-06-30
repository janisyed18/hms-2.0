# BAT Operations Console Redesign

**Status:** Approved visual direction, awaiting implementation plan  
**Date:** 2026-06-30  
**Project:** HMS 2.0 staff web app  
**Accepted direction:** Recommended BAT Operations Console  
**Visual companion:** `.superpowers/brainstorm/14781-1782798586/content/hms-redesign-directions.html`

## Objective

Redesign the HMS 2.0 staff UI into a cleaner enterprise operations console inspired by the supplied references, while preserving the existing React/Vite app, current module structure, existing backend integration points, and current mock-data fallback behavior.

The redesign should make the product feel like a premium operations platform for hose asset management: dark left navigation, quiet white topbar, pale blue-gray workspace, dense table-first modules, strong status pills, card-based operational summaries, and consistent action placement.

## Target Users

Primary users are HMS staff/admin users who review assets, inspections, certificates, customers, products, reference data, sync activity, and audit history. The UI should prioritise fast scanning, repeated daily operations, and clear escalation states over marketing-style presentation.

## Design Direction

The selected direction is **BAT Operations Console**:

- Use the supplied screenshots as the baseline visual language.
- Improve on the reference by adapting the information architecture to HMS rather than copying generic mock content.
- Keep the interface restrained, premium, and work-focused.
- Prefer dense tables and operational panels over decorative cards.
- Use status colour only to communicate state: healthy, due soon, overdue, failed, submitted, approved, issued, queued.
- Preserve React/Vite and the existing component/workspace boundaries.

## App Shell

The global shell will move closer to the reference screenshots:

- Fixed dark navy sidebar with BAT HMS branding and version text.
- Grouped navigation sections:
  - Overview: Dashboard, Analytics
  - Operations: Assets, Inspections, Certificates, Retest Schedule
  - Management: Customers, Products, Reference Data
  - System: Users & Roles, Devices, Audit Log
- Existing implemented modules remain wired:
  - Dashboard maps to current `dashboard`
  - Assets maps to current `assets`
  - Inspections maps to current `inspections`
  - Certificates maps to current `certificates`
  - Customers maps to current `customers`
  - Products maps to current `products`
  - Reference Data maps to current `reference`
  - Audit Log maps to current `audit`
  - Sync Queue remains available as a system/operations item if retained in scope
- Items not yet implemented should be visibly disabled or routed to a clean empty state, not dead links.
- Sidebar includes a global search field and bottom user block.
- Topbar is simple: page title on left, notifications/refresh and primary action on right.

## Dashboard Screen

Dashboard should become the primary operational summary screen:

- KPI cards:
  - Total Assets
  - In Service
  - Overdue
  - Pending Review
- Main table panel:
  - Overdue Retests
  - Asset, customer, product, due date, days overdue, status
  - Export action
  - Escalation action as a UI control only unless backend behavior exists
- Right-side operational panels:
  - Fleet Health ring chart
  - Due This Week list
- Lower panel:
  - Awaiting Review inspections

The dashboard can use mock aggregate values for now. It must not imply real data mutation unless a currently implemented endpoint exists.

## Asset Register

Assets should become a table-first register similar to the reference:

- Header search row with asset/customer/product/status filters.
- Export/import controls where export is already supported; import can be disabled or omitted unless implemented.
- Table columns:
  - Asset ID
  - Customer
  - Product
  - Bore
  - End A / End B
  - Location
  - Retest Due
  - Lifecycle
  - Row actions
- Status pills for overdue, due, in service, condemned, and draft states.
- Existing asset create/edit and A/B end editor flows remain accessible.

## Inspection Management

Inspections should use tabbed status navigation:

- Tabs:
  - All
  - Submitted
  - Approved
  - Rejected/Failed if represented in current data
- Table columns:
  - Inspection ID
  - Asset
  - Type
  - Inspector
  - Submitted
  - Pressure Test
  - Status
  - Review/View action
- Existing create-from-asset, detail, status flow, and pressure result entry remain available.
- Visual emphasis goes to submitted and failed rows.

## Certificate Management

Certificates should use a compact certification table:

- Tabs:
  - All Certificates
  - Pending Issue
  - Revoked if represented in current data
- Bulk Generate appears only as a UI action if it maps to implemented behavior; otherwise it should be omitted or disabled.
- Table columns:
  - Certificate
  - Asset
  - Customer
  - Inspection
  - Issued
  - Valid Until
  - Verification
  - Download/Open action
- Existing issue certificate flow remains intact.

## Customer Management

Customers should move to a simpler management view:

- Search customers input.
- Add Customer action remains wired to the existing customer form.
- Customer cards for demo-level customer browsing:
  - Initials/avatar
  - Customer name and code
  - Active state
  - Asset count
  - Overdue/due count
  - Site/location count if available
- If the current detail panel remains, it should follow the new visual system and not exceed viewport width.

## Products And Reference Data

Products and reference data should inherit the same shell and table system:

- Compact page header.
- Search/filter toolbar.
- Table panel with consistent header, rows, status chips, and action buttons.
- Existing product pressure-matrix editor remains accessible and styled in the same component system.
- Existing reference-data editor remains accessible and styled in the same component system.

## Visual System

Core tokens:

- App background: pale blue-gray `#eef3fa` or close equivalent.
- Sidebar: deep navy `#0d182d` with selected item `#18335f`.
- Surface: white `#ffffff`.
- Border: cool gray-blue `#d9e3f2`.
- Primary action: blue `#2563eb`.
- Success: green `#059669`.
- Warning: amber `#f59e0b`.
- Danger: red `#ef4444`.
- Text: navy/slate `#182235`.
- Muted text: `#71819a` and `#94a3b8`.

Typography:

- Continue system/Inter-style sans-serif.
- Use compact admin typography, not large marketing headings.
- Sidebar, table headers, chips, and controls need explicit sizes and weights.
- No viewport-width font scaling.

Component style:

- Cards/panels use 10-14px radius, subtle border, low shadow.
- Tables use uppercase muted headers, monospaced asset/certificate IDs, and stable row heights.
- Buttons use icon + label where action meaning benefits from it.
- Icon system remains lucide-react, tuned to 1.8-2px stroke weight.
- Motion is subtle: hover lift, fade/slide for drawers/popovers, reduced-motion support.

## Responsiveness

Desktop:

- Sidebar remains fixed.
- Tables remain primary; horizontal scrolling is allowed inside table frames only, not the whole page.
- Main dashboards use two-column layouts when space allows.

Mobile:

- Sidebar converts to compact/icon or stacked layout.
- Topbar controls stack cleanly.
- Dashboard panels collapse to one column.
- Tables scroll inside their own frame without document-level horizontal overflow.
- Text must not overlap or overflow buttons/cards.

## Data And Behavior

This redesign is a UI layer change unless an existing hook/API already supports a behavior.

- Existing hooks remain the source of module data.
- Existing mock fallback remains.
- No production HMS data is touched.
- No new backend mutation should be implied by UI copy unless the current app already implements it.
- Export actions can stay client-side where already implemented.
- Disabled or empty-state handling is required for unimplemented nav items.

## Component Architecture

Implementation should avoid one-off markup and move toward shared primitives:

- `AppShell`: sidebar, topbar, grouped nav, global search, user block.
- `ConsolePage`: common page spacing and header composition.
- `MetricCard`: dashboard KPI cards.
- `StatusPill`: shared semantic status rendering.
- `DataPanel`: table/card panel frame.
- `FilterBar`: search and select controls.
- `ConsoleTable`: shared table styling wrapper around existing data tables.
- Module-specific workspaces remain responsible for their own data and actions.

Existing components can be refactored only where needed to support the design system. Unrelated backend or data-model changes are out of scope.

## Accessibility

- Navigation buttons must have clear accessible names.
- Icon-only controls require labels.
- Tabs and filter controls must be keyboard reachable.
- Focus states must remain visible.
- Disabled controls must be visibly disabled and non-interactive.
- Status colour must be paired with text labels.

## Verification Plan

Implementation must be verified with:

- `npm test -- --run`
- `npm run build`
- Browser/IAB visual QA against the accepted direction.
- Desktop viewport check around 1366x900.
- Mobile viewport check around 390x844.
- No document-level horizontal overflow.
- No relevant browser console errors or warnings.
- Core interaction checks:
  - Sidebar navigation
  - Dashboard view
  - Asset register view
  - Inspection tabs/detail entry path
  - Certificate table/issue path
  - Customer search/add path
  - Popovers and disabled/empty states

## Out Of Scope

- Real OIDC auth integration.
- Backend schema changes.
- Data migration.
- New production data scraping.
- Real import, escalation, bulk-generate, users/roles, device, analytics, or retest-schedule backend features unless already implemented locally.
- Replacing React/Vite with Angular.

## Acceptance Criteria

The redesign is complete when:

- The app visually matches the BAT Operations Console direction across the implemented modules.
- The shell, dashboard, assets, inspections, certificates, customers, products, reference data, audit/sync states all share the same visual system.
- Existing tests pass and build succeeds.
- Browser QA confirms desktop and mobile layouts without page-level overflow.
- Existing working flows remain working.
- Unimplemented items are not presented as live production features.
