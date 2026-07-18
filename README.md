# BAT Engineering HMS 2.0

Greenfield rebuild of BAT Engineering's Hose Management System — a
safety-critical, compliance-driven platform for managing pressure-bearing hose
assets, their inspections, and their test certificates.

The build is a modular-monolith **FastAPI** backend plus two internal **gRPC**
services, a **React/Vite** staff console and field inspector app, backed by
**PostgreSQL**, **Redis**, and **Celery**, and packaged to run end-to-end with
**Docker Compose**.

Do not connect local development commands to production HMS data. Operational
seed records are synthetic and HMS-shaped for demo and verification use only.
The reference catalogue also includes approved values transcribed from supplied
legacy metadata; it does not import or connect to the production HMS database.

## Features

**Core records**
- Customers, locations, and notification contacts; products with a normalised
  working/test pressure matrix; reference data (couplings, materials, nominal
  bores, standards) as FK lookups — never free text.
- Assets with normalised A/B end configurations, lifecycle state, and
  server-side search by name / asset id / serial.
- RBAC roles + **customer row-scoping** enforced in the query layer; soft-delete,
  optimistic versioning, and a hash-chained tamper-evident **audit ledger** on
  every mutation; a monotonic `SyncChange` feed for delta sync.

**Inspections & certificates**
- Inspection workflow (draft → submit → approve/reject) with answers, pressure
  tests, and photo records.
- **Signed certificates**: issued only from an APPROVED inspection, rendered and
  **cryptographically signed (PAdES / X.509)** as archival PDFs by a standalone
  **certificate gRPC engine** (ReportLab + pyHanko), with an embedded QR code and
  SHA-256 verification hash.
- **Public verification**: unauthenticated `verify/{token}` endpoint recomputes
  the hash and reports authenticity/validity; the signed PDF is downloadable by
  token.
- **Bulk generation** runs as a tracked **Celery** job. Issuance is refused for
  `CONDEMNED`/`RETIRED` assets (single and bulk paths).

**Async jobs & caching (Redis + Celery)**
- Celery workers + **beat** scheduler on a Redis broker.
- Redis **cache-aside** layer (e.g. reference standards) that degrades gracefully
  with a circuit breaker if Redis is down; `/health/ready` reports DB + Redis.

**Notifications & alerting** (email + SMS + in-app)
- **Outbox-first, event-driven**: domain events are written in the same
  transaction as the change, so a rolled-back change never notifies (N-01).
- Relay → dispatcher → daily scheduler pipeline with **criticality tiers**,
  **consent/opt-in** (SMS requires a verified phone), **unsubscribe** (Spam Act),
  idempotent de-duplication, delivery tracking with retry + dead-letter, and full
  audit. Channel adapters: console (dev), OCI Email Delivery (SMTP), Twilio (SMS).
- Retest reminders (advance / due / overdue-with-escalation), certificate and
  asset-condemned events, a preference centre, and phone verification.

**Authentication & authorization**
- Three modes via `AUTH_MODE`: `dev` (headers, local only), `bearer` (local
  HS256 tokens from **Argon2 password login**), and `oidc` (**real OIDC** —
  RS256/ES256 tokens verified against the IdP's **JWKS**, checking iss/aud/exp).
- Identity from the token; the HMS **role is DB-authoritative**. Passwords are
  Argon2-hashed and never returned in any response.

**Offline sync engine**
- `sync/bootstrap`, `sync/changes` (monotonic cursor), and `sync/push`
  (idempotent, conflict-aware) endpoints; device registration + governance.

**Frontends**
- Staff operations console (records, inspections, certificates, retest, sync
  queue, customers, products, reference data, users, devices, audit, analytics).
- Field inspector app (work queue, inspection capture, local outbox) — a
  mobile-web development slice.

**Ops & infra**
- Docker Compose full stack; per-service Dockerfiles; GitHub Actions CI;
  OpenTelemetry instrumentation dependencies.

## Repository Layout

```text
backend/                  FastAPI API, SQLAlchemy models, Alembic migrations, Celery
services/certificate/     gRPC certificate engine (ReportLab render + pyHanko signing)
services/rules/           Rules/standards engine (placeholder)
web/apps/staff/           React/Vite staff operations console
web/apps/inspector/       React/Vite field inspector app with local outbox
web/apps/portal/          Customer portal (placeholder)
infra/                    Terraform + Helm skeletons (placeholder)
tooling/                  Migration and synthetic-data utilities
docs/                     Design notes, implementation plans, and decisions
docker-compose.yml        Full local stack (postgres, redis, engine, api, worker, beat, staff)
.github/workflows/ci.yml  Backend and frontend CI checks
```

## Run everything in Docker (recommended)

The fastest way to run the full stack — Postgres, Redis, the certificate engine,
the API, the Celery worker, and the beat scheduler — is Docker Compose. Only
Docker is required.

```bash
docker compose up --build            # backend stack
docker compose --profile frontend up --build   # also build & serve the staff UI
```

On startup a one-shot `migrate` service applies migrations, seeds synthetic
demo data, and creates one development login for each of the six HMS roles.
Temporary passwords are printed once in the `migrate` service output; each
account must change its password and enroll an authenticator on first sign-in.
Then:

- API + docs: http://localhost:8000/api/v1/docs
- Readiness (DB + Redis): http://localhost:8000/health/ready
- Staff UI (frontend profile): http://localhost:8080
- Postgres: `localhost:5432` (`hms`/`hms`), Redis: `localhost:6379`

View first-run credentials without writing them to a file:

```bash
docker compose logs migrate
```

To rotate all local temporary passwords for another acceptance run:

```bash
docker compose run --rm migrate sh -c \
  'alembic upgrade head && python -m hms_backend.app.tooling.local_seed --auth-test-accounts --reset-existing'
```

Run the six-role browser acceptance suite against the running Docker stack:

```bash
cd web/apps/staff
npx playwright install chromium   # first run only
npm run test:e2e
```

The Playwright setup rotates the synthetic accounts in memory before the run.
It does not write passwords, authenticator secrets, recovery codes, traces, or
screenshots to test artifacts.

Smoke-test the certificate + Celery + Redis path end to end:

```bash
curl http://localhost:8000/health/ready

# bulk-generate certificates (worker + engine), then poll the job
curl -X POST -H "X-HMS-User-Id: reviewer-1" -H "X-HMS-Roles: REVIEWER" \
  -H "Content-Type: application/json" -d '{}' \
  http://localhost:8000/api/v1/certificates/bulk-generate
curl -H "X-HMS-User-Id: reviewer-1" -H "X-HMS-Roles: REVIEWER" \
  http://localhost:8000/api/v1/jobs/certificate-batches/<JOB_ID>

# a generated certificate's public token verifies + downloads the signed PDF
curl http://localhost:8000/api/v1/certificates/verify/<PUBLIC_TOKEN>
```

Tear down (add `-v` to also drop the Postgres/Redis/object-store volumes):

```bash
docker compose down
```

Just need Redis (e.g. to run the app locally with `uv`)? `docker compose up -d
redis`.

> Note: the committed `backend/uv.lock` may lag `pyproject.toml`; the image
> resolves dependencies at build time. Refresh the lock on a Python 3.12 host
> with `cd backend && uv lock`.

## Prerequisites (local, non-Docker)

- Python 3.12+
- `uv`
- Node.js 20+
- npm
- Redis (for cache + Celery) — `docker compose up -d redis`

## Backend Setup

```bash
cd backend
cp .env.example .env
uv sync --dev
uv run alembic upgrade head
uv run hms-seed
uv run uvicorn hms_backend.app.main:app --reload
```

The API is available at:

- Health: `http://127.0.0.1:8000/health`
- Readiness: `http://127.0.0.1:8000/health/ready`
- Swagger UI: `http://127.0.0.1:8000/api/v1/docs`

Certificate signing, bulk jobs, and notifications require their companion
processes — see `backend/README.md` for running the certificate engine, the
Celery worker, and beat locally.

## Staff App Setup

```bash
cd web/apps/staff
cp .env.example .env
npm install
npm run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173/`. Vite proxies `/api` and `/health` to
`HMS_API_TARGET`. Once a user is authenticated, API errors are displayed and
never replaced with mock identity or record data.

### Browser-auth secrets

Generate independent values for any shared or deployed environment:

```bash
openssl rand -base64 48                 # AUTH_BEARER_HMAC_SECRET
openssl rand -base64 32                 # AUTH_MFA_ENCRYPTION_KEY
openssl rand -base64 48                 # AUTH_RECOVERY_CODE_PEPPER
```

Store deployed values in the platform secret manager, not GitHub variables,
Terraform state, image layers, or `.env` files. Set
`AUTH_BROWSER_ALLOWED_ORIGINS` to the exact staff-console HTTPS origin and keep
`AUTH_BROWSER_COOKIE_SECURE=true` outside local development.

The MFA encryption key is versioned by `AUTH_MFA_KEY_VERSION`. During rotation,
place the old and new keys in `AUTH_MFA_ENCRYPTION_KEYS`, select the new version,
and retain the previous key until all enrolled TOTP secrets have been rewrapped
or those users have reset MFA. Deleting the previous key first permanently
prevents verification of still-encrypted enrollments. Rotating the
bearer signing secret invalidates active access tokens; rotating the recovery
pepper invalidates all unused recovery codes and therefore requires issuing new
codes through the approved reset workflow.

## Inspector App Setup

```bash
cd web/apps/inspector
cp .env.example .env
npm install
npm run dev -- --host 127.0.0.1
```

Open the printed Vite URL (default port `5174`). It uses `localStorage` to
simulate an offline outbox. This is the mobile-web development slice — the final
encrypted native store (Capacitor + SQLCipher), biometric unlock, and QR/camera
capture are later phases.

## Authentication

`AUTH_MODE` selects the mode:

- **`dev`** (default, local only) — `X-HMS-User-Id` resolves a persisted user
  (its DB role is authoritative); `X-HMS-Roles` is a fallback for unseeded ids.
- **`bearer`** — locally issued HS256 tokens from Argon2 password login
  (`POST /api/v1/auth/login`).
- **`oidc`** — real OIDC tokens (RS256/ES256) verified against the provider's
  JWKS. Configure `AUTH_OIDC_ISSUER` / `AUTH_OIDC_AUDIENCE`.

```bash
# dev-mode manual check
curl -H "X-HMS-User-Id: staff-ui-dev" http://127.0.0.1:8000/api/v1/customers
```

See `backend/README.md` for the full login flow and settings.

## Verification

Backend:

```bash
cd backend
uv run ruff check . ../tooling
uv run mypy src tests ../tooling
uv run pytest
```

Certificate engine:

```bash
cd services/certificate
uv run pytest
uv run ruff check src tests
```

Frontends:

```bash
cd web/apps/staff && npm test -- --run && npm run build
cd web/apps/inspector && npm test -- --run && npm run build
```

## Status

Delivered (v1, Phases 0–3 with parts of the plan complete end-to-end):

- Core records, inspections, and the signed-certificate lifecycle (issue →
  verify → download), including the standalone certificate gRPC engine.
- Bulk certificate generation as a tracked Celery job; Redis cache + readiness.
- Full notifications subsystem (outbox → relay → dispatch → daily scheduler)
  with email/SMS/in-app adapters, consent/tiers/idempotency/audit.
- Auth hardening: dev / local-bearer (Argon2) / real OIDC (JWKS) with
  DB-authoritative roles.
- Offline sync API (bootstrap/changes/push) + device governance.
- Dockerised full stack; staff + inspector web apps.

Not yet built (planned):

- Native Capacitor mobile packaging with encrypted offline storage, biometric
  unlock, and QR/camera capture.
- Customer portal UI (`web/apps/portal` is a placeholder).
- Cloud IaC (Terraform/Helm are skeletons) and the OpenTelemetry → Grafana stack.
- Rules/standards gRPC engine; notification quiet-hours/digest batching (N-08);
  provider delivery webhooks.

## Guardrails

- No secrets are committed; `.env` files and signing keys are ignored.
- Passwords are Argon2-hashed and never stored or displayed in plaintext.
- Safety and compliance records use soft-delete, versioning, and audit history —
  never hard-deleted.
- Certificates are signed and independently verifiable; issuance is blocked for
  condemned/retired assets.
- Local seed and mock data remain synthetic until an approved migration plan is
  executed.
