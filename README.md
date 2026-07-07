# BAT Engineering HMS 2.0

Greenfield rebuild of BAT Engineering's Hose Management System. The current
development build includes a FastAPI backend and a React/Vite staff operations
console for core HMS records, inspections, retest schedules, certificates,
analytics, users, and devices.

Do not connect local development commands to production HMS data. The included
seed data is synthetic and HMS-shaped for demo and verification use only.

## Repository Layout

```text
backend/                  FastAPI API, SQLAlchemy models, Alembic migrations
web/apps/staff/           React/Vite staff operations console
web/apps/inspector/       React/Vite field inspector app with local outbox
tooling/                  Migration and synthetic-data utilities
docs/                     Design notes, implementation plans, and decisions
.github/workflows/ci.yml  Backend and frontend CI checks
```

## Run everything in Docker (recommended)

The fastest way to run the full stack — Postgres, Redis, the certificate engine,
the API, and the Celery worker — is Docker Compose. Only Docker is required.

```bash
docker compose up --build            # backend stack
docker compose --profile frontend up --build   # also build & serve the staff UI
```

On startup a one-shot `migrate` service applies migrations and seeds synthetic
demo data, then the API and worker come up. Then:

- API + docs: http://localhost:8000/api/v1/docs
- Readiness (DB + Redis): http://localhost:8000/health/ready
- Staff UI (frontend profile): http://localhost:8080
- Postgres: `localhost:5432` (`hms`/`hms`), Redis: `localhost:6379`

Smoke-test the certificate + Celery + Redis path end to end:

```bash
# health
curl http://localhost:8000/health/ready

# find an approved inspection id, then bulk-generate certificates (uses the
# worker + engine), and poll the job
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
- Swagger UI: `http://127.0.0.1:8000/api/v1/docs`
- OpenAPI JSON: `http://127.0.0.1:8000/api/v1/openapi.json`

## Staff App Setup

In another terminal:

```bash
cd web/apps/staff
cp .env.example .env
npm install
npm run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173/`.

When the backend is running, Vite proxies `/api` and `/health` to
`HMS_API_TARGET` from `web/apps/staff/.env`. If the backend is unavailable, the
staff UI falls back to mock data for local development.

## Inspector App Setup

In another terminal:

```bash
cd web/apps/inspector
cp .env.example .env
npm install
npm run dev -- --host 127.0.0.1
```

Open the printed Vite URL. The default configured port is `5174`.

When the backend is running, Vite proxies `/api` and `/health` to
`HMS_API_TARGET` from `web/apps/inspector/.env`. If the backend is unavailable,
the inspector UI falls back to synthetic sync bootstrap data.

The inspector app is the Phase 3B browser/mobile-web development slice. It uses
`localStorage` to simulate an offline outbox for drafts and submitted
inspections. This is not the final encrypted native offline store; Capacitor,
secure storage, QR/barcode scanning, camera capture, and real OIDC are later
phases.

## Development Auth

Authentication is still development scaffolding; real OIDC token validation is
not wired yet. Phase 3C resolves local HMS identity from persisted `users` rows
created by `uv run hms-seed`. The staff UI sends:

- `X-HMS-User-Id: staff-ui-dev`

`X-HMS-Roles` is retained only as a local fallback for unseeded development
clients. It is not the production authorization boundary.

Manual API checks can use the seeded local identity:

```bash
curl \
  -H "X-HMS-User-Id: staff-ui-dev" \
  http://127.0.0.1:8000/api/v1/customers
```

## Verification

Backend:

```bash
cd backend
uv run ruff check . ../tooling
uv run mypy src tests ../tooling
uv run pytest
```

Staff app:

```bash
cd web/apps/staff
npm test -- --run
npm run build
```

Inspector app:

```bash
cd web/apps/inspector
npm test -- --run
npm run build
```

## Current Phase Status

Completed foundation and core staff workflows:

- Customers, assets, products, and reference standards
- Inspection list/detail/create/update/submit/approve flow
- Retest schedule list/detail/update flow
- Certificate issue/revoke/supersede flow
- Analytics, sync queue placeholder workspace, audit, users, and devices UI
- Backend admin APIs for users, devices, and audit events
- Database-backed local identity resolution with seeded staff/inspector users
- Backend sync bootstrap, changes, and inspection push endpoints
- Sync push handlers for safe asset serial/tag edits and pressure-test child
  records
- Field inspector mobile-web app with work queue, inspection capture, local
  outbox, and sync queue
- GitHub Actions CI for backend, staff app, and inspector app checks

Current sync API slice:

- `GET /api/v1/sync/bootstrap`
- `GET /api/v1/sync/changes?since=0`
- `POST /api/v1/sync/push`
- `POST /api/v1/sync/operations`

Planned next phase:

- Native offline hardening for encrypted local storage and device security
- Notification rules for retests, submitted inspections, and certificate events

## Guardrails

- No secrets are committed.
- `.env` files are ignored.
- Production credentials must never be stored in this repository.
- Safety and compliance records use soft-delete, versioning, and audit history.
- Local seed and mock data must remain synthetic until an approved migration plan
  is executed.
