# HMS Staff Command Centre UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved Command Centre visual system and purposeful Motion interactions across the HMS Staff/Admin React application without changing its backend contracts or role-aware behavior.

**Architecture:** Add one centralized Motion configuration and a small set of reusable primitives, then migrate the shell, dashboard, shared record surfaces, and admin modules in dependency order. Existing workspace hooks and API clients remain unchanged; visual state and transitions stay inside presentation components so domain behavior remains testable without animation.

**Tech Stack:** React 19, TypeScript, Vite, Motion for React (`motion/react`), Lucide React, CSS custom properties, Vitest, Testing Library, Playwright.

---

## File Map

**Create**

- `web/apps/staff/src/motion/motionTokens.ts` — canonical durations, easing, springs, and reduced-motion helpers.
- `web/apps/staff/src/motion/MotionProvider.tsx` — `LazyMotion` boundary for the app.
- `web/apps/staff/src/motion/MotionPrimitives.tsx` — page, stagger, press, and presence primitives.
- `web/apps/staff/src/styles/tokens.css` — palette, typography, spacing, radius, elevation, and component dimensions.
- `web/apps/staff/src/styles/shell.css` — desktop shell, sidebar, topbar, and mobile drawer.
- `web/apps/staff/src/styles/command-centre.css` — dashboard, shared panels, tables, status, and overlay treatment.
- `web/apps/staff/src/styles/responsive.css` — breakpoint and reduced-motion overrides.
- `web/apps/staff/src/__tests__/MotionPrimitives.test.tsx` — reduced-motion and primitive contracts.
- `web/apps/staff/src/__tests__/CommandCentreShell.test.tsx` — shell navigation and mobile drawer behavior.

**Modify**

- `web/apps/staff/package.json` and `web/apps/staff/package-lock.json` — add `motion`.
- `web/apps/staff/src/main.tsx` — import CSS layers and add `MotionProvider`.
- `web/apps/staff/src/styles.css` — retain module-specific legacy rules during migration and remove duplicated shell/token rules.
- `web/apps/staff/src/App.tsx` — apply module page presence without changing role/module routing.
- `web/apps/staff/src/components/AppShell.tsx` — Command Centre shell and responsive drawer.
- `web/apps/staff/src/components/OperationalWorkspace.tsx` — approved dashboard hierarchy and metric motion.
- `web/apps/staff/src/components/ModuleTable.tsx` — shared row interaction and stable status/action layout.
- `web/apps/staff/src/components/WorkspaceState.tsx` — consistent loading, empty, error, and success presentation.
- `web/apps/staff/src/components/AssetsWorkspace.tsx`, `AssetDetail.tsx`, `AssetForm.tsx`, and `AssetEndEditor.tsx` — asset list/detail/form treatments.
- `web/apps/staff/src/components/InspectionsWorkspace.tsx`, `InspectionDetail.tsx`, and `InspectionForm.tsx` — inspection list/detail/form treatments.
- `web/apps/staff/src/components/CertificatesWorkspace.tsx`, `CertificateDetail.tsx`, and `CertificateForm.tsx` — certificate list/detail/form treatments.
- `web/apps/staff/src/components/CustomerTable.tsx`, `CustomerDetail.tsx`, and `CustomerForm.tsx` — customer record treatments.
- `web/apps/staff/src/components/ProductsWorkspace.tsx`, `ProductDetail.tsx`, and `ProductForm.tsx` — product record treatments.
- `web/apps/staff/src/components/ReferenceWorkspace.tsx`, `ReferenceForm.tsx`, `RetestScheduleWorkspace.tsx`, and `RetestScheduleDetail.tsx` — reference and schedule treatments.
- `web/apps/staff/src/__tests__/App.test.tsx`, `RoleNavigation.test.tsx`, `UserAdministration.test.tsx`, and `AuthFlow.test.tsx` — preserve role, workflow, and return-path contracts.
- `web/apps/staff/e2e/staff-auth.spec.ts` — retain auth coverage and add motion-independent shell assertions.

## Task 1: Install Motion And Establish The App Boundary

**Files:**
- Modify: `web/apps/staff/package.json`
- Modify: `web/apps/staff/package-lock.json`
- Create: `web/apps/staff/src/motion/MotionProvider.tsx`
- Modify: `web/apps/staff/src/main.tsx`
- Test: `web/apps/staff/src/__tests__/AppGating.test.tsx`

- [ ] **Step 1: Add a failing provider-boundary assertion**

Extend the app-gating test with a render assertion that the application remains
usable when `matchMedia('(prefers-reduced-motion: reduce)')` returns true:

```tsx
it("renders authentication with reduced motion enabled", () => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  }));

  render(<App />);
  expect(screen.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
```

- [ ] **Step 2: Run the focused test before adding Motion**

Run: `cd web/apps/staff && npm test -- --run src/__tests__/AppGating.test.tsx`

Expected: the existing app passes, establishing the behavior that the provider must preserve.

- [ ] **Step 3: Install Motion**

Run: `cd web/apps/staff && npm install motion`

Expected: `motion` appears in dependencies and the lockfile changes only for Motion and its required packages.

- [ ] **Step 4: Add the lazy feature boundary**

```tsx
// src/motion/MotionProvider.tsx
import { LazyMotion, domAnimation } from "motion/react";
import type { ReactNode } from "react";

export function MotionProvider({ children }: { children: ReactNode }) {
  return <LazyMotion features={domAnimation}>{children}</LazyMotion>;
}
```

Wrap `<App />` in `main.tsx`:

```tsx
root.render(
  <StrictMode>
    <MotionProvider>
      <App />
    </MotionProvider>
  </StrictMode>
);
```

- [ ] **Step 5: Verify and commit**

Run: `cd web/apps/staff && npm test -- --run src/__tests__/AppGating.test.tsx && npm run build`

Expected: focused tests and production build pass.

Commit: `feat(staff): add Motion application boundary`

## Task 2: Define Motion Tokens And Primitives

**Files:**
- Create: `web/apps/staff/src/motion/motionTokens.ts`
- Create: `web/apps/staff/src/motion/MotionPrimitives.tsx`
- Create: `web/apps/staff/src/__tests__/MotionPrimitives.test.tsx`

- [ ] **Step 1: Write failing primitive tests**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MotionProvider } from "../motion/MotionProvider";
import { PageMotion, StaggerGroup } from "../motion/MotionPrimitives";

describe("Command Centre motion primitives", () => {
  it("never hides page content from assistive technology", () => {
    render(<MotionProvider><PageMotion><h1>Assets</h1></PageMotion></MotionProvider>);
    expect(screen.getByRole("heading", { name: "Assets" })).toBeVisible();
  });

  it("preserves all staggered children", () => {
    render(<MotionProvider><StaggerGroup><span>One</span><span>Two</span></StaggerGroup></MotionProvider>);
    expect(screen.getByText("One")).toBeVisible();
    expect(screen.getByText("Two")).toBeVisible();
  });
});
```

- [ ] **Step 2: Run tests and confirm missing-module failure**

Run: `cd web/apps/staff && npm test -- --run src/__tests__/MotionPrimitives.test.tsx`

Expected: FAIL because the motion token and primitive modules do not exist.

- [ ] **Step 3: Add centralized tokens**

```ts
export const motionTokens = {
  duration: { fast: 0.16, normal: 0.24, slow: 0.36 },
  ease: {
    enter: [0.16, 1, 0.3, 1] as const,
    exit: [0.4, 0, 1, 1] as const
  },
  spring: {
    gentle: { type: "spring" as const, stiffness: 240, damping: 28 },
    snappy: { type: "spring" as const, stiffness: 420, damping: 34 }
  },
  distance: { page: 10, overlay: 14 }
} as const;
```

- [ ] **Step 4: Add focused primitives**

Implement `PageMotion`, `StaggerGroup`, `StaggerItem`, `PresencePanel`, and
`Pressable` using `m`, `AnimatePresence`, and `useReducedMotion`. Translation and
stagger must become opacity-only or instant when reduced motion is requested. The
public shape is:

```tsx
export function PageMotion({ children, motionKey }: MotionChildrenProps & { motionKey?: string })
export function StaggerGroup({ children, className }: MotionChildrenProps)
export function StaggerItem({ children, className }: MotionChildrenProps)
export function PresencePanel({ children, presenceKey, className }: MotionChildrenProps & { presenceKey: string })
export function Pressable({ children, className, onClick, type = "button" }: PressableProps)
```

Each primitive must render semantic HTML (`section`, `div`, or `button`) and must
not add a second interactive element around interactive children.

- [ ] **Step 5: Verify and commit**

Run: `cd web/apps/staff && npm test -- --run src/__tests__/MotionPrimitives.test.tsx && npm run build`

Expected: tests and build pass.

Commit: `feat(staff): add Command Centre motion primitives`

## Task 3: Establish CSS Tokens And Layered Styles

**Files:**
- Create: `web/apps/staff/src/styles/tokens.css`
- Create: `web/apps/staff/src/styles/shell.css`
- Create: `web/apps/staff/src/styles/command-centre.css`
- Create: `web/apps/staff/src/styles/responsive.css`
- Modify: `web/apps/staff/src/main.tsx`
- Modify: `web/apps/staff/src/styles.css`

- [ ] **Step 1: Add the approved token set**

Define solid BAT colors, semantic status colors, 8px spacing values, 6–8px radii,
restrained shadows, focus ring, sidebar dimensions, toolbar height, and stable
control dimensions. Include `font-variant-numeric: tabular-nums` for metrics.

- [ ] **Step 2: Import CSS in deterministic cascade order**

```ts
import "./styles/tokens.css";
import "./styles.css";
import "./styles/shell.css";
import "./styles/command-centre.css";
import "./styles/responsive.css";
```

- [ ] **Step 3: Move duplicate shell/token rules out of `styles.css`**

Move only rules whose selectors are owned by the shell or approved shared
components. Leave module-specific rules in place until their migration task.
Run `rg` after each move to ensure each migrated selector has one owner.

- [ ] **Step 4: Add reduced-motion CSS fallback**

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
```

- [ ] **Step 5: Verify and commit**

Run: `cd web/apps/staff && npm test -- --run && npm run build`

Expected: all current tests and production build pass with no CSS import errors.

Commit: `style(staff): establish Command Centre design tokens`

## Task 4: Rebuild The Application Shell

**Files:**
- Modify: `web/apps/staff/src/components/AppShell.tsx`
- Modify: `web/apps/staff/src/App.tsx`
- Create: `web/apps/staff/src/__tests__/CommandCentreShell.test.tsx`
- Modify: `web/apps/staff/src/__tests__/RoleNavigation.test.tsx`

- [ ] **Step 1: Write failing responsive-shell tests**

Cover: authorized navigation remains visible, unauthorized navigation remains
absent, mobile menu opens and closes, escape closes the drawer, and module content
remains reachable without waiting for animation.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `cd web/apps/staff && npm test -- --run src/__tests__/CommandCentreShell.test.tsx src/__tests__/RoleNavigation.test.tsx`

Expected: FAIL because the responsive drawer and motion contracts do not exist.

- [ ] **Step 3: Implement the 224px shell and mobile drawer**

Add a menu button below the desktop breakpoint, retain semantic `<nav>`, use
`AnimatePresence` for the drawer and backdrop, and close on module change, escape,
or backdrop activation. Keep `visibleModules` as the sole authorization source.

- [ ] **Step 4: Add module page presence**

Wrap only the active module content in `PageMotion` keyed by the effective module.
Do not remount `AuthProvider`, workspace hooks, or shell state when modules change.

- [ ] **Step 5: Verify and commit**

Run: `cd web/apps/staff && npm test -- --run src/__tests__/CommandCentreShell.test.tsx src/__tests__/RoleNavigation.test.tsx src/__tests__/App.test.tsx && npm run build`

Expected: shell, role, app, and build checks pass.

Commit: `feat(staff): rebuild Command Centre application shell`

## Task 5: Implement The Approved Dashboard Hierarchy

**Files:**
- Modify: `web/apps/staff/src/components/OperationalWorkspace.tsx`
- Modify: `web/apps/staff/src/__tests__/App.test.tsx`
- Modify: `web/apps/staff/src/styles/command-centre.css`

- [ ] **Step 1: Write a failing dashboard-order test**

Assert four KPI tiles render first, Overdue Retests precedes Awaiting Review in the
primary column, and Fleet Health plus Due This Week appear in the side column.
Assert buttons preserve their existing handlers.

- [ ] **Step 2: Run the dashboard test to verify failure**

Run: `cd web/apps/staff && npm test -- --run src/__tests__/App.test.tsx -t "operations dashboard"`

Expected: FAIL on the new approved hierarchy assertion.

- [ ] **Step 3: Recompose dashboard markup**

Create a KPI strip, `dashboard-primary` containing Overdue Retests then Awaiting
Review, and `dashboard-side` containing Fleet Health then Due This Week. Preserve
all existing data and callbacks.

- [ ] **Step 4: Add meaningful dashboard motion**

Use `StaggerGroup` for the four KPIs, `StaggerItem` for each tile, and Motion SVG
or numeric interpolation only for first render or data changes. Do not animate
large tables row-by-row.

- [ ] **Step 5: Verify and commit**

Run: `cd web/apps/staff && npm test -- --run src/__tests__/App.test.tsx && npm run build`

Expected: app tests and build pass.

Commit: `feat(staff): deliver Command Centre dashboard`

## Task 6: Upgrade Shared Tables And Workspace States

**Files:**
- Modify: `web/apps/staff/src/components/ModuleTable.tsx`
- Modify: `web/apps/staff/src/components/WorkspaceState.tsx`
- Modify: `web/apps/staff/src/components/AssetsWorkspace.tsx`
- Modify: `web/apps/staff/src/components/InspectionsWorkspace.tsx`
- Modify: `web/apps/staff/src/components/CertificatesWorkspace.tsx`
- Modify: `web/apps/staff/src/components/RetestScheduleWorkspace.tsx`
- Modify: `web/apps/staff/src/components/CustomerTable.tsx`
- Modify: `web/apps/staff/src/components/ProductsWorkspace.tsx`
- Modify: `web/apps/staff/src/components/ReferenceWorkspace.tsx`
- Modify: `web/apps/staff/src/styles/command-centre.css`
- Test: existing module tests in `web/apps/staff/src/__tests__/App.test.tsx`

- [ ] **Step 1: Add failing accessibility and state assertions**

Assert loading, empty, and error states remain announced; actionable rows support
keyboard activation; overflow menus do not trigger row open; and status text is
available independently of color.

- [ ] **Step 2: Run module tests to verify failure**

Run: `cd web/apps/staff && npm test -- --run src/__tests__/App.test.tsx`

Expected: new shared interaction assertions fail.

- [ ] **Step 3: Implement shared table and state contracts**

Use stable row heights, visible hover/focus/selected states, semantic status pills,
fixed action columns, and consistent skeleton/error/empty layouts. Preserve sorting,
filtering, pagination, exports, and API calls.

- [ ] **Step 4: Add restrained state transitions**

Use `AnimatePresence` only around loading/error/empty/content replacement and menus.
Do not animate every table row or block pointer and keyboard input.

- [ ] **Step 5: Verify and commit**

Run: `cd web/apps/staff && npm test -- --run && npm run build`

Expected: full Staff suite and build pass.

Commit: `style(staff): unify record workspace surfaces`

## Task 7: Standardize Details, Forms, Dialogs, And Admin Surfaces

**Files:**
- Modify: `web/apps/staff/src/components/AssetDetail.tsx`
- Modify: `web/apps/staff/src/components/AssetForm.tsx`
- Modify: `web/apps/staff/src/components/AssetEndEditor.tsx`
- Modify: `web/apps/staff/src/components/InspectionDetail.tsx`
- Modify: `web/apps/staff/src/components/InspectionForm.tsx`
- Modify: `web/apps/staff/src/components/CertificateDetail.tsx`
- Modify: `web/apps/staff/src/components/CertificateForm.tsx`
- Modify: `web/apps/staff/src/components/CustomerDetail.tsx`
- Modify: `web/apps/staff/src/components/CustomerForm.tsx`
- Modify: `web/apps/staff/src/components/ProductDetail.tsx`
- Modify: `web/apps/staff/src/components/ProductForm.tsx`
- Modify: `web/apps/staff/src/components/ReferenceForm.tsx`
- Modify: `web/apps/staff/src/components/RetestScheduleDetail.tsx`
- Modify: `web/apps/staff/src/components/SystemWorkspace.tsx`
- Modify: `web/apps/staff/src/components/UserAdminDialog.tsx`
- Modify: `web/apps/staff/src/components/OneTimeCredentialDialog.tsx`
- Modify: `web/apps/staff/src/auth/AuthFlow.tsx`
- Modify: `web/apps/staff/src/__tests__/UserAdministration.test.tsx`
- Modify: `web/apps/staff/src/__tests__/AuthFlow.test.tsx`

- [ ] **Step 1: Add failing close/return and dialog tests**

Assert every record detail close returns to the originating module without clearing
list state. Assert escape closes non-destructive dialogs, initial focus moves into
dialogs, and role restrictions remain enforced in user administration.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `cd web/apps/staff && npm test -- --run src/__tests__/UserAdministration.test.tsx src/__tests__/AuthFlow.test.tsx src/__tests__/App.test.tsx`

Expected: new overlay/return assertions fail before standardization.

- [ ] **Step 3: Apply shared overlay structure**

Use a consistent header, body, and footer; a visible Lucide `X` close control;
accessible labels; and `AnimatePresence` with reduced-motion fallbacks. Keep
confirmation boundaries for archive, revoke, password reset, MFA reset, certificate
issue/revoke, inspection submit/approve/reject, and notification escalation.

- [ ] **Step 4: Apply form and admin visual treatment**

Standardize field spacing, labels, required markers, inline validation, role/status
badges, action menus, and one-time credential presentation without changing API
payloads or authorization logic.

- [ ] **Step 5: Verify and commit**

Run: `cd web/apps/staff && npm test -- --run && npm run build`

Expected: full suite and build pass.

Commit: `style(staff): standardize record and admin interactions`

## Task 8: Responsive, Reduced-Motion, And Browser Verification

**Files:**
- Modify: `web/apps/staff/src/styles/responsive.css`
- Modify: `web/apps/staff/e2e/staff-auth.spec.ts`
- Create: `web/apps/staff/e2e/command-centre.spec.ts`

- [ ] **Step 1: Add browser assertions independent of animation timing**

Assert shell navigation, authentication, dashboard, record open/close, and logout
using visible end states rather than sleeps or animation duration assumptions.

- [ ] **Step 2: Implement final responsive rules**

Verify desktop, 1024px tablet, 820px breakpoint, and 390px mobile layouts. Ensure
tables scroll within bounded containers, controls wrap without overlap, touch targets
reach 44px, and mobile drawers do not obscure dialogs.

- [ ] **Step 3: Run complete automated verification**

Run:

```bash
cd web/apps/staff
npm test -- --run
npm run build
npm run test:e2e
```

Expected: all unit tests, production build, and Playwright journeys pass.

- [ ] **Step 4: Perform visual and accessibility inspection**

Start the Vite server, inspect dashboard and representative list/detail/form/admin
screens at desktop, tablet, and mobile sizes, check browser console errors, and
repeat key workflows with reduced motion enabled.

- [ ] **Step 5: Run repository regression gates and commit**

Run the repository's backend tests only as a contract regression check if no backend
files changed; record that result separately from Staff UI verification.

Commit: `test(staff): verify Command Centre UI across breakpoints`

## Completion Gate

- [ ] Every approved spec section maps to a completed task above.
- [ ] `motion` is the only newly introduced animation library.
- [ ] Full Staff tests, TypeScript build, and browser journeys pass.
- [ ] Role-based navigation and administration tests remain green.
- [ ] Desktop, tablet, mobile, keyboard, and reduced-motion reviews pass.
- [ ] No backend API or persistence contract changed.
- [ ] Final diff contains no unrelated refactors or generated artifacts.
