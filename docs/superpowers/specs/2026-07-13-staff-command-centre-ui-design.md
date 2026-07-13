# HMS Staff Command Centre UI Design

**Status:** Approved  
**Date:** 2026-07-13  
**Scope:** React/Vite Staff and Admin web application only

## Objective

Modernize the HMS Staff/Admin console into a polished BAT Command Centre while
preserving its existing workflows, role permissions, API contracts, and refined
navy-and-blue identity. The result must feel like a purpose-built enterprise
operations product: clear, responsive, expressive, and efficient for repeated
daily use.

The Inspector web/native application is outside this scope.

## Selected Direction

The selected direction is **Command Centre**. It combines a stable enterprise
shell with a strongly prioritized operational dashboard and expressive, purposeful
motion. It intentionally avoids marketing-page composition, decorative effects,
oversized typography, excessive cards, and animation without operational meaning.

## Visual System

### Palette

- Preserve a deep BAT navy navigation surface and cobalt primary actions.
- Use solid colors instead of decorative gradients.
- Use white content panels over a cool neutral workspace background.
- Reserve red, amber, green, and cyan for operational meaning.
- Ensure text, controls, status colors, and focus states meet WCAG AA contrast.

### Typography

- Retain an enterprise sans-serif stack optimized for tables and form controls.
- Use compact headings and tabular numerals for operational metrics.
- Keep letter spacing at zero and avoid viewport-scaled typography.
- Establish a predictable hierarchy for page titles, section headings, labels,
  metadata, and table content.

### Shape, Borders, And Elevation

- Standardize component radii between 6px and 8px.
- Use one-pixel cool-grey borders as the primary panel separator.
- Use restrained shadows only for elevated overlays and selected priority panels.
- Avoid nested cards and floating page-section cards.

### Spacing

- Use an 8px spacing system with documented compact, standard, and spacious
  variants.
- Increase table-row and control breathing room without reducing useful data
  density.
- Define stable heights for toolbars, controls, table headers, badges, and KPI
  tiles to prevent layout shifts.

## Application Shell

- Increase the full sidebar to approximately 224px for readable labels and roles.
- Collapse the sidebar to an icon rail at intermediate widths.
- Use an accessible drawer below 820px, with focus management and escape handling.
- Keep role-aware navigation unchanged and hide unauthorized modules as today.
- Animate the active navigation indicator to preserve spatial continuity.
- Keep the top bar compact, placing global search first and grouping environment,
  create, notification, help, and user controls consistently.
- Retain Lucide icons and add tooltips to unfamiliar icon-only controls.

## Dashboard Composition

The desktop dashboard follows this hierarchy:

1. Four compact KPI tiles: Total Assets, In Service, Overdue, and Awaiting Review.
2. Overdue Retests as the primary work queue.
3. Fleet Health and Due This Week in a narrower right column.
4. Awaiting Review below Overdue Retests, aligned to the primary column instead
   of spanning or floating below unrelated content.

At narrower widths, the right column moves beneath the primary queue. KPI tiles
move from four to two to one column without changing their internal dimensions.

## Record Workspaces

- Apply the same toolbar, filter, status, table, pagination, loading, empty, and
  error patterns across Assets, Inspections, Certificates, Retest Schedule,
  Customers, Products, Reference Data, Users & Roles, Devices, and Audit Log.
- Preserve each module's current filters, actions, role checks, and API behavior.
- Make complete data rows clickable where the record can be opened, while retaining
  accessible explicit action controls.
- Open records as focused pages or wide detail drawers according to existing module
  architecture.
- Every detail view must expose a visible close control that returns to the exact
  originating list module and preserves filters, sorting, and pagination.
- Prevent action menus, row selection, and primary navigation from competing for
  the same click target.

## Forms And Overlays

- Standardize field labels, required indicators, helper text, validation, grouped
  sections, and footer actions.
- Use consistent drawers for create/edit workflows and dialogs for short,
  interruptive decisions.
- Use icon buttons for familiar close, download, refresh, filter, and overflow
  operations with accessible labels and tooltips.
- Preserve confirmation boundaries for destructive or externally visible actions.

## Motion Character

Motion is expressive but operational. Every animation must communicate hierarchy,
cause and effect, spatial continuity, feedback, or a meaningful state change.

### Motion Plan

| Surface | Trigger | Motion | Purpose | Reduced-motion behavior |
| --- | --- | --- | --- | --- |
| KPI strip | Initial dashboard render | Short opacity/translate stagger | Establish metric hierarchy | Instant opacity |
| KPI value | Data value changes | Controlled number interpolation | Communicate a changed metric | Immediate value |
| Module content | Navigation change | Short directional fade | Preserve navigation context | Instant swap |
| Active navigation | Module change | Shared layout indicator | Preserve sidebar continuity | Immediate indicator |
| Record row/detail | Open or close | Shared layout or coordinated transition | Show record origin and return | Instant page/drawer swap |
| Drawer/dialog | Mount or unmount | Fade with short slide/scale | Explain overlay location | Short opacity only |
| Menu/popover/toast | Mount or unmount | Fast fade and small translate | Confirm control response | Instant or short opacity |
| Chart | First render or filter change | Controlled path/value transition | Explain changed data | Static chart |
| Button | Press | Small scale/position response | Tactile confirmation | Color/state only |
| Loading state | Data resolves | Skeleton/content crossfade | Avoid abrupt replacement | Immediate replacement |

### Motion Tokens

- Fast interactions: approximately 160ms.
- Standard transitions: approximately 240ms.
- Complex entrances or shared-layout movement: approximately 360ms.
- Exits must be faster than entrances.
- Use small movement distances and avoid large zoom, rotation, blur, parallax, or
  continuous decorative animation.

## Technical Architecture

- Add the official `motion` package and import React APIs from `motion/react`.
- Use `LazyMotion` so the production bundle loads only the required Motion feature
  set.
- Centralize animation values in `motionTokens` rather than scattering arbitrary
  durations and easing curves.
- Introduce only a small reusable motion layer: `MotionProvider`, page transition,
  stagger group, pressable control, and presence wrapper.
- Use direct Motion components where an abstraction would obscure behavior.
- Refactor the oversized stylesheet into focused token, shell, component, module,
  and responsive layers while preserving existing class contracts during migration.
- Do not change backend APIs, authentication contracts, domain types, or persistence
  as part of this visual project.

## Accessibility

- Respect `prefers-reduced-motion` globally and in every Motion component.
- Preserve keyboard access, visible focus states, semantic tables, labels, status
  announcements, dialog focus trapping, and escape-to-close behavior.
- Do not hide content or required actions behind animation.
- Ensure touch targets are at least 44px on mobile layouts.
- Verify that text, controls, tables, badges, and toolbars do not overlap or truncate
  essential information at supported breakpoints.

## Error, Empty, And Loading States

- Use consistent inline error states close to the failed workflow, with retry where
  retry is meaningful.
- Use quiet, action-oriented empty states that explain the record set without
  feature-marketing copy.
- Use stable skeletons matching final layout dimensions for data-heavy screens.
- Display success feedback near its originating action and remove it after an
  appropriate interval unless the user must retain it.
- Never replace real API errors with mock data silently.

## Delivery Sequence

1. Install Motion, define tokens and primitives, and update the application shell.
2. Implement the Command Centre dashboard composition and motion.
3. Apply shared list, toolbar, table, filter, detail, form, and overlay treatments.
4. Upgrade customer/product/reference and system/admin modules.
5. Complete responsive, accessibility, reduced-motion, and cross-browser polish.

Each stage must remain independently testable and must not leave a partially
migrated interaction without its existing functional fallback.

## Verification

- Run the complete Staff Vitest suite and TypeScript/Vite production build.
- Add focused tests for motion-aware navigation, drawers, dialogs, detail return
  paths, and reduced-motion fallbacks.
- Run browser workflows for authentication, dashboard navigation, record lists,
  record details, create/edit forms, filters, and role-restricted navigation.
- Capture and inspect desktop, tablet, and mobile screenshots.
- Check browser console errors and verify nonblank rendering after every major stage.
- Verify keyboard-only operation, focus order, escape behavior, readable overflow,
  and `prefers-reduced-motion` behavior.
- Treat the existing role and workflow tests as regression gates.

## Acceptance Criteria

- The Staff/Admin console consistently follows the Command Centre visual system.
- Existing role-aware workflows and API-backed behavior remain operational.
- Dashboard content follows the approved hierarchy at desktop and responsive sizes.
- Motion is implemented with Motion, uses centralized tokens, and has meaningful
  reduced-motion fallbacks.
- Record detail close behavior returns users to the originating list state.
- All existing and added tests pass, production build succeeds, and browser review
  finds no incoherent overlap, clipped critical text, or console errors.
