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
tooling/                  Migration and synthetic-data utilities
docs/                     Design notes, implementation plans, and decisions
.github/workflows/ci.yml  Backend and frontend CI checks
```

## Prerequisites

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
uv run python -m hms_backend.app.tooling.local_seed
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

## Development Auth

Authentication is still development scaffolding. The staff UI sends local HMS
identity headers:

- `X-HMS-User-Id: staff-ui-dev`
- `X-HMS-Roles: HMS_ADMIN,INSPECTOR,REVIEWER`

Manual API checks can use the same headers:

```bash
curl \
  -H "X-HMS-User-Id: staff-ui-dev" \
  -H "X-HMS-Roles: HMS_ADMIN" \
  http://127.0.0.1:8000/api/v1/customers
```

## Verification

Backend:

```bash
cd backend
uv run ruff check .
uv run mypy src tests
uv run pytest
```

Staff app:

```bash
cd web/apps/staff
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
- Backend sync bootstrap, changes, and inspection push endpoints
- GitHub Actions CI for backend and staff app checks

Current sync API slice:

- `GET /api/v1/sync/bootstrap`
- `GET /api/v1/sync/changes?since=0`
- `POST /api/v1/sync/push`
- `POST /api/v1/sync/operations`

Planned next phase:

- Field/mobile offline UI and local outbox processing
- Broader push handlers for asset field edits and inspection child records
- Offline-capable field/mobile inspection workflow
- Notification rules for retests, submitted inspections, and certificate events

## Guardrails

- No secrets are committed.
- `.env` files are ignored.
- Production credentials must never be stored in this repository.
- Safety and compliance records use soft-delete, versioning, and audit history.
- Local seed and mock data must remain synthetic until an approved migration plan
  is executed.
