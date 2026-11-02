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
- A disabled product cannot be given to an asset: creating an asset on it, or moving an existing
  asset onto it, is refused (HTTP 409). An asset already on a product that was later disabled still
  loads and can be edited for anything else; history never depends on the product being enabled.
- Locations change through their own endpoints only (`POST/PATCH/DELETE /customers/{id}/locations`).
  `PATCH /customers/{id}` no longer accepts `locations` (unknown fields are refused with 422), so
  there is one path and one set of rules, including the archived-customer rule.

## Concurrency

Both "last one" rules are checked inside the transaction that acts, under a row lock, so two
overlapping requests cannot each see the other still present:

- **Last location.** `DELETE .../locations/{id}` locks the customer row (`SELECT ... FOR UPDATE`),
  counts the active locations under that lock, then deletes. The second request waits, re-reads
  after the first commits, finds one location left and answers 409.
- **Last Super Admin.** `DELETE /admin/users/{id}` for a Super Admin locks every active Super
  Admin row in id order (a fixed order, so two deletes cannot deadlock), then refuses with 409 when
  no other active Super Admin would remain. Under READ COMMITTED the waiting request re-evaluates
  the lock query after the first commits, so the deleted row is no longer in its set.

Both are proved on real PostgreSQL by `tests/test_management_postgres_races.py` (two independent
sessions, a concurrent run and a deterministic held-lock run). SQLite ignores `FOR UPDATE`, so the
tests skip without `POSTGRES_TEST_DATABASE_URL` and run in the CI PostgreSQL step.

## Archived customers get no new work

Archive keeps history and removes the customer from anything that starts new work.

| Route | Archived customer |
| --- | --- |
| `POST /assets`, `PATCH /assets/{id}` to an archived customer | refused, 409 |
| `POST /assets/{id}/inspections` | refused, 409 |
| `POST /inspection-bookings` | refused, 409 |
| `POST /inspection-bookings/{id}/approve` | refused, 409 |
| `POST /customers/{id}/locations` | refused, 409 |
| `PATCH /customers/{id}` with `locations` | refused, 422 (field no longer exists) |
| `GET /assets?new_work_only=true` | leaves the customer's assets out (Add Inspection and the booking form use it) |
| Reads: `GET /assets`, asset detail, inspections, certificates, Customer Detail | unchanged, history stays visible |
| Existing work: start, submit, approve, rework, certificate issue, cancel or reject a booking, reschedule requests | unchanged, so work in flight can finish |
| Contacts and customer-level edits | unchanged (administrative) |

The default `GET /assets` is unchanged; `new_work_only` is an explicit opt-in.
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

## Asset lookups and the register

The booking form and the Asset register no longer load assets and filter them in the browser.

- **Booking form.** Customer (server search), then Location (read from that customer), then Assets
  searched and paged on the server for that customer and location with `new_work_only`. Ticked
  assets are kept apart from the page on screen, so a search or "Show more assets" never loses
  one. The old "load every asset" fetch (`listAllAssets`) is gone from the booking path.
- **Asset register.** Search, customer, product, lifecycle and the due-date range are query
  parameters; the table loads 50 at a time with "Load more" and shows the server's total. The
  customer and product filters are searchable server lookups, not the first 100 records. The
  totals above the table (total, due, overdue, condemned) are server counts for the whole
  register. The old "Customers with assets" tile is replaced by "Due for retest" because no
  endpoint can count distinct customers across the register honestly.
- **Asset search** on the server now also matches purchase order number and product code or name,
  which the browser-side filter used to cover.
- **Inspection detail** reads the pressure rating of the one asset it shows, instead of looking
  it up in a list of every asset.
