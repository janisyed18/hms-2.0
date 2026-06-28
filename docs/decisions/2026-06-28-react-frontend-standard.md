# React Frontend Standard

Date: 2026-06-28

## Decision

HMS 2.0 will use React + TypeScript for all frontend surfaces.

- Staff/admin web: React + Vite.
- Customer web: React + Vite unless a later deployment decision requires Next.js.
- Mobile inspector app: Ionic React + Capacitor.
- UI primitives: package-backed components and accessibility primitives where
  practical.
- Icons: package-backed icons, currently `lucide-react`, unless the BAT brand mark
  or a domain-specific asset requires a custom vector.

## Reasoning

The first staff UI slice is already implemented in React/Vite with a premium
operations-shell design, tests, and API client structure. Keeping all frontends on
React avoids running parallel Angular and React patterns, reduces design-system
duplication, and keeps frontend tests and component conventions consistent.

## Consequences

The original HMS prompt references Angular for the admin app and Ionic Angular for
mobile. This repository supersedes that direction: use React for web and Ionic
React for mobile going forward.
