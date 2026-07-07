# BAT Engineering HMS 2.0 Backend

FastAPI backend for the HMS 2.0 development build. The default configuration
uses a local SQLite database at `./hms_dev.db`; do not point local development
commands at production HMS data.

## Local Setup

```bash
uv sync
uv run alembic upgrade head
uv run hms-seed
uv run uvicorn hms_backend.app.main:app --reload
```

The seed command uses synthetic HMS-shaped records only. It is idempotent, so it
can be run more than once against the same local database.
The seed includes customers, assets, products, retest schedules, inspections,
pressure-test examples, an issued certificate, and synthetic staff/inspector
users for local UI verification.

## Sync API

Phase 3A adds the backend sync contract for offline-capable field clients:

- `GET /api/v1/sync/bootstrap` registers/updates a device and returns the
  caller's scoped current records.
- `GET /api/v1/sync/changes?since=0` returns ordered `SyncChange` upserts and
  tombstones after a monotonic cursor.
- `POST /api/v1/sync/push` applies batched outbox operations with idempotency
  keys and optimistic version conflict reporting. The current slice supports
  inspection create/update, safe asset serial/tag updates, and standalone
  pressure-test result create/update operations.
- `POST /api/v1/sync/operations` is an alias for clients following the original
  mobile addendum endpoint name.

Sync requests require the development HMS identity header plus device headers:

- `X-HMS-User-Id`
- `X-HMS-Device-Id`
- `X-HMS-Device-Platform`
- `X-HMS-App-Version`

`X-HMS-Roles` remains available only as a local fallback for unseeded
development clients.

## Staff UI With Backend Data

In a second terminal:

```bash
cd ../web/apps/staff
npm install
npm run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173/`. Vite proxies `/api` and `/health` to
`http://127.0.0.1:8000`, so the staff app loads customers, assets, products,
reference standards, inspections, and certificates from the local backend when
it is running.

Phase 3D introduces an explicit auth boundary with two modes:

- `AUTH_MODE=dev` keeps local HMS identity headers available for development
  and resolves `X-HMS-User-Id` against persisted `users` rows seeded by
  `uv run hms-seed`.
- `AUTH_MODE=bearer` rejects HMS dev headers and requires
  `Authorization: Bearer <token>`. The current implementation validates HS256
  tokens using `AUTH_BEARER_HMAC_SECRET`, optional issuer/audience settings, and
  then resolves the token subject against persisted HMS users. External OIDC
  JWKS integration remains a later adapter on top of this boundary.

The staff UI still sends local dev headers by default:

- `X-HMS-User-Id: staff-ui-dev`

`X-HMS-Roles` remains available only in `AUTH_MODE=dev` and only as a local
fallback when no seeded user row exists. Manual API checks can use:

```bash
curl \
  -H "X-HMS-User-Id: staff-ui-dev" \
  http://127.0.0.1:8000/api/v1/customers
```

The current resolved session is available at:

- `GET /api/v1/auth/me`

Admin endpoints added in Phase 3C:

- `GET/POST/PATCH/DELETE /api/v1/admin/users`
- `GET/PATCH /api/v1/admin/devices`
- `GET /api/v1/admin/audit-events`

## Verification

```bash
uv run ruff check . ../tooling
uv run mypy src tests ../tooling
uv run pytest
```

Frontend checks:

```bash
cd ../web/apps/staff
npm test -- --run
npm run build
```

## Certificate generation & verification

Issuing a certificate from an **approved** inspection renders a signed,
archival PDF via the certificate engine (a separate gRPC service) and stores it
in object storage. Start the engine in its own terminal first:

```bash
cd ../services/certificate
uv sync
uv run hms-certificate-engine        # listens on 127.0.0.1:50051
```

Then, with the backend running:

```bash
# Issue (server renders + signs; omit pdf_object_key to trigger generation)
curl -X POST \
  -H "X-HMS-User-Id: reviewer-1" -H "X-HMS-Roles: REVIEWER" \
  -H "Content-Type: application/json" \
  -d '{"valid_until": "2027-07-07"}' \
  http://127.0.0.1:8000/api/v1/inspections/<APPROVED_INSPECTION_ID>/certificate
```

The response includes the `public_token`. Anyone can then verify without auth:

- Verify: `GET /api/v1/certificates/verify/{public_token}` — recomputes the
  SHA-256 content hash and reports `valid`, `hash_matches`, and status.
- Download: `GET /api/v1/certificates/verify/{public_token}/pdf` — the signed PDF.

The QR code printed on the PDF points at the verify URL
(`public_base_url` config). If the engine is not running, issuance returns
`503`; supplying `pdf_object_key` + `verification_hash` keeps the legacy
bring-your-own-artifact path (used by imports).

Relevant settings (env or `.env`): `CERTIFICATE_SERVICE_ADDRESS`,
`PUBLIC_BASE_URL`, `OBJECT_STORAGE_DIR`, `ISSUER_NAME`, `ISSUER_IDENTIFIER`.

## Bulk certificate generation (Celery)

Bulk generation runs as a tracked background job. It needs **Redis** (broker +
result backend) and a **Celery worker**, plus the certificate engine running.

```bash
# 1. Redis (broker) — e.g. via Docker
docker run -p 6379:6379 redis:7

# 2. Certificate engine (separate terminal)
cd ../services/certificate && uv run hms-certificate-engine

# 3. Celery worker (separate terminal)
cd backend
uv run celery -A hms_backend.app.core.celery_app:celery_app worker --loglevel=info
```

Enqueue a batch (omit `inspection_ids` to target every eligible APPROVED
inspection that has no certificate yet):

```bash
curl -X POST \
  -H "X-HMS-User-Id: reviewer-1" -H "X-HMS-Roles: REVIEWER" \
  -H "Content-Type: application/json" -d '{}' \
  http://127.0.0.1:8000/api/v1/certificates/bulk-generate
```

Poll progress (per-item results, counts, and status
`PENDING → RUNNING → COMPLETED / COMPLETED_WITH_ERRORS / FAILED`):

```bash
curl -H "X-HMS-User-Id: reviewer-1" -H "X-HMS-Roles: REVIEWER" \
  http://127.0.0.1:8000/api/v1/jobs/certificate-batches/<JOB_ID>
```

Each item is processed in its own transaction, so one failure never rolls back
the others. Without a worker/broker you can run tasks inline for local testing by
setting `CELERY_TASK_ALWAYS_EAGER=true`. Settings: `REDIS_URL`,
`CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND`, `CELERY_TASK_ALWAYS_EAGER`,
`BULK_CERTIFICATE_MAX_ITEMS`.

## Redis (cache & broker)

Redis backs two things: the **cache-aside layer** and the **Celery** broker /
result backend. Start it with Docker from the repo root:

```bash
docker compose up -d redis      # redis://127.0.0.1:6379
```

The cache degrades gracefully: if Redis is unreachable, requests still serve from
the database (after one fast-failing attempt a circuit breaker skips cache calls
for `CACHE_CIRCUIT_BREAKER_SECONDS`). Reference standards (`GET
/api/v1/reference/standards`) are cached and invalidated automatically on any
standard create/update/delete — the pattern (`core/cache.py`) extends to other
global, read-heavy lookups.

Readiness reflects dependencies:

```bash
curl http://127.0.0.1:8000/health/ready
# {"status":"ready","checks":{"database":"ok","redis":"ok"}}
```

The database is the hard dependency (503 if down); Redis is reported but, because
the app degrades gracefully, does not by itself fail readiness.

Settings: `REDIS_URL`, `CACHE_ENABLED`, `CACHE_TTL_SECONDS`,
`CACHE_CIRCUIT_BREAKER_SECONDS`, `REDIS_CONNECT_TIMEOUT_SECONDS`,
`REDIS_COMMAND_TIMEOUT_SECONDS`.

## Notifications

Event-driven, outbox-first notifications (email + SMS + in-app) per the
Notifications & Alerting spec. Flow:

1. Business code writes a domain event to the **transactional outbox** in the
   same transaction as the change (e.g. certificate issued, inspection
   submitted, asset condemned) — so a rolled-back change never notifies (N-01).
2. The **relay** (`notifications.relay`, Celery beat every 30s) turns committed
   events into per-recipient, per-channel `Notification` rows, applying the
   criticality-tier + consent policy: Critical/Transactional are mandatory;
   Important sends email always and SMS only on opt-in; Informational honours
   unsubscribe; SMS always needs a verified phone (N-04, N-05, N-10). Each row
   has an idempotency key so duplicates never occur (N-07).
3. The **dispatcher** (`notifications.dispatch`, every 30s) sends PENDING rows
   through channel adapters (console in dev; OCI Email Delivery + Twilio in
   `live` mode), with retry/backoff and dead-lettering (N-06).
4. The **daily scheduler** (`notifications.schedule_retests`, 07:00 UTC) raises
   advance / due / overdue-with-escalation retest reminders (N-02, N-11).

The `beat` service in `docker-compose.yml` drives all three. In dev
(`NOTIFICATION_CHANNEL_MODE=console`, the default) messages are logged rather
than sent, so no SMTP/Twilio credentials are needed.

Endpoints:

- `GET/PUT /api/v1/notifications/preferences` — per-category channel opt-in.
- `GET /api/v1/notifications/unsubscribe?party_type=&party_id=&category=` —
  public one-click unsubscribe (N-10).
- `POST /api/v1/notifications/phone/verify/request` + `/confirm` — SMS opt-in
  via one-time code (dev returns the code in the response).
- `GET /api/v1/notifications/me` — the current user's in-app feed.
- `GET /api/v1/admin/notifications` — admin delivery log (N-09).

Key settings: `NOTIFICATION_CHANNEL_MODE` (`console`|`live`),
`NOTIFICATION_SENDER_NAME`, `NOTIFICATION_MAX_ATTEMPTS`, `RETEST_ADVANCE_DAYS`,
`RETEST_OVERDUE_ESCALATION_DAYS`, and (live mode) `SMTP_*` / `TWILIO_*`.

Force one cycle without waiting for beat:

```bash
docker compose exec worker \
  celery -A hms_backend.app.core.celery_app:celery_app call notifications.relay
docker compose exec worker \
  celery -A hms_backend.app.core.celery_app:celery_app call notifications.dispatch
docker compose logs worker | grep -E "\[EMAIL\]|\[SMS\]"
```

## Local Endpoints

- Liveness: `GET /health`
- Readiness: `GET /health/ready` (database + Redis)
- OpenAPI: `GET /api/v1/openapi.json`
- Swagger UI: `GET /api/v1/docs`
