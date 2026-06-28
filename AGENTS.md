# HMS 2.0 Agent Instructions

Use the attached HMS 2.0 Technical Design Document, Functional Specification, Notifications Specification, and Master Build Prompt as source of truth.

## Non-Negotiables

- Backend: Python, FastAPI, PostgreSQL, SQLAlchemy 2.0 async, Alembic, `uv`.
- Do not use the unrelated existing Gym Tracker app as an HMS base.
- Never commit secrets, database passwords, `.env`, generated certificates, or production data.
- Do not scrape or write to the legacy production HMS system.
- Use synthetic and deliberately dirty development data until a controlled migration sample is approved.
- Never hard-delete customers, assets, inspections, or certificates.
- Never store or display passwords.
- Every mutation must produce an `AuditEvent` and `SyncChange`.
- Mobile field app is Ionic + Angular + Capacitor, not Swift/Kotlin native.

## Build Order

Build phases in order:

1. Phase 0 - Foundations and schema
2. Phase 1 - Core web HMS records
3. Phase 2 - Inspections and certificates
4. Phase 3 - Offline inspector app, sync engine, notifications, customer portal
5. Phase 4 - Deferred analytics, integrations, rules hardening, AI

Ask before implementing items marked `[CONFIRM]` in the master build prompt.
