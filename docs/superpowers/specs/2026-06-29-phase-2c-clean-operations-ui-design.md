# Phase 2C Clean Operations UI Design

## Status

Approved direction: **A. Clean Operations Console**

## Context

HMS 2.0 now has a React/Vite staff application with customer, asset, product, reference data, inspection, and certificate workspaces. The application is functional, but the UI still feels dense in places because many controls, metrics, rows, and detail values use the same boxed treatment. Several shell controls also look interactive without a complete user-facing result.

Phase 2C is a focused UI polish pass before Phase 3. It does not change the backend data model, does not introduce production data access, and does not add Phase 3 business modules.

## Options Considered

### A. Clean Operations Console

This direction uses a calm enterprise operations style: restrained color, stronger hierarchy, generous spacing, semantic icons, consistent motion, and polished empty/loading/error states. It keeps the app practical for inspection and certificate workflows while making it feel more premium.

### B. Dense Admin Console

This direction maximizes visible rows and compact controls. It is efficient for expert users, but it preserves the crowded feeling the redesign is intended to remove.

### C. Expressive Executive UI

This direction uses stronger visual effects and a more decorative presentation. It has more first-glance impact, but it risks distracting from operational workflows such as asset editing, inspections, and certificate review.

## Chosen Design

Use **Clean Operations Console** as the Phase 2C target.

The staff app remains React/Vite. `lucide-react` remains the single icon package so the UI does not mix visual languages. Styling remains in the existing staff app CSS unless a small local component extraction becomes necessary to reduce duplication.

## Scope

Phase 2C will improve the existing staff interface:

- Refine layout density in the sidebar, topbar, record pages, module panels, tables, forms, drawers, and detail panels.
- Standardize icon use for navigation, actions, filters, statuses, empty states, warnings, success, sync, audit, and certificate actions.
- Add consistent hover, active, pressed, disabled, focus, and reduced-motion behavior.
- Add reusable UI state treatments for loading, empty, error, success, and mock/backend source states.
- Make currently visible shell actions resolve to a clear UI behavior instead of inert controls where practical.
- Improve responsive behavior so mobile screens remain readable without cramped controls or accidental horizontal overflow.

Phase 2C will not implement real OIDC, real sync endpoints, Terraform, Helm, CI deployment, OpenTelemetry, or Phase 3 domain workflows.

## Component Design

### App Shell

The shell should feel like a quiet operations console. The sidebar remains dark for navigation contrast, but active states should be more refined and less heavy. The topbar should reduce visual clutter by grouping search, environment/source status, notifications, help, and user controls with consistent icon button sizing.

Visible nav items should either route to a real workspace or open a clear read-only operational state. Dashboard, Sync Queue, and Audit can be added as lightweight UI workspaces backed by local mock/read-only data until their real backend contracts are built.

### Workspaces

Customer, asset, product, reference data, inspection, and certificate pages should share one visual system for:

- Workspace headers
- Metric tiles
- Search and filter bars
- Primary and secondary actions
- Tables and row selection
- Detail panels
- Drawers and forms
- Status chips
- Empty and error states

The result should avoid nested-card visual noise. Page sections should read as structured work areas rather than many small floating boxes.

### Interactions

Buttons and links should provide visible feedback:

- Hover transitions for clickable controls
- Pressed state for buttons
- Keyboard focus rings
- Disabled state when an action is unavailable
- Smooth drawer/panel entrance where appropriate
- Respect for `prefers-reduced-motion`

Search inputs, filter buttons, tab controls, nav buttons, and close buttons should all have predictable visual and functional behavior.

## Data Flow

Phase 2C keeps the current data flow:

- Existing workspace hooks continue to load backend data when available.
- Mock fallback remains for local development when the backend is not running.
- New lightweight shell workspaces, if added, use local read-only mock data until backend APIs exist.
- No production scraping or production mutation is introduced.

## Error Handling And States

Each user-facing workspace should have a consistent state model:

- Loading: skeleton or quiet progress state that preserves layout.
- Empty: clear visual state with one relevant action only when that action already exists.
- Error: non-destructive message with retry where supported.
- Success/source: subtle backend/mock/source indicators.
- Disabled: visible and accessible disabled actions instead of inert buttons.

## Testing

Verification should include:

- Existing React unit tests.
- Focused tests for shell navigation and newly wired shell actions.
- Existing backend tests only if backend contracts are touched.
- Production build for the staff app.
- Browser verification on desktop and mobile widths, including no horizontal overflow and no obvious text overlap.

## Acceptance Criteria

- The staff UI visibly follows the Clean Operations Console direction.
- The app continues to use React/Vite and one icon package.
- Existing core workspaces remain reachable and functional.
- Visible primary shell controls have clear behavior.
- Loading, empty, error, selected, disabled, hover, and focus states are visually defined.
- Desktop and mobile layouts remain clean and readable.
- Automated tests and staff app build pass.
