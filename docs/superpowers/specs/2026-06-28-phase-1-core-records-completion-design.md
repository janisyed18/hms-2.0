# Phase 1 Core Records Completion Design

## Objective

Complete the remaining Phase 1 HMS core-records scope on top of the existing
FastAPI backend and React staff app.

Phase 0 infrastructure items remain deferred: real OIDC, structured logging,
OpenTelemetry, Terraform, Helm, CI deploy/build/scan, sync endpoints, and Nx.

## Frontend Direction

Use React + Vite + TypeScript for the staff/admin web app. Use package-backed
icons and UI primitives so the interface continues to feel like a deliberately
engineered product rather than a one-off prototype.

The existing premium staff shell remains the base:

- Dark graphite left navigation.
- White table-first operations workspace.
- Compact filters, drawers, tabs, status labels, and detail panels.
- `lucide-react` icons for navigation/actions.

## Backend Scope

Add Phase 1 contract completion to customers, locations, contacts, products,
reference standards, and assets:

- Soft-delete endpoints that mark `deleted_at`, emit tombstone `SyncChange`, and
  write audit events. No hard deletes.
- ETag support for mutable detail resources using the current `version` value.
- `If-Match` enforcement for update/delete requests when supplied.
- Sort parameters on list endpoints with a controlled allow-list per resource.
- Server-side search remains authoritative for customer/product/asset lists.

## Staff UI Scope

Expand the current customer-only workspace into core records:

- Customers: keep current table/detail/edit flow and add delete/archive action
  using soft delete.
- Reference Data: list standards and support create/update/archive.
- Products: list products, edit product metadata, and manage pressure ratings.
- Assets: list/search/filter assets, create/edit asset metadata, and edit A/B end
  configurations using controlled lists.

The UI must prefer backend data when the FastAPI server is available. Mock data
remains only a development fallback so the app can still demo when the backend is
offline.

## Data Safety

Every mutation must remain audited and syncable. Delete actions are presented as
archive/soft-delete actions in the UI, not destructive deletion. No production HMS
data is scraped or modified.

## Testing

Backend tests will be added before implementation for:

- Soft delete audit/sync behavior.
- ETag response headers.
- `If-Match` conflict handling.
- Sort allow-list behavior.
- RBAC/customer scoping on new mutations.

Frontend tests will be added before implementation for:

- Navigation between core record modules.
- API-client mapping for customers, assets, products, and reference data.
- Drawer/form submission behavior.
- Product pressure-rating editor behavior.
- Asset A/B end editor behavior.
- Mock fallback only when backend requests fail.

## Acceptance

Phase 1 is considered complete when:

- Backend tests pass for customers, reference data, products, and assets.
- Staff UI can manage customers, reference standards, products, product pressure
  ratings, assets, and asset ends.
- UI uses server data against local FastAPI and falls back to mock data only when
  the backend is unavailable.
- The premium visual system remains intact across all core-record modules.
