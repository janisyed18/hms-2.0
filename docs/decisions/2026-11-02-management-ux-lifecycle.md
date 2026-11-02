# Management UX and data correctness: lifecycle decisions

## Rules now enforced by the backend

- A customer is never without a location. Creating one needs a first location; the last remaining
  location cannot be deleted by anyone, including a Super Admin (HTTP 409 with
  "A customer must have at least one location. Add another location before deleting this one.").
- Only SUPER_ADMIN may Delete a customer, location, contact, user, product or reference record
  (HTTP 403 otherwise). HMS_ADMIN keeps create, edit and Disable.
- Customers have three distinct states. Archive is reversible and keeps history, Restore undoes
  it, and Delete (logical, SUPER_ADMIN only) is allowed only from Archived. Archived customers
  are left out of every new-work selector and list by default (`lifecycle=active`).
- Users: Delete is a soft delete that revokes sessions and blocks sign-in. A user cannot delete
  themselves, the last active SUPER_ADMIN cannot be deleted, and HMS_ADMIN cannot delete users.
- Catalogue items (products, reference data) are Disabled and Enabled by admins. Delete is
  SUPER_ADMIN only and is refused while anything references the record. The irreversible
  soft-delete is labelled Delete, never Archive.

## Selection is always explicit

Add Asset (customer, location, product), Add User (role), Add Certificate (inspection) and Add
Inspection (type) start empty. Relationship pickers search the server (`useRemoteOptions`), so a
record past the old 50 or 100 row limits can be found. Location scheduling data (timezone, open
and close time, working days, blackout dates) is shown in the form; the timezone has no default.

## Deferred, with reasons

- **Pressure ratings.** The old matrix editor was removed because it was never persisted. A real
  version needs a `ProductPressureRating` API and nominal-bore selectors; until then no control
  pretends to save them.
- **Asset "Archive asset" wording.** Left as it is. It was audited, and redefining asset
  lifecycle is a separate change.
- **Scheduling defaults on the API.** The API still defaults a location without scheduling fields
  to UTC, 08:00 to 17:00, Monday to Friday so existing API clients keep working. The Staff UI no
  longer relies on them.
- **Substring search.** Search is `LIKE '%term%'`, as before. A trigram index is a performance
  change for later.
- **Asset register filters.** The customer and product filter dropdowns and the booking form's
  asset options still load their first page, and the register filters its first 50 assets in the
  browser. Both predate this change.
