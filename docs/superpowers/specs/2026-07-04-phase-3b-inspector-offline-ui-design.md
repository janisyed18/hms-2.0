# Phase 3B Inspector Offline UI

**Status:** Implemented for the browser/mobile-web development slice
**Date:** 2026-07-04  
**Project:** HMS 2.0 inspector app  
**Accepted direction:** Queue-first Field Console  
**Visual companion:** `.superpowers/brainstorm/42892-1783129401/content/phase-3b-layout-options.html`  
**Concept reference:** Generated queue-first mobile concept shown during approval

## Objective

Build a separate inspector-facing React/Vite app under `web/apps/inspector` for field technicians who need to inspect hose assets with intermittent connectivity.

The app should provide a queue-first mobile workflow: technicians start from assigned work, open an asset inspection, record pressure test results, save or submit the inspection, then review and push queued offline operations. The implementation should use synthetic/mock HMS-shaped data and the existing Phase 3A sync endpoints for development. It must not connect to or alter production HMS data.

## Target Users

Primary users are field inspectors or technicians performing service and new-asset inspections. They need a focused mobile interface for:

- Seeing assigned hose assets and retest urgency.
- Capturing inspection and pressure test information.
- Saving work while offline.
- Understanding whether local work has synced, is pending, or has a conflict.

Supervisor tablet workflows and native mobile hardening are out of scope for this phase.

## Product Direction

The accepted direction is **Queue-first Field Console**.

This means the first screen is operational, not form-only:

- Assigned work count and queued operation count are visible immediately.
- Online/offline state is always visible.
- Work items show the asset number, customer/site context, and urgency state.
- Draft work and failed/conflicted sync operations are visible without hunting through settings.
- The app uses the same BAT Operations Console visual language as the staff app: navy chrome, white panels, pale blue-gray workspace, blue primary actions, package-backed icons, and semantic status colors.

## Scope

Phase 3B includes:

- A new standalone React/Vite inspector app in `web/apps/inspector`.
- Mobile-first responsive UI that also works in a desktop browser for testing.
- Queue-first work dashboard.
- Inspection capture view with pressure test entry.
- Local offline outbox simulation for development.
- Sync queue view showing pending, applied, rejected, and conflict states.
- API client support for existing sync endpoints.
- Mock-data fallback when the backend is not running.
- Unit tests and browser verification for the core workflow.
- CI updates so the inspector app tests and build run with the existing checks.

Phase 3B excludes:

- Real OIDC auth integration.
- Native Capacitor/Ionic shell.
- Encrypted SQLite or secure mobile key storage.
- Camera/photo capture.
- QR/barcode scanning.
- Push notifications.
- Real production data scraping or migration.
- Asset field-edit push handlers beyond the inspection payloads already supported by the current sync API.
- Customer portal features.

## App Architecture

The inspector app should remain separate from the staff console:

- `web/apps/staff` remains the staff/admin operations console.
- `web/apps/inspector` becomes the field inspector app.
- Both use React, TypeScript, Vite, and package-backed icons.
- Shared code extraction is not required in this phase. Minimal type duplication is acceptable to keep the implementation scoped.

The app structure should be feature-oriented:

- App shell: top status bar, bottom navigation, app-level layout.
- Work queue feature: assigned work list, filters, urgency badges.
- Inspection feature: selected asset context, inspection result fields, pressure test form, draft/submission actions.
- Sync feature: local outbox records, push/pull state, conflict display.
- Data layer: sync API client, mock bootstrap data, local outbox store.

## Screens

### Work Queue

Purpose: give a technician a clear start point for the day.

Visible elements:

- Header with `BAT Inspector`.
- Online/offline indicator.
- Last sync timestamp.
- Assigned count.
- Queued operation count.
- Search input for asset number or customer name.
- Filters for all, overdue, due today, drafts, and synced.
- Work item rows/cards containing:
  - Asset number.
  - Customer name.
  - Location/site label where available.
  - Product label where available.
  - Retest due date or urgency label.
  - Draft/sync status if local work exists.
- Bottom navigation for Work, Scan, Queue, and Sync. Scan can route to a clean unavailable state because QR/barcode scanning is out of scope.

Primary action:

- Open a work item into inspection capture.

### Inspection Capture

Purpose: record a service or new-asset inspection with pressure test details.

Visible elements:

- Asset number and customer context.
- Product and lifecycle summary.
- Inspection type selector with `Service` and `New asset`.
- Result selector with pass/fail style states.
- Pressure test fields:
  - Applied pressure.
  - Required pressure.
  - Hold time.
  - Pass/fail result.
- Notes field for inspection observations.
- Save Draft action.
- Submit action.
- Local save state, such as `Saved locally`, `Queued`, or `Ready to sync`.

Behavior:

- Save Draft writes a local outbox operation.
- Submit writes or updates a local outbox operation with submitted status.
- If online sync succeeds, the operation shows as applied and the local record updates from the returned server version.
- If the server reports a conflict, the screen should not silently overwrite local work.

### Sync Queue

Purpose: make offline work trustworthy and inspectable.

Visible elements:

- Current device identifier and platform/app version from the sync client headers.
- Cursor or last sync summary in human-friendly form.
- Pending operation count.
- Operation rows containing:
  - Operation type.
  - Entity type.
  - Asset or inspection identifier.
  - Local status: pending, pushing, applied, conflict, rejected.
  - Last error message when present.
- Push Changes action.
- Pull Updates action.
- Conflict detail panel showing current server version when available.

Behavior:

- Push Changes calls `POST /api/v1/sync/push` with queued operations.
- Pull Updates calls `GET /api/v1/sync/changes?since=<cursor>`.
- Conflicts remain visible until the user chooses to keep local draft or accept server state. The first implementation can support this as local UI state without adding a backend merge endpoint.

### Unavailable Scan State

Purpose: keep bottom navigation complete without pretending QR scanning is implemented.

Visible elements:

- Clear empty state explaining that scan capture is not available in the current development build.
- Link/button back to Work Queue.

No scanner UI, camera permission flow, or fake camera preview should be added in this phase.

## Data Flow

Initial app load:

1. The app calls `GET /api/v1/sync/bootstrap` with development identity headers and inspector device headers.
2. If the backend responds, the app maps returned records into local work items.
3. If the backend is unavailable, the app loads synthetic mock bootstrap data.
4. The app initializes the local outbox from browser storage.

Pull updates:

1. The app calls `GET /api/v1/sync/changes?since=<cursor>`.
2. Upsert changes update local records.
3. Delete changes mark local records unavailable or remove them from the visible work queue.
4. The cursor advances only after a successful response.

Save or submit inspection:

1. The user edits inspection data.
2. The app stores an outbox operation in browser storage with:
   - `op_id`
   - `idempotency_key`
   - `entity`
   - `entity_id`
   - `op`
   - `base_version`
   - `payload`
   - local status and timestamps
3. The UI immediately reflects the draft/submitted local state.

Push queued operations:

1. The app sends queued operations to `POST /api/v1/sync/push`.
2. `applied` results mark operations synced and update local server version.
3. `conflict` results mark operations conflicted and retain both local payload and returned server payload.
4. `rejected` results remain visible with the server error.

## Existing API Contract

The inspector app should use the Phase 3A sync endpoints:

- `GET /api/v1/sync/bootstrap`
- `GET /api/v1/sync/changes?since=0`
- `POST /api/v1/sync/push`
- `POST /api/v1/sync/operations`

Required development headers:

- `X-HMS-User-Id`
- `X-HMS-Roles`
- `X-HMS-Device-Id`
- `X-HMS-Device-Platform`
- `X-HMS-App-Version`

The initial inspector app should use a development identity suitable for local testing, such as an inspector role. Production OIDC claims and device registration hardening are a later phase.

## Local Offline Store

The first implementation should use browser storage rather than encrypted SQLite:

- Work records can be held in React state and refreshed from bootstrap/changes.
- Outbox records should persist in `localStorage` so browser refresh does not lose drafts.
- Storage code should be isolated behind a small adapter so it can later be replaced by IndexedDB, SQLite, or Capacitor storage.
- The adapter should handle corrupt stored JSON by resetting to an empty outbox and surfacing a recoverable UI warning.

This phase is a functional development simulation of offline behavior, not the final secure mobile offline store.

## Visual System

The inspector app should feel related to the staff BAT Operations Console but optimized for touch:

- Background: pale blue-gray.
- Header/status surfaces: deep navy.
- Cards/panels: white with subtle cool border and low shadow.
- Primary action: blue.
- Success: green.
- Warning/due: amber.
- Danger/overdue/conflict: red.
- Text: slate/navy with muted gray-blue metadata.
- Icons: package-backed, preferably `lucide-react`.
- Cards: 8-12px radius unless a larger mobile container needs up to 16px.
- Typography: explicit sizes for labels, controls, badges, and headings.
- Motion: subtle press/hover/fade transitions with reduced-motion support.

The UI should avoid visual clutter. A technician should be able to read the current state at a glance while standing on-site.

## Responsiveness

Mobile:

- Single-column layout.
- Bottom navigation remains reachable.
- Primary actions stay visually obvious.
- Forms avoid cramped side-by-side inputs unless the labels remain readable.
- Text must not overflow cards, buttons, or badges.

Desktop browser:

- Center the mobile app surface or use a controlled two-column preview/detail layout.
- Keep widths constrained so the app still feels like the field inspector product.
- Do not stretch mobile cards into sparse full-width desktop rows.

## Error Handling

Backend unavailable:

- Show mock-data mode and keep local outbox available.
- Do not block inspection capture.

Offline:

- Update online/offline indicator from browser connectivity events.
- Disable automatic push while offline.
- Allow local save and submit-to-queue.

Push failure:

- Keep operations queued.
- Store the last error message.
- Show retry affordance.

Conflict:

- Show conflict status in Sync Queue and on affected work items.
- Retain local payload and returned server payload.
- Provide local UI actions to keep local draft or accept server state. These actions can resolve local display state without inventing an unsupported server merge operation.

Corrupt local outbox:

- Reset the invalid local storage value.
- Show a recoverable warning.
- Continue with an empty queue.

## Testing

Inspector app verification should include:

- Unit tests for sync client request headers and response mapping.
- Unit tests for local outbox add/update/mark-applied/mark-conflict behavior.
- Component tests for Work Queue mock fallback.
- Component tests for creating a draft inspection operation.
- Component tests for Sync Queue push success and conflict display.
- Build verification with `npm run build`.
- Browser/IAB visual verification at a mobile viewport and desktop browser viewport.

Backend verification should run existing backend tests to ensure Phase 3A sync behavior remains intact.

## CI

GitHub Actions should add an inspector web job or extend the existing frontend job to run:

- `npm ci`
- `npm test -- --run`
- `npm run build`

This should be scoped to `web/apps/inspector` and should not break the existing staff app checks.

## Documentation

Update the root `README.md` after implementation to include:

- Inspector app location.
- Setup commands.
- Development auth/device headers.
- Current offline limitations.
- Clear note that browser storage is a development simulation, not the final secure native offline store.

## Acceptance Criteria

Phase 3B is complete when:

- `web/apps/inspector` is a working separate React/Vite app.
- The app opens to the queue-first Work Queue.
- A user can open a work item, enter pressure test values, save a draft, and see a queued operation.
- A user can submit an inspection to the local queue.
- Sync Queue displays pending, applied, rejected, and conflict states.
- The app can use backend sync endpoints when running and mock data when not.
- Local outbox survives browser refresh.
- Tests cover the local offline workflow and sync result handling.
- CI includes inspector app test/build checks.
- Browser verification shows a clean mobile layout with no overlapping text or broken navigation.
