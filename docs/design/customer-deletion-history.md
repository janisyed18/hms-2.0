# Customer deletion with historical data preservation

Status: implemented on `feature/customer-deletion-history`, awaiting independent review.
Scope: backend (`modules/history`, `api/history.py`, `api/records.py`), Alembic `20261110_0027`, Staff web app.

## 1. What this is, and what it is not

A Super Admin can remove a customer and everything that customer exclusively owns from **active HMS**
in one confirmed action. Before anything leaves active use, the server writes a verified, immutable
historical copy. "Deleted" means *removed from operational use*. It does **not** mean the history is erased.

Two separate actions are offered in the Staff app:

| Action | Effect | Reversible |
| --- | --- | --- |
| Archive customer | Customer stays, hidden from active work. All records kept. | Yes (Restore customer) |
| Delete Customer and Related Data | Archive written and verified, then the customer and owned records are removed from active HMS. | Not automatically (see section 9) |

## 2. Decision to raise for review: logical removal, not physical delete

`AGENTS.md` says customers, assets, inspections and certificates are never hard-deleted. This design keeps
that rule:

* Operational rows are **soft-deleted** (`deleted_at` set, `version += 1`) through the existing
  `SyncableMixin`. No operational row is physically removed.
* A **snapshot** of every removed row is additionally written to dedicated, insert-only history tables.

Reviewers should confirm that (a) soft-delete plus snapshot satisfies the intent of the rule, and
(b) the product wording "Delete" in the UI is acceptable given rows persist in a logically removed state.
If the business later needs physical erasure (for example a privacy request), that is a separate,
explicitly authorised procedure and is out of scope here. Retention is not personal-data erasure.

## 3. Ownership graph

`OWNERSHIP` in `modules/history/service.py` lists, per table, the foreign keys through which a row is
owned by the customer. Ownership is evaluated as nested subqueries (`owned_clause`).

Owned and removed: locations, location contacts, customer contacts, assets, asset end configurations,
retest schedules, bookings and their asset links, appointments, revisions, allocations, change requests,
inspections, answers, photos, pressure-test results, certificates, and `user_customer_accesses`.

Never removed (shared): users (only the access association is removed), products, reference data.
`inspection_availability_quotes` are short lived and are left alone.

**Safety net.** Any table that references an owned row and is not in `RETAINED_REFERENCERS` blocks the
deletion (`409`, `can_delete: false`, with counts). A schema-drift test fails CI when a new table
references an owned table without being classified, so a future migration cannot silently orphan data.

Only active (non-deleted) rows are snapshotted; rows already soft-deleted before this action are history
already and are left as they are.

## 4. History schema

Four insert-only tables, created by migration `20261110_0027` (no foreign keys to operational tables, so
the archive survives whatever happens to them):

* `history_customer_deletions`: one row per batch. Id, human number `DEL-{year}-{n}`, status
  (`completed`, `failed`), customer id/code/name/version, actor id and name, reason, `idempotency_key`
  (completed batches only), snapshot schema version, per-type counts, totals, `impact_fingerprint`,
  `manifest_sha256`, retention date and basis, failure detail, `audit_event_sequence`, UTC `created_at`.
* `history_records`: one row per removed entity: batch, type, original id and version, ordinal, JSON
  payload, `payload_sha256`.
* `history_relationships`: child, FK column, parent, and whether the parent is retained (shared) or in the batch.
* `history_evidence_objects`: certificate PDFs and attachments copied to history storage: source key,
  history key, content type, size, `sha256`, verification time.

On PostgreSQL a trigger (`history_reject_change`) rejects every UPDATE and DELETE on all four tables.
Hashes: each record payload is SHA-256 of canonical JSON; the manifest hash covers all record hashes and
evidence hashes.

## 5. Deletion flow (server)

`POST /api/v1/customers/{id}/delete-with-history`, Super Admin only, server-enforced.

Preconditions: `If-Match` (customer version), `Idempotency-Key` (8 to 80 chars), body
`{confirm_name, impact_fingerprint, reason?}`. The UI first calls `GET /customers/{id}/deletion-check`,
which returns the impact (counts per type, evidence files, blockers) and a fingerprint.

1. Lock the customer row (`FOR UPDATE`). Check version (412), typed name (422) and fingerprint (409 when
   records changed since review).
2. Reject if shared references block deletion (409).
3. Copy certificate/attachment objects to `history/customer-deletions/{batch_id}/...`, re-read and verify
   the SHA-256. A missing source file or a hash mismatch **blocks the deletion** (strict policy, see 10).
4. In **one database transaction**: write batch, records, relationships and evidence; flush; read back and
   re-hash every row; only then soft-delete operational rows, stage sync tombstones, write audit events, commit.
5. On any failure: roll back, delete the copied history objects, and record a `failed` batch plus a
   `customer.deletion_failed` audit event in a fresh transaction. The API returns 500 with a reference
   and states that nothing was removed. A failure is never reported as success.

**Idempotency.** Retrying with the same key returns the original completed batch (`Idempotent-Replay: true`).
Failed attempts do not hold the key and can be retried. Concurrent deletes of one customer serialise on
the row lock and produce one batch (tested on PostgreSQL).

**Audit and sync (AGENTS.md).** Existing audit events are untouched. New events:
`customer.deleted_with_history` (entity `CustomerDeletionBatch`, includes the manifest hash, linked from
the batch by `audit_event_sequence`) and `customer.deleted` (entity `Customer`, includes `deletion_batch_id`).
Sync `delete` tombstones are staged for entities in `SYNC_MODELS`, so devices drop the records.

## 6. Read APIs (Super Admin only, read-only)

`GET /customer-deletions` (search, date filter, paging), `/{id}`, `/{id}/records`, `/{id}/relationships`,
`/{id}/integrity` (recomputes hashes), and `/{id}/evidence/{evidence_id}/download` (re-verifies the hash;
502 if the stored object no longer matches). There is no update, restore or purge endpoint.

## 7. Retention

`history_retention_years` (default 7) sets `retention_until` on each batch, with the basis recorded.
Nothing purges batches. Retention supports certificate and inspection evidence obligations; it is not a
claim of legal compliance, and the period must be confirmed by whoever owns regulatory requirements.

## 8. Staff app

* Customer detail: a "Customer lifecycle" panel with separate Archive and Delete buttons, marked
  "Super Admin only". Offered only to Super Admin.
* Remove Customer dialog: (1) Choose action, Archive recommended; (2) Review & Confirm with the server's
  Deletion Impact; (3) type the customer name and tick the acknowledgement; then a success dialog
  (deletion id, deleted by, deleted on, historical records, View in History / Done).
* Deleted Customers (History): searchable, date-filtered, paged list with records dialog, certificate
  evidence download and skeleton, empty and error states. Reached from the Customers page, Super Admin only.
* All three are hidden from other roles in the UI and refused with 403 by the API.

## 9. Restore (design only, not implemented)

Restore would be a Super Admin action that reads one batch and: re-validates that the customer code and
ids do not collide; clears `deleted_at` on the same ids in dependency order; restores `user_customer_accesses`
where the user still exists; stages sync upserts; writes `customer.restored_from_history` linked to the
batch; and marks the batch as restored by a **new** history row (history is insert-only). It is deliberately
not automatic because other data may have moved since deletion. Until it exists, restore is a manual
engineering procedure from the snapshot.

## 10. Open questions and known limits (for reviewers)

1. **Strict evidence policy.** A missing certificate file or hash mismatch blocks deletion. Confirm this
   is preferred over deleting with a recorded gap.
2. **Public certificate verification** (approved with conditions in review).
   A certificate of a deleted customer is still found by its QR token: `/certificates/verify/{token}` reports
   authenticity as before, sets `historical: true` and `valid: false`, withholds the customer name and explains that the
   certificate is retained for historical verification only. Revoked, superseded and expired states keep their meaning.
   This applies only to certificates held by a COMPLETED archive; any other soft-deleted certificate is still a 404.
   The public PDF download returns 404 because the PDF names the customer; the retained copy is in History.
3. **Portal users** whose `customer_id` is the deleted customer are left as they are.
4. **Object storage immutability is a deployment prerequisite.** The PostgreSQL history tables reject update and
   delete, but the archived PDFs and photos are ordinary objects until the history prefix has S3 Object Lock
   (or an equivalent bucket policy denying delete/overwrite). Until that is configured, the archive is tamper-evident
   (SHA-256 per object plus a manifest hash) but not tamper-proof. Terraform/AWS was deliberately not touched here.
   The originals also stay in place, so nothing is lost if the copy is later damaged.
5. **Lock scope.** The customer row lock is held while objects are copied; very large customers will
   hold it longer (v1 limitation). Per-record sync flushes are also slow for very large customers.
6. The history view is not deep-linkable (local state).
7. **Archive completeness (decided in review).** The archive includes records soft-deleted earlier, attributed through
   the same ownership graph (a child of an earlier-deleted parent is still found). Their original `deleted_at` is kept in
   the snapshot, History labels them "previously deleted", and impact counts show them separately
   (`previously_deleted_counts` on the batch). They are not deleted again: no version bump, no new tombstone. Their
   certificate and photo files are verified like any other, and a missing or altered file fails the whole archive
   closed. The archive is the state at the time of archiving; it does not recreate earlier edits or versions.
8. **Concurrency.** After the customer row is locked, every owned row is locked (`FOR UPDATE`, fixed order) before the
   content fingerprint is checked, and the locks are held until commit. A concurrent edit of a child therefore waits
   (a PostgreSQL test proves an `UPDATE` times out while the deletion is in progress, and fails without the locks).
   The fingerprint hashes the content of every owned row, so an edit after the preview returns 409. History date
   filters use explicit UTC day boundaries.
9. The old `DELETE /customers/{id}` route was removed (now `405`); clients use `delete-with-history`.

## 11. Recovery and rollback

* **A failed batch** appears with status `failed` and a reference; nothing was removed. Retry from the UI
  (a new idempotency key is generated per review).
* **Orphaned history objects** after a crash between copy and failure handling: objects under
  `history/customer-deletions/{batch_id}/` with no completed batch row are safe to remove by an operator
  after checking the batch id has no `completed` row.
* **Integrity check.** `GET /customer-deletions/{id}/integrity` recomputes record and evidence hashes.
* **Code rollback.** Redeploying the previous build is safe: the new tables are additive. The old build
  would again allow `DELETE /customers/{id}`, which only succeeds for customers with no linked records.
* **Migration downgrade** drops the history tables and therefore destroys retained evidence metadata.
  Never run it in an environment that holds real batches; it exists for local development.
