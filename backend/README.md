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
and pressure-test examples for local UI verification.

## Staff UI With Backend Data

In a second terminal:

```bash
cd ../web/apps/staff
npm install
npm run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173/`. Vite proxies `/api` and `/health` to
`http://127.0.0.1:8000`, so the staff app loads customers, assets, products, and
reference standards from the local backend when it is running.

Current auth is development header scaffolding. The staff UI sends:

- `X-HMS-User-Id: staff-ui-dev`
- `X-HMS-Roles: HMS_ADMIN`

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
