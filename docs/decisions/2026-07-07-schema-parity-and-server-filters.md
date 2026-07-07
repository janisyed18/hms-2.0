# Schema Parity And Server Filters

Date: 2026-07-07

## Context

Phase 3D checks whether the current HMS 2.0 schema is close enough to the old
HMS workflow before deeper migration work. This note is based on the current
codebase plus the HMS 2.0 functional, technical, and mobile/offline design
documents already attached to the project. No production HMS data was accessed.

The immediate user concern was that asset address data looked missing. In the
current design, asset address data is intentionally modeled through the asset's
`CustomerLocation`:

- `Asset.location_id` links the asset to a customer location.
- `CustomerLocation` stores `address_1`, `address_2`, `city`, `state`, and
  `country`.
- Staff and inspector UI now display the location address from that relationship.

Do not duplicate address columns onto `Asset` unless the legacy export proves
that old HMS supports a per-asset address override that differs from the
customer/site location.

## Confirmed Coverage

The current schema and APIs cover these core records:

- Customers: code, name, retest configuration, locations, contacts.
- Customer locations: name and core address fields.
- Products: category, sub-category, code, name, standard, enabled flag.
- Assets: customer, location, product, asset number, customer serial, tag,
  lifecycle, manufacture date, condemned date, next retest due date, length, and
  A/B end configuration.
- Retest schedules: asset, customer, due date, status, reminder interval, and
  escalation interval.
- Inspections: asset, type, status, result, inspector/reviewer, pressure test,
  answers, photos, and certificate relationship.
- Certificates: inspection, asset, certificate number/version, issue date,
  valid-until date, verification fields, issuer, and lifecycle status.

## Known Parity Gaps

These items are visible in the HMS 2.0 docs or expected by the migration path,
but are not complete enough to treat as migrated:

- Customer notes are mentioned in the functional specification but are not in the
  current customer model, API schema, or staff form.
- Asset notes are mentioned in the functional specification/mobile addendum but
  are not in the current asset model, API schema, staff form, or sync payload.
- Customer portal users are still not modeled as a real identity/user linkage;
  the current user/devices UI is administrative scaffolding.
- Asset copy is not implemented yet.
- Asset inspection/certificate history is not yet exposed as a dedicated asset
  detail history view.
- The asset end model has controlled-list foreign keys, but the staff asset form
  still primarily edits the fallback fitting/size text values.
- Location fields such as suburb, postcode, or site code should only be added if
  the approved legacy export confirms they exist and are needed. They are not
  proven by the current HMS 2.0 source documents.

## Server Filter Contract

The backend now supports server-side filters matching the current staff filter
vocabulary:

- `GET /api/v1/assets`: `customer_id`, `product_id`, `location_id`, `status`,
  `due_from`, `due_to`, `search`, `sort`, `limit`, `offset`.
- `GET /api/v1/products`: `category`, `standard_code`, `enabled`, `search`,
  `sort`, `limit`, `offset`.
- `GET /api/v1/retest-schedules`: `status`, `asset_id`, `customer_id`,
  `product_id`, `due_from`, `due_to`, `search`, `sort`, `limit`, `offset`.
- `GET /api/v1/inspections`: `status`, `inspection_type`, `result`, `asset_id`,
  `customer_id`, `product_id`, `search`, `sort`, `limit`, `offset`.
- `GET /api/v1/certificates`: `status`, `asset_id`, `customer_id`,
  `product_id`, `inspection_id`, `valid_from`, `valid_to`, `search`, `sort`,
  `limit`, `offset`.

The staff API client and mock fallback filters understand the same query
options. The current React hooks still keep local filtering for responsive UI;
switching each filter change to backend reloads should be a separate UI
performance decision.

## Migration Decision

Before altering tables for old-HMS parity, get an approved read-only export or
schema dump and map each source column to HMS 2.0. The first fields to validate
against that export are:

- customer notes
- asset notes
- customer/site address fields beyond the current location fields
- per-asset address overrides, if any
- legacy end-configuration fields
- legacy portal/customer user fields
