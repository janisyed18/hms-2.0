# BAT Operations Console UI Refinement

**Status:** Approved design
**Date:** 2026-07-16

## Goal

Make the existing staff application feel like one coherent operations console at desktop, tablet, and mobile widths without replacing the current React/Vite stack or inventing a second design system.

## Existing constraints

- Reuse the current `AppShell`, `WorkspaceState`, `SourceBadge`, module table, token, responsive, and Motion primitives.
- Preserve the approved dark navy sidebar and light work canvas.
- Keep existing record workflows and API contracts intact.
- Do not modify production data while validating the UI.
- Prefer CSS and existing dependencies over new packages.

## Design decisions

### 1. Responsive shell

At the current tablet breakpoint, the top bar will become a deliberate two-row layout before controls become compressed. Page titles remain readable, global search keeps a usable input, and secondary actions can compact only after the primary action remains available. The mobile navigation drawer remains the existing pattern.

### 2. Shared record-page grammar

Assets, inspections, certificates, customers, and products will use the same visual order:

1. page heading and primary action
2. search and filters
3. source/loading/error state
4. record count and table/card content
5. pagination or clear empty state

Tables will scroll within their own surface when needed. Headers and actions will not be clipped by the viewport.

### 3. Honest data states

Loading, backend data, demo data, empty results, and errors will be visually distinct. A page will not present a temporary mock/empty result as final while its backend request is still settling. Existing fallback behavior remains available, but its state must be explicit.

### 4. Detail and drawer behavior

Record selection will preserve the originating list context. Opening a record shows its detail view; closing or using back returns to the list. Existing inspection draft detail and submit behavior will be retained and given consistent responsive spacing, validation, loading, and error presentation.

### 5. Visual hierarchy and motion

- Keep 8px-or-less radii, restrained borders, and low-elevation shadows.
- Reduce repetitive card weight on customer pages while keeping scan-friendly metrics.
- Keep dashboard Awaiting Review full width as a review queue.
- Use existing Motion primitives for short page, drawer, and feedback transitions.
- Respect `prefers-reduced-motion`.
- Keep icon-only actions accessible with labels/tooltips and preserve keyboard focus.

## Out of scope

- New UI framework or component library.
- New charting, data fetching, routing, or state-management architecture.
- New production features unrelated to the observed UI issues.
- Replacing mock fallback data or changing backend records.

## Acceptance criteria

- At the current 1024px viewport, page titles, search, environment status, notifications, user menu, and primary actions remain usable without awkward wrapping or clipping.
- Assets and inspections show an explicit loading/source/empty/error state and no misleading transient mock empty state.
- Module tables remain readable inside their own overflow region.
- Customer cards, dashboard sections, and inspection drawers use consistent spacing and visual hierarchy.
- Existing open/close/detail/submit workflows continue to work.
- Frontend tests, lint, production build, and browser smoke checks pass.
