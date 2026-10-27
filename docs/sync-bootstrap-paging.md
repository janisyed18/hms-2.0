# Sync bootstrap: paging, resume and old-client compatibility

`GET /api/v1/sync/bootstrap` hands the offline Inspector app the records it may see.
Protocol version 2 replaces the single unbounded response with keyset pages. The
implementation is `backend/src/hms_backend/app/api/sync_bootstrap.py` (engine, token,
scope) and `sync.py` (the endpoint).

## Protocol 2

| | |
|---|---|
| Capability signal | request header `X-HMS-Sync-Protocol: 2` (Inspector app 0.2.0 sends it). A query parameter is not the signal. |
| Page size | `limit`, default **200**, hard maximum **500** (`422` above). Records and work contexts share the budget. |
| Order | sections in `BOOTSTRAP_ENTITY_ORDER` (rows by `id`), then inspector work contexts by `(appointment_id, assignment_id)`. A position is `(section, last key)`; the next page is strictly after it. |
| Watermark | page 1 reads `S = max(SyncChange.seq)` **before** any data; every page returns `S` as `cursor` and carries it in the token. |
| Finish | after the last page the client reads `/sync/changes?since=S` until `has_more` is false, applies it, and only then replaces its offline dataset. |
| Scope changes | assignment changes are not in the change feed. The token carries a digest of the caller's scope taken before page 1; the last page recomputes it and sets `scope_changed` if it moved. The client discards the partial copy and restarts (at most 3 times). |

### Why nothing committed is missed

A change committed after `S` is either already in the pages (the client applies it again
from the feed, idempotently) or only in the feed. A change at or before `S` is already
visible to the page reads. Duplicates are acceptable; omissions are not.

### Query behaviour

Visibility is expressed in SQL per entity (`scope_clauses`), so a page costs a fixed
number of statements (one per section it touches, plus the asset rating lookups) however
large the tables are. Models eager-load their relationships; bootstrap queries switch
that off (`lazyload("*")`) because a single customer would otherwise drag its whole
portfolio into memory. `/sync/changes` still checks visibility row by row; a change page
is bounded by `limit`.

## Continuation token

`base64url(json) . base64url(HMAC-SHA256)`. Payload: token version, protocol, `S`,
section, last key, user id, device id, scope digest, issue time. Key: HMAC of the
existing `AUTH_BEARER_HMAC_SECRET` with the label `hms-sync-bootstrap-page-token-v1`
(no new secret). Expires after 6 hours. Invalid tokens are `400
SYNC_PAGE_TOKEN_INVALID`; the client restarts from page 1.

The token is **not authorisation**. Every request re-authenticates, re-checks the device
(owner, revoked) and applies the caller's *current* scope in SQL, so revoking access
between pages shrinks later pages and sets `scope_changed`.

If no signing secret is configured outside local/test, paging answers `503` (fail closed).

## Old clients (temporary technical debt)

A client without the protocol header gets the single-response shape only while everything
it may see fits in `LEGACY_BOOTSTRAP_MAX_ROWS` (**2,000** items). It is read with the same
scoped keyset queries, never more than that plus one row. Above the ceiling the answer is
`426 Upgrade Required` (`SYNC_CLIENT_UPGRADE_REQUIRED`, `Upgrade: hms-sync/2`); it is never
a truncated success.

**Removal condition:** delete `_legacy_bootstrap` and the constant when no registered
device reports an app version below `0.2.0` (`devices.app_version`) and the paged Inspector
has been live for one offline window (7 days, `Device.offline_window_days`).

## Inspector

Sent protocol 2 with app `0.2.0`; app `0.3.0` sends protocol 3 (see below), and its snapshot scope is keyed by that protocol so a snapshot taken under the older lifecycle projection is never reused. All of its assigned-work data lives in a
persistent IndexedDB store (`web/apps/inspector/src/offline/syncStore.ts`), separate from
the outbox, which is not touched by any of this.

### Store design

Database `hms-inspector-sync`, IndexedDB version 1 (`SYNC_STORE_VERSION`), storage schema
1 (`STORAGE_SCHEMA`, part of every key). Every entry is keyed by
`JSON([userId, deviceId, syncProtocol, storageSchema])`, so a user, a device
registration, a protocol or a schema version can never read another's data.

| Object store | Key | Holds |
|---|---|---|
| `active` | scope key | the **last-good snapshot**: records, work contexts, final reconciled cursor, device metadata, absolute `expiresAt`, `promotedAt` |
| `staging` | scope key | progress of a bootstrap in flight: watermark `S`, continuation token, `pagesComplete`, change cursor, device response, chunk count, `updatedAt` |
| `chunks` | `[scope key, seq]` | one entry per completed bootstrap page or reconciled change batch |

Each completed page or change batch is **one transaction** that writes its chunk and the
updated progress, so the cost is per page (not per record, and never a rewrite of the
whole snapshot), and a crash leaves either the previous or the next consistent state.

### Flow

1. App start: load `active` for the signed-in user and device. If valid and unexpired,
   the workspace shows it immediately (label "Showing saved assignments"), whether or not
   the network is up. An expired snapshot is deleted and the existing "Offline access
   expired" message is shown.
2. A refresh runs `bootstrap()`. If `staging` exists it continues from the stored token
   (or, if the pages were complete, from the stored change cursor); otherwise it starts
   at page one. Nothing partial is ever shown.
3. Promotion: only after all pages, `scope_changed == false` and the change feed is
   reconciled, **one readwrite transaction** over `active`, `staging` and `chunks` writes
   the new snapshot and removes the staging data. A crash leaves the old snapshot or the
   new one, never a mixture; a failed promotion leaves both the old snapshot and the
   staging as they were.
4. The workspace swaps its React state to the promoted result.

### Failure handling

| Event | Staging | Active snapshot |
|---|---|---|
| network error / 5xx | kept, resume later | untouched |
| `SYNC_PAGE_TOKEN_INVALID`, watermark mismatch, `scope_changed` | deleted, restart at page one (max 3 restarts) | untouched until the clean copy is promoted |
| `403` (device revoked / permission withdrawn) | deleted | deleted |
| `426` | deleted | untouched |
| corrupt staging (bad shape, chunk count mismatch) | deleted | untouched |
| corrupt active | n/a | deleted, nothing invented, fetched again when online |
| storage unavailable or failing | bootstrap continues from memory (not restartable) | n/a |

An old (pre-paging) server answer is accepted as one complete response and promoted the
same way. Incompatible persisted data from a future schema version may be discarded: none
existed before this release.

### Expiry

`expiresAt = promotedAt + min(device.offline_window_days, 7) days`, fixed when a snapshot
is promoted. Loading it, or a failed or partial refresh, never extends it; only a
successful full refresh does.

### Logout and user switch

Everything is keyed by user, so another user never sees it. In addition, an explicit
sign-out removes that user's `active`, `staging` and `chunks` on every device, and signing
in as a different user in the same page session removes the previous user's. Session
expiry deliberately keeps the data (a flaky network can also look like an expired
session) until its offline expiry. The outbox follows its existing rules and is not
cleared by any of this.

### Threat model

The data is stored unencrypted in same-origin IndexedDB, like the existing outbox. A key
kept in the same browser next to the ciphertext would add no protection, so there is no
pretend encryption. The controls are: per-user/device scoping, removal on explicit
sign-out and user switch, the offline expiry, deletion on revocation, and the existing
CSP/XSS hardening. Anyone with the unlocked device profile, or script running in the app's
origin, can read it. If HMS later gets a device-bound key (for example OS-backed storage),
encryption at rest can be added without changing the protocol.

### Known limit

Opening the app offline after a full browser restart still requires the sign-in check
(`/auth/browser/refresh`, `/auth/browser/me`) to succeed, so the saved snapshot appears
once the user is authenticated again. Persisting the identity for fully offline cold start
is a separate decision.


## Protocol 3: the native inspection lifecycle

Protocols are capabilities, not one number. **Paging** is protocol 2 and page tokens stay
bound to it (`PAGING_PROTOCOL_VERSION = 2`), so a token is valid for a protocol 2 or a
protocol 3 client alike. The **native lifecycle** is protocol 3
(`LIFECYCLE_PROTOCOL_VERSION`); `CURRENT_SYNC_PROTOCOL_VERSION` is 3.

| Client header | Server answers |
|---|---|
| none / 1 | legacy single-response bootstrap (temporary, as before) |
| 2 | paged bootstrap; `IN_PROGRESS` is shown as `DRAFT` |
| 3 | paged bootstrap; the real status, `rejection_reason`, lifecycle actions accepted |
| above 3 | served at 3, and the response says `protocol_version: 3` |

The projection (in progress reads as a draft) is applied in one place for every surface
- bootstrap, `/sync/changes`, push results and conflicts, and replayed results - so it
cannot be missed on one of them. The v3 app refuses any bootstrap answered below 3 rather
than read it as a legacy full bootstrap: that would show in-progress work as a draft.

### Lifecycle actions

An Inspection operation may carry `lifecycle_actions`, an ordered list of `start`,
`rework` and `submit`; `op` stays `create` or `update` and `payload` carries only form
data (no `status`). The whole sequence is checked before anything is written (legal
transitions from the current status, `submit` last, work only written while in progress,
complete at submit), then applied in a fixed order through the shared workflow functions:
transitions that make it editable, the form data, then the submit. A stale `base_version`
conflicts before any transition. The inspection row is locked for the sequence, like the
staff app's transitions.

An operation with no `lifecycle_actions` is the earlier shape and is applied as before,
including the protocol 2 draft-to-submitted bridge (`start_and_submit`), so operations
queued by app 0.2.0 still drain after the upgrade. `start_and_submit` stays until
protocol 2 clients are retired.

On the device, saving again replaces the unsynced inspection operation but keeps its
actions, so start, edit, submit reaches the server as `["start", "submit"]` with the
latest form data; the outbox pushes inspections before anything that refers to them.
