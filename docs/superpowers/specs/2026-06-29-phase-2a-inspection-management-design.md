# Phase 2A Inspection Management Design

## Objective

Build the staff inspection workflow on top of the completed Phase 1 core-record
foundation. Phase 2A should let a staff user inspect an asset, record pressure
test results, review the inspection status, submit the inspection, and approve it
using the current development `HMS_ADMIN` identity.

Certificates, PDF generation, mobile/offline capture, and notification delivery
remain out of scope for this phase.

## Current Foundation

The backend already has domain models and partial API support for inspections:

- `POST /api/v1/assets/{asset_id}/inspections`
- `POST /api/v1/inspections/{inspection_id}/submit`
- `POST /api/v1/inspections/{inspection_id}/approve`
- `Inspection`, `PressureTestResult`, `InspectionAnswer`, and `InspectionPhoto`
  models.
- Audit and `SyncChange` creation for create/submit/approve flows.

The staff app currently has navigation icons for Inspections, but the
Inspections nav item is not wired to an application module.

## Backend Scope

Add read and draft-edit contracts for inspection management:

- `GET /api/v1/inspections`
- `GET /api/v1/inspections/{inspection_id}`
- `PATCH /api/v1/inspections/{inspection_id}`

The list endpoint supports:

- `status`: `DRAFT`, `SUBMITTED`, `APPROVED`, `REJECTED`
- `inspection_type`: `NEW_ASSET`, `SERVICE`
- `asset_id`
- `customer_id`
- `search`: asset number, asset tag, customer code/name, inspector/reviewer id
- `sort`: allow-listed fields such as `submitted_at`, `approved_at`,
  `created_at`, `updated_at`, `status`
- `limit` and `offset`

The detail/read shape should include enough context for the staff UI without
extra round trips:

- Inspection identity, type, status, result, timestamps, inspector/reviewer ids.
- Asset summary: id, asset number, tag, lifecycle status.
- Customer summary.
- Product summary.
- Pressure test result when present.

Draft updates support:

- `result`
- `pressure_test.applied_pressure_kpa`
- `pressure_test.hold_time_seconds`
- `pressure_test.passed`
- `pressure_test.measurements`

Only `DRAFT` inspections are editable. Submitted and approved inspections return
`409 Conflict` for draft-edit attempts. Submit only allows `DRAFT -> SUBMITTED`.
Approve only allows `SUBMITTED -> APPROVED`.

Every mutation must write audit and sync records. Updating or replacing pressure
test data must audit/sync the affected `PressureTestResult` row as well as the
inspection when inspection fields change.

## Staff UI Scope

Add an `inspections` module to the existing React/Vite staff app using the same
premium shell, table-first layout, drawers, status pills, compact filters, and
`lucide-react` icons used in Phase 1.

The first screen is an inspection dashboard/list, not a landing page:

- Summary metrics for Draft, Submitted, Approved, and Failed/Attention states.
- Status tabs or segmented controls.
- Search and filter controls.
- Table rows showing inspection status, asset number, customer, inspection type,
  result, pressure test status, submitted date, and reviewer state.
- Source selector showing Backend or Mock data, matching the Phase 1 pattern.

Create inspection flow:

- Available from the Inspections module as a drawer action.
- User selects an existing asset from backend/mock asset options.
- User selects inspection type.
- User can enter result and pressure test values before saving.
- Saved inspection appears in the list as `DRAFT`.

Inspection detail flow:

- Selecting a row opens a detail drawer or side panel.
- Draft inspections expose editable result and pressure test fields.
- Draft detail has a Submit action.
- Submitted detail has an Approve action using the current dev admin role.
- Approved inspections are read-only in Phase 2A.

Mock data remains a development fallback only when backend requests fail.

## Data Flow

When the local FastAPI backend is running:

1. Staff UI calls `GET /api/v1/inspections`.
2. List rows render from server data.
3. Create inspection posts to `/assets/{asset_id}/inspections`.
4. Draft edits patch `/inspections/{inspection_id}`.
5. Submit posts to `/inspections/{inspection_id}/submit`.
6. Approve posts to `/inspections/{inspection_id}/approve`.
7. The UI updates local state from the returned server record.

When the backend is unavailable, the same UI uses mock inspection data and local
state so demos still work without production data.

## Permissions And Safety

Phase 2A uses the current development identity scaffolding. The staff app sends
`HMS_ADMIN`, which has enough permissions for create, submit, and approve during
development.

The backend should continue to enforce RBAC independently:

- Inspectors/admins can create and submit inspections.
- Reviewers/admins can approve submitted inspections.
- Customer-scoped users can only read in-scope records and cannot create
  inspections unless a later product decision enables that.

No production HMS data is scraped or modified.

## Testing

Backend tests are added before implementation for:

- Listing inspections with asset/customer/product context.
- Filtering by status, type, asset, customer, and search.
- Detail endpoint scoping and not-found behavior.
- Draft update with pressure test create/update.
- Rejecting draft edits after submit.
- Submit/approve status transition conflicts.
- Audit and sync rows for update paths.

Frontend tests are added before implementation for:

- Inspections nav opens the inspection dashboard.
- Backend-backed list rows render.
- Mock fallback renders when backend requests fail.
- Create inspection drawer saves a draft inspection.
- Detail drawer edits pressure test values.
- Submit action moves a draft inspection to submitted.
- Approve action moves a submitted inspection to approved.

Browser verification covers:

- Local seeded backend data renders in the Inspections module.
- Create, edit pressure test, submit, and approve hit the backend.
- Mock fallback appears after backend stop/reload.
- Desktop and mobile layouts have no horizontal overflow.

## Acceptance

Phase 2A is complete when:

- Backend list/detail/update inspection contracts exist and are covered by tests.
- Staff UI can create an inspection from an asset.
- Staff UI can edit draft pressure test data.
- Staff UI can submit and approve inspections using the dev admin role.
- Server-backed local browser verification passes.
- Phase 2B certificate work remains separate.
