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

* Always sends protocol 2; app version `0.2.0`.
* `createSyncClient().bootstrap()` returns only a finished result. Its progress (token,
  watermark, accumulated pages) lives in memory, keyed by user, device and protocol; a
  dropped connection resumes at the last completed page, and the change phase resumes
  from the last change cursor. A rejected token, a differing watermark or `scope_changed`
  restarts from page 1.
* The previous dataset in React state is replaced only after the promote step; the outbox
  (localStorage) is never touched. Progress is discarded on sign-out and for any other
  user.
* A server that answers without `protocol_version: 2` (not yet upgraded) is accepted as a
  single complete response.

### Not done: resume after a browser refresh or app restart

The Inspector keeps no offline copy of the dataset today: only the outbox is persisted
(localStorage, per user). A refresh therefore loses the records already downloaded, and a
saved token alone would resume into an incomplete dataset. Restart-resume needs a new
persistence layer for the partial and the last-known-good datasets (IndexedDB: a
5,000-10,000 item dataset exceeds the localStorage quota), plus the encryption, quota and
eviction decisions that go with storing assigned-work data on a shared device. That is a
separate design, not a change to this protocol, which already supports it (the token is
stateless and user/device bound). Network-interruption resume is implemented and tested.
