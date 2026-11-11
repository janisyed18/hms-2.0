# Customer deletion with historical data preservation

Status: implemented on `feature/customer-deletion-history`, awaiting independent review.
Scope: backend (`modules/history`, `api/history.py`, `api/records.py`), Alembic `20261110_0027` and `20261110_0028`, Staff web app.

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

Four insert-only tables, created by migration `20261110_0027` (`20261110_0028` adds `previously_deleted_counts` separately, so a database that already ran 0027 upgrades cleanly) (no foreign keys to operational tables, so
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

`HISTORY_RETENTION_DAYS` (or `HISTORY_RETENTION_YEARS`, counted as 365-day years; days win) sets
`retention_until` on each batch, with the basis and the approval reference recorded. The 7-year default is a
placeholder: outside local/test the app treats the retention period as unapproved, and deletion stays
unavailable, until `HISTORY_RETENTION_APPROVAL` names the approval (section 13). Nothing purges batches. Retention supports certificate and inspection evidence obligations; it is not a
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

## 12. Feature gate: deployed is not enabled

`CUSTOMER_DELETION_ENABLED` (setting `customer_deletion_enabled`, **default `false`**) is the master switch for
"Delete Customer and Related Data". Shipping this code to an environment does not make deletion available.

**What the flag does**

* `POST /customers/{id}/delete-with-history` returns **409** ("Customer deletion is not enabled in this
  environment…") when it is off. The check runs right after authentication and the Super Admin check and
  before the customer lookup, the archive, any object-storage write or any database change, so a refused
  request leaves no batch, no history row, no evidence object, no audit event and no sync change.
  Authorization stays first: a caller who is not a Super Admin still gets 403 and never learns the flag.
* `GET /customers/{id}/deletion-check` (the read-only impact preview) keeps working and now includes
  `deletion_enabled`, so the screen can explain the state. The preview does not authorise anything.
* The Remove Customer dialog shows "Delete Customer and Related Data" as **Not available**, disabled, with a
  short explanation, and offers Archive instead. This is a convenience only; the API is authoritative.
* Unchanged with the flag off: Archive, Restore, ordinary record management, the read-only Deleted Customers
  (History) pages and certificate verification of anything already archived. The old
  `DELETE /customers/{id}` stays removed (405) either way.

**Configuration.** Set the environment variable on the API service only. It is not set anywhere in the dev
Terraform task definition, so a deployment leaves it off. `docker-compose.yml` passes it through and
defaults it to off; the CI Staff E2E job sets it to `true` explicitly because it exercises the deletion.
Backend tests that delete opt in through the `customer_deletion_enabled` fixture; nothing enables it globally.

**Before switching it on in any shared environment** (DEV included), all of these need to be true and signed off:

1. Immutable evidence storage: a dedicated history bucket with S3 Object Lock and versioning, and separate
   permissions so ordinary application credentials cannot delete objects or shorten retention. A key prefix
   policy on the media bucket is not equivalent to Object Lock and should not be described as such. Built in section 13 and
   checked by the app before every deletion, but not yet applied to any environment.
2. An approved retention period for the environment (the 7-year default is a placeholder, not regulatory
   advice). The app keeps deletion unavailable outside local/test until `HISTORY_RETENTION_APPROVAL` is set.
3. A tested recovery and restore procedure for the history tables and the evidence bucket.
4. Product-owner approval of the historical-certificate wording.
5. The database migration preflight: the environment's Alembic revision confirmed and a backup verified.

**Rollback.** Turning the flag off is immediate (restart or redeploy the API with it unset) and loses nothing:
batches already written stay in History, remain verifiable, and keep their evidence. It stops *new* deletions
only; it does not restore a deleted customer (restore is design-only, section 9).

## 13. Protected evidence storage

Archived evidence (certificate PDFs and inspection photos) is copied into a **dedicated history bucket**, not
the media bucket. Protection comes from the bucket and its permissions; the application adds checks that
fail closed when the protection is missing.

**The bucket (Terraform, `infra/terraform/envs/dev/main.tf`)**

* Versioning on and S3 Object Lock enabled, with a default retention rule (`history_retention_mode` plus
  exactly one of `history_retention_days` / `history_retention_years`), SSE-S3 encryption, all public access
  blocked, TLS required, and `prevent_destroy` so a `terraform destroy` cannot remove retained evidence.
* The application's ECS task role may `PutObject`, `GetObject`, `GetObjectVersion` and `GetObjectRetention`
  on objects, and read the bucket's versioning and Object Lock settings. The last two are the minimum for
  reading a pinned version and checking its retention. A bucket-policy **explicit deny** stops that role from
  deleting objects or versions, changing retention or legal hold, bypassing governance retention, or
  changing versioning, Object Lock, lifecycle or the bucket policy, whatever other policies grant it.
* Retention administration is not an application capability. Shortening or removing retention (possible
  only in GOVERNANCE mode) belongs to account administrators acting deliberately, outside the app.
* A key prefix policy on the media bucket was rejected: it is not Object Lock, and the media role needs
  delete for ordinary files.

**The application**

* `HISTORY_OBJECT_STORAGE_S3_BUCKET` selects the bucket. Outside local/test it is required: with it blank,
  deleting a customer is refused rather than quietly using the media bucket. Local and test runs fall back
  to the ordinary store so developers need no AWS.
* **Retention must be approved.** Outside local/test, deletion is unavailable (409; the preview reports
  `deletion_enabled: false`) until `HISTORY_RETENTION_APPROVAL` is set to a reference for the approval. The
  reference is written into each batch's `retention_basis`. The Terraform variable defaults to empty, so
  applying the infrastructure never makes deletion available by itself, and neither does the flag alone.
* **Pinned versions.** Each evidence file is written under a unique key
  (`history/customer-deletions/{batch}/...`) and the `VersionId` S3 returns is stored on the evidence row
  (`history_version_id`). Downloads, the read-back verification and the integrity check use that version, so a
  later upload to the same key changes nothing that is served or verified. A protected store never reads
  without a pinned version.
* **Actual retention is verified, not assumed.** After each write the app heads *that version* and refuses
  (failing the archive, nothing removed) unless it has a version id, an Object Lock mode and a retain-until
  date that covers the batch's `retention_until`. The mode and retain-until are stored on the evidence row.
  It then reads the version back and compares its SHA-256 with the source file.
* Before each deletion the app checks the bucket: versioning enabled, Object Lock enabled, a default
  retention mode set, and default retention at least the configured period. The result is cached for
  `HISTORY_STORAGE_CHECK_TTL_SECONDS` (300). If any check fails, deletion is unavailable as above. Setting
  `CUSTOMER_DELETION_ENABLED=true` cannot expose deletion on an unprotected bucket or an unapproved period.
* **Failure atomicity.** Any failure before the commit (write error, missing version id, missing or
  insufficient retention, hash mismatch, database error) rolls back the transaction, so the customer and all
  operational records are unchanged, and records a FAILED batch.
* **Orphaned protected objects.** The app never deletes from this store and never weakens retention to remove
  anything. Each key is recorded on the FAILED batch (`orphaned_evidence`: key and, when known, version id)
  *before* it is written, so even a write whose outcome is unknown is listed. A retry uses a new batch id and
  therefore new keys, so it can never overwrite an orphan. Orphans are unreferenced by any evidence row and
  expire with their retention. Reconciliation is an administrator task: list the FAILED batches, compare
  `orphaned_evidence` with the bucket, and leave the objects in place until their retention ends (in
  GOVERNANCE an administrator may remove them early, deliberately, outside the app).
* The integrity check reports, per evidence file: a missing version, a different hash, and retention that is
  no longer applied or is earlier than what was recorded.

**Decisions (from the product owner) and what remains**

1. **Retention period.** Not approved at seven years. For DEV, which holds synthetic data only, the target is
   30 days (`history_retention_days = 30`) in GOVERNANCE mode. Production retention needs business and legal
   approval; until then the production approval reference stays empty and deletion stays unavailable there.
2. **Mode.** GOVERNANCE for DEV. COMPLIANCE is preferred for production once the retention obligation and the
   recovery design are approved. COMPLIANCE cannot be shortened or removed by anyone, including the account
   root, until the period ends, and a bucket holding such objects cannot be emptied or deleted. It is
   one-way for every object written under it.
3. **Encryption.** SSE-S3 is approved for DEV. A customer-managed KMS key is not required for this change and
   would add separation of duties through the key policy at the cost of another resource.
4. **Recovery.** A documented and **tested** procedure is required before deletion is enabled anywhere
   (section 14). Cross-region replication is a separate disaster-recovery improvement.
5. **Certificate wording** for archived certificates still needs product-owner sign-off (section 10). The
   wording and DEV retention approvals (2026-11-11) are recorded in [customer-deletion-approvals.md](customer-deletion-approvals.md).

**Verified on DEV (2026-11-11).** The IAM actions the app needs for `HeadObject` and `GetObject` on a specific
version (`s3:GetObjectVersion`, `s3:GetObjectRetention`) were exercised against the real DEV bucket: a write,
version-pinned read, retention check and SHA-256 comparison ran with no AccessDenied, and the recovery drill
(section 14) repeated them from a restored database.

**Rollout order.** Terraform plan reviewed, then applied (creates the bucket and role policy and adds the
environment variables, which re-registers the task definitions), then an API deploy, then the history
storage checks confirmed on DEV, then the recovery drill (section 14), and only then a decision to set
`HISTORY_RETENTION_APPROVAL` and `CUSTOMER_DELETION_ENABLED`. Applying the Terraform alone enables nothing.

## 14. Recovery across both stores

A deleted customer is recoverable only if **both** the database history rows and the pinned S3 object
versions survive. Restoring database rows without the protected versions is not a recovery: the evidence rows
would point at files that are gone, and the integrity check reports every one as "archived file version is
missing".

| Asset | Protection | Failure it covers |
|---|---|---|
| History tables (`history_*`) | RDS automated backups and point-in-time recovery; insert-only triggers | Loss or corruption of the database |
| Evidence objects | Versioning and Object Lock; the app role cannot delete | Accidental overwrite or delete; a compromised app |
| The link between them | `history_version_id` and `retain_until` on each evidence row | Silent replacement of a file at the same key |

**Procedure (to be run as a drill on DEV before deletion is enabled)**

1. Note the batch to recover and run its integrity check; record the result.
2. Database: restore RDS to a new instance at a point in time before the loss. Do not restore over the live
   instance. Confirm `history_customer_deletions`, `history_evidence_objects` and `history_records` contain the
   batch, and that the Alembic revision matches the application.
3. Evidence: for each evidence row, confirm its `history_version_id` exists in the history bucket
   (`aws s3api head-object --bucket ... --key ... --version-id ...`). If a version is gone because the bucket
   itself was lost, it cannot be rebuilt from the database; that is the gap cross-region replication would
   close, and why production uses COMPLIANCE.
4. Run the integrity check on the restored environment. Recovery is complete only when it reports
   `verified: true` for every batch that matters: hashes match and retention is still applied.
5. Re-point the application at the restored database; do not move or recreate evidence objects.
6. Record the date, who ran it, the batch used, the time taken and any gaps in this document.

The automated tests cover the application's side (missing, altered or unlocked versions are detected, and
database rows alone do not pass); they do not replace a restore of a real RDS snapshot against a real bucket.

### Drill record: DEV, 2026-11-11 (passed)

Run against the real DEV history bucket with synthetic data only. Live DEV was not written to, and deletion stayed
disabled there: the deletion gate and a test-only retention approval were set as environment overrides on the drill
task alone.

| Item | Value |
|---|---|
| Source database | `hms-dev-postgres` (read only; point-in-time restore at 2026-11-11T01:31:02Z, Alembic `20261110_0029`) |
| Isolated instance A | `hms-dev-recovery-drill-a`, restored from the source, non-public, own security group open to the ECS tasks only |
| Synthetic batch | `DEL-2026-000001`, id `01a1c85b-acc8-7bfa-89c5-a57a29912a93`, created on A through the real deletion flow (one synthetic customer, one certificate PDF; 4 records plus the customer) |
| Evidence | one object, version `xwTigYjwlb1lICo_bAdf0tzgk_3R8L2y`, GOVERNANCE until 2026-12-11T02:06:53Z |
| Recovery snapshot | manual snapshot of A (`hms-dev-recovery-drill-snap`), then restored to instance B (`hms-dev-recovery-drill-b`) |
| Integrity on A (before) | `verified: true`, 5 records, 1 file |
| Integrity on B (after) | `verified: true`, 5 records, 1 file, no problems; recorded and re-read SHA-256 identical; version still locked with the recorded retention |

Timings: restoring A from the source took about 27 minutes (including its first backup); snapshot 2m38s; restoring B
from the snapshot 8m30s; verification task 68s. From the start of the snapshot restore to a verified result: about
9m51s.

What this proves, and what it does not:

- It proves a restored database's history rows still reference the correct retained object version, and that the
  integrity check passes against the real bucket from a recovered database.
- Instance B came from a **manual snapshot** of A, not point-in-time recovery; A itself was a point-in-time restore
  of the live database. The PITR path of the batch itself (restoring to a moment after the batch existed) was not
  exercised.
- It does not cover loss of the bucket (see step 3, and cross-region replication), COMPLIANCE mode, or a real
  customer's evidence.
- The drill's temporary instances, snapshot and security group were deleted afterwards. The two evidence objects it
  and the storage test wrote remain in the history bucket under Object Lock until their retention ends (2026-12-11).

Gaps found: none in the application. Run notes: the app's edge-origin check (`x-hms-edge-secret`) applies to
in-process calls too, so a drill harness must send it; container overrides are limited to 8192 characters, so the
script is passed compressed.
