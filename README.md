# BAT Engineering HMS 2.0

Greenfield rebuild of BAT Engineering's Hose Management System.

This repository is intentionally separate from the existing project folders in `/Users/janisyed18/Downloads/project`.

## Current State

- Git repository initialized.
- Phase 0 folder structure created.
- Backend initialized with `uv`.
- Minimal FastAPI app and foundation SQLAlchemy models added.
- Initial tests cover `/health`, UUIDv7 IDs, soft-delete tombstones, `SyncChange`, and audit-chain verification.

## Backend

```bash
cd backend
uv sync
uv run pytest
uv run uvicorn hms_backend.app.main:app --reload
```

The API serves:

- Health: `GET /health`
- OpenAPI: `/api/v1/openapi.json`
- Swagger UI: `/api/v1/docs`

## Guardrails

- No secrets are committed.
- `.env` files are ignored.
- Passwords must never be stored or displayed.
- Safety/compliance records use soft-delete and audit history.
- Syncable tables use client-generatable UUIDv7 IDs, versioning, timestamps, tombstones, and legacy provenance columns.
