# HMS 2.0 pre-production review (main `a10da1b`)

Scope: backend API, auth, notifications, DB/migrations, frontends, CI, Terraform. Read-only; no code changed.
Method: bandit, ruff, `npm audit --omit=dev` (staff, portal, inspector), full backend pytest, targeted source review of every unauthenticated route, config validation, rate limiting, audit coverage, indexes, IaC.

## Evidence
- Backend tests: 720 passed, 105 skipped (skips are the Postgres-only suites; confirm they run in CI).
- npm audit (prod deps): 0 vulnerabilities in all three apps.
- bandit: 0 high, 1 medium (SHA-1 in Twilio signature verification, which Twilio mandates, so acceptable), the rest low (test-style asserts, `try/except/pass`, "hardcoded password" string names).
- Secrets: no `.env` tracked; `backend/hms_dev.db` exists locally but is git-ignored.
- Dockerfile runs as non-root; CI actions are pinned by SHA.

## Status
- **#3 unsubscribe: addressed.** Links carry an HMAC-signed token that includes its expiry (default 90 days, `notification_unsubscribe_token_ttl_seconds`); GET only confirms, POST changes; RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` headers are sent for informational email through the message model, SMTP and SES; the change is audited. RFC 8058 needs an HTTPS URL, so a plain-http local `public_base_url` sends no headers.
- **#9 audit/sync guard: addressed.** `test_mutation_audit_coverage.py` checks AuditEvent and SyncChange separately for all 73 mutating routes against the exception model now written in AGENTS.md ("Audit and sync"). The full per-route matrix is in [2026-11-02-audit-sync-matrix.md](2026-11-02-audit-sync-matrix.md). It proves the writers are reachable, not that each event's content is right.
- Everything else below is open.

## Blockers for prod
1. **No prod or staging infrastructure exists.** `infra/terraform/envs/prod` and `staging` are empty; only `dev` is defined. Prod needs its own state, network, RDS, secrets and domain before launch.
2. **Dev RDS settings are not prod-safe if copied:** `skip_final_snapshot = true`, `enable_deletion_protection` defaults to false, no `multi_az`, 7-day backup retention, no PITR/restore drill documented. Make these prod variables explicit and default-safe.
3. **Unauthenticated, unsigned unsubscribe (fixed in #111)** (`GET /notifications/unsubscribe?party_type&party_id&category`): anyone holding or guessing a party id can opt that person out of non-essential email. It is also a state-changing GET, so mail scanners that prefetch links can trigger it. Use a signed, expiring token (HMAC over party/category) and POST for the change (RFC 8058 one-click uses POST).

## Should fix before or soon after launch
4. **Generic webhook path** (`/notifications/webhooks/{provider}` for non-Twilio/SNS) relies on a shared secret header; it is open in local/test only, which is correct. Confirm `notification_webhook_secret` is set in every deployed env, or remove the generic provider.
5. **Search uses `lower(col) LIKE '%term%'`** (customers, assets, retests). Leading wildcards cannot use a b-tree index, and `%`/`_` typed by the user act as wildcards. Fine at current volumes; plan `pg_trgm` GIN indexes and escape wildcards before data grows.
6. **List endpoints cap at 50 (default) / 100-1000 depending on route; the web UI loads only the first 50** in several lists. The UI now says so, but heavy customers will need server-side search/paging everywhere.
7. **Broad API rate limiter fails open on Redis errors** (login and reset limiters fail closed). This is a deliberate availability choice; document it and alert on Redis health.
8. **Postgres-only tests are skipped locally** (105 skipped). Make sure CI runs them against a real Postgres so migrations 0001-0023 and the audit-redaction tests are exercised on every PR.
9. **Audit/sync coverage** is proven by one end-to-end test (`test_rc_product_flow_postgres`) rather than a per-route guard. Add a test that enumerates mutating routes and asserts an `AuditEvent` and `SyncChange` per call, since AGENTS.md makes this a non-negotiable.
10. **Port 80 is open to 0.0.0.0/0 on the ALB** (dev). Confirm it only redirects to 443.

## Good (verified)
- Auth: refresh-cookie browser auth with origin checks, TOTP MFA with AES-GCM at rest and key versioning, hashed recovery codes, password-reset tokens encrypted, per-account and per-IP login and reset throttles.
- Config validation refuses under-configured deployed environments (explicit environment, HMAC secret, MFA key, allowed origins required).
- HTTP hardening: CSP, HSTS, body-size cap, shared secret between edge and origin, trusted-proxy hop count.
- Webhooks: Twilio and SNS signatures verified, 503 when verification is unconfigured.
- Data: parameterised queries throughout (no string-built SQL found), soft deletes, customer-scoped queries, 73 indexes in migrations incl. FKs and booking schedule.
- Frontends: no `dangerouslySetInnerHTML`, no tokens in storage; inspector persists only its outbox and a per-user device id in localStorage.

## Not covered
Live DEV behaviour (UNVERIFIED LIVE), load/performance testing, a manual penetration test, dependency audit of Python lockfile (`pip-audit` not installed here), certificate-engine service internals, and the Helm chart.
