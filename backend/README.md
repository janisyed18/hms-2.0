# BAT Engineering HMS 2.0 Backend

FastAPI backend for the HMS 2.0 development build. The default configuration
uses a local SQLite database at `./hms_dev.db`; do not point local development
commands at production HMS data.

## Local Setup

```bash
uv sync
uv run alembic upgrade head
uv run python -m hms_backend.app.tooling.local_seed
uv run uvicorn hms_backend.app.main:app --reload
```

The seed command uses synthetic HMS-shaped records only. It is idempotent, so it
can be run more than once against the same local database.
The seed includes customers, assets, products, retest schedules, inspections,
pressure-test examples, and an issued certificate for local UI verification.

## Sync API

Phase 3A adds the backend sync contract for offline-capable field clients:

- `GET /api/v1/sync/bootstrap` registers/updates a device and returns the
  caller's scoped current records.
- `GET /api/v1/sync/changes?since=0` returns ordered `SyncChange` upserts and
  tombstones after a monotonic cursor.
- `POST /api/v1/sync/push` applies batched inspection outbox operations with
  idempotency keys and optimistic version conflict reporting.
- `POST /api/v1/sync/operations` is an alias for clients following the original
  mobile addendum endpoint name.

Sync requests require the development HMS identity headers plus device headers:

- `X-HMS-Device-Id`
- `X-HMS-Device-Platform`
- `X-HMS-App-Version`

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

Current auth is development header scaffolding. The staff UI sends:

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

## Local Endpoints

- Health: `GET /health`
- OpenAPI: `GET /api/v1/openapi.json`
- Swagger UI: `GET /api/v1/docs`
