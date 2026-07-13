# Secure Password Reset and Authentication UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a secure, one-time email password-reset flow and a premium, responsive BAT HMS sign-in experience with Motion-based transitions, AWS SES delivery, and complete automated/browser verification.

**Architecture:** Add a persisted password-reset record containing only a token digest, plus a separate encrypted short-lived delivery envelope so the permanent notification log never stores a reset URL. The browser-auth API exposes generic reset-request and reset-confirm endpoints; the existing `AuthProvider` owns public recovery states and returns successful users to the current password-plus-MFA flow. Terraform supplies the staff CloudFront URL and a versioned delivery encryption key to ECS through Secrets Manager.

**Tech Stack:** FastAPI, SQLAlchemy async, Alembic, PostgreSQL/SQLite tests, Argon2, AES-256-GCM, Celery, AWS SES, React/Vite, TypeScript, Vitest, Testing Library, Motion, Playwright, Terraform, `uv`.

---

## File Map

Create the following focused units:

- `backend/src/hms_backend/app/core/password_reset_tokens.py` — secure token generation, digesting, and delivery-envelope encryption helpers.
- `backend/src/hms_backend/app/modules/identity/password_reset.py` — reset service state transitions and session revocation.
- `backend/src/hms_backend/app/modules/identity/models.py` — `PasswordResetToken` and `PasswordResetDelivery` ORM models.
- `backend/alembic/versions/20260713_0010_password_reset.py` — schema migration.
- `backend/tests/test_password_reset_tokens.py` — crypto helper tests.
- `backend/tests/test_password_reset_service.py` — service security/invariant tests.
- `backend/tests/test_browser_password_reset_api.py` — API contract and enumeration tests.
- `backend/tests/test_password_reset_delivery.py` — delivery worker/template tests.
- `web/apps/staff/src/auth/authTypes.ts` — public recovery state and response types.
- `web/apps/staff/src/auth/authClient.ts` — typed reset-request/reset-confirm client methods.
- `web/apps/staff/src/auth/AuthProvider.tsx` — public recovery transitions and URL token capture.
- `web/apps/staff/src/auth/AuthFlow.tsx` — sign-in, forgot-password, reset-password, and success screens.
- `web/apps/staff/src/auth/authUi.tsx` — shared password field and authentication gateway primitives.
- `web/apps/staff/src/__tests__/AuthFlow.test.tsx` — UI behavior, accessibility, and reduced-motion coverage.
- `web/apps/staff/src/__tests__/authClient.test.ts` — client endpoint contract.
- `web/apps/staff/src/styles.css` — gateway, form, status, responsive, and focus styles.

Modify these existing integration/configuration files:

- `backend/src/hms_backend/app/api/browser_auth.py` — public reset endpoints.
- `backend/src/hms_backend/app/core/config.py` — reset TTL, rate-limit, public staff URL, and delivery-key settings.
- `backend/src/hms_backend/app/modules/notifications/tasks.py` — sensitive delivery task registration.
- `backend/src/hms_backend/app/modules/notifications/templates.py` — secure reset email wording and link context.
- `backend/src/hms_backend/app/modules/notifications/channels/registry.py` — reuse SES adapter for the security email.
- `backend/src/hms_backend/app/core/celery_app.py` — delivery schedule/registration.
- `backend/tests/conftest.py` or existing fixtures — reset-specific database settings.
- `infra/terraform/envs/dev/main.tf` and its variables/secret wiring — staff URL and password-reset delivery key.
- `.github/workflows/deploy-aws-dev.yml` — migration/worker deployment smoke checks if required by existing task definitions.

---

### Task 1: Add Password-Reset Crypto and Configuration

**Files:**
- Create: `backend/src/hms_backend/app/core/password_reset_tokens.py`
- Modify: `backend/src/hms_backend/app/core/config.py`
- Test: `backend/tests/test_password_reset_tokens.py`

- [ ] **Step 1: Write failing crypto tests**

Cover these exact behaviors:

```python
def test_generated_token_has_digest_but_not_reversible_storage(): ...
def test_delivery_envelope_round_trips_with_reset_record_aad(): ...
def test_delivery_envelope_rejects_wrong_record_or_key(): ...
def test_expired_delivery_envelope_is_not_decrypted_for_dispatch(): ...
```

Use a deterministic test `Settings` with a 32-byte base64 key and assert that
the plaintext token is not present in the persisted envelope value.

- [ ] **Step 2: Run the focused tests and confirm the expected failure**

Run:

```bash
cd backend
uv run pytest tests/test_password_reset_tokens.py -q
```

Expected: collection or assertion failure because the helper and settings do not
exist yet.

- [ ] **Step 3: Implement the minimal helpers**

Implement:

```python
@dataclass(frozen=True)
class PasswordResetSecret:
    raw: str
    digest: str

def generate_password_reset_secret() -> PasswordResetSecret: ...
def digest_password_reset_secret(raw: str) -> str: ...
def encrypt_password_reset_delivery(raw: str, *, reset_id: str, user_id: str) -> EncryptedSecret: ...
def decrypt_password_reset_delivery(value: EncryptedSecret, *, reset_id: str, user_id: str) -> str: ...
```

Use `secrets.token_urlsafe(32)`, SHA-256 for lookup, AES-256-GCM with a 12-byte
random nonce, authenticated data containing both reset ID and user ID, and a
versioned key ring parallel to the existing MFA key handling.

Add settings for `auth_password_reset_ttl_seconds=900`, independent request
limits, `auth_password_reset_encryption_key`, key map/version, and the staff
web public URL. Deployed validation must require the key and URL when browser
login is enabled outside local/test.

- [ ] **Step 4: Run the crypto tests and lint**

Run:

```bash
uv run pytest tests/test_password_reset_tokens.py -q
uv run ruff check src/hms_backend/app/core/password_reset_tokens.py src/hms_backend/app/core/config.py tests/test_password_reset_tokens.py
```

Expected: all focused tests pass and Ruff is clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/hms_backend/app/core/password_reset_tokens.py backend/src/hms_backend/app/core/config.py backend/tests/test_password_reset_tokens.py
git commit -m "feat(auth): add password reset token cryptography"
```

### Task 2: Persist Reset Records and Migration

**Files:**
- Modify: `backend/src/hms_backend/app/modules/identity/models.py`
- Create: `backend/alembic/versions/20260713_0010_password_reset.py`
- Test: `backend/tests/test_migration_password_reset.py`
- Test: `backend/tests/test_browser_auth_models.py`

- [ ] **Step 1: Write failing schema/model tests**

Assert that the migration creates `password_reset_tokens` and
`password_reset_deliveries` with token digest, user FK, expiry, consumption,
delivery ciphertext/key version, attempt/status timestamps, and indexes. Assert
there is no raw-token column.

- [ ] **Step 2: Run the migration test and confirm it fails**

```bash
cd backend
uv run pytest tests/test_migration_password_reset.py -q
```

Expected: the new tables/columns are absent.

- [ ] **Step 3: Add the ORM models and linear Alembic migration**

Use `SyncableMixin` only for the durable security record if it is already the
project convention; do not expose credential material to sync payloads. Add
foreign keys to `users`, indexes on `(user_id, consumed_at, expires_at)` and
`(status, scheduled_for)`, and a one-to-one delivery FK to the reset record.

The migration must have `down_revision = "20260712_0009"`, create the two tables,
and downgrade by dropping delivery before token rows.

- [ ] **Step 4: Run migration and model tests**

```bash
uv run pytest tests/test_migration_password_reset.py tests/test_browser_auth_models.py -q
uv run alembic upgrade head
uv run alembic check
```

Expected: migration chain is linear and all schema assertions pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/hms_backend/app/modules/identity/models.py backend/alembic/versions/20260713_0010_password_reset.py backend/tests/test_migration_password_reset.py backend/tests/test_browser_auth_models.py
git commit -m "feat(auth): persist one-time password reset records"
```

### Task 3: Implement Reset Service and Browser API

**Files:**
- Create: `backend/src/hms_backend/app/modules/identity/password_reset.py`
- Modify: `backend/src/hms_backend/app/api/browser_auth.py`
- Modify: `backend/src/hms_backend/app/modules/identity/browser_auth.py`
- Test: `backend/tests/test_password_reset_service.py`
- Test: `backend/tests/test_browser_password_reset_api.py`

- [ ] **Step 1: Write failing service tests**

Cover:

```python
async def test_request_is_generic_for_unknown_deleted_and_disabled_users(): ...
async def test_request_supersedes_previous_active_token(): ...
async def test_confirm_rejects_expired_used_malformed_and_superseded_tokens(): ...
async def test_confirm_changes_password_revokes_sessions_and_records_audit(): ...
async def test_confirm_preserves_mfa_and_does_not_issue_a_session(): ...
async def test_request_rate_limits_account_and_ip_dimensions(): ...
```

Use real async SQLite/PostgreSQL test fixtures and inspect the database rows,
audit chain, refresh sessions, and unchanged MFA columns. Never assert on raw
token logs or return values beyond the test’s in-memory variable.

- [ ] **Step 2: Run tests and confirm failure**

```bash
cd backend
uv run pytest tests/test_password_reset_service.py tests/test_browser_password_reset_api.py -q
```

Expected: import/endpoint failures because the service and routes are absent.

- [ ] **Step 3: Implement request and confirmation transitions**

The request service must normalize the email, do dummy password/crypto work for
unknown users, invalidate active records, insert a digest record and encrypted
delivery envelope in one transaction, and return the generic response.

The confirmation service must perform one atomic transaction with a row lock,
verify expiry and digest, validate the centralized password policy, update the
Argon2 password and password timestamp, clear temporary lockout fields, revoke
browser refresh sessions, consume the token, append `auth.password.reset`, and
create the user `SyncChange`. Disabled accounts remain disabled.

Add:

```python
class PasswordResetService:
    async def request(self, session, *, email: str, ip: str | None, user_agent: str | None) -> None: ...
    async def confirm(self, session, *, token: str) -> None: ...
```

Expose `POST /api/v1/auth/browser/password/reset-request` and
`POST /api/v1/auth/browser/password/reset-confirm`. Request always returns
`202` with the same message. Confirmation returns a generic `400` for all
invalid token states and a success message otherwise.

- [ ] **Step 4: Run the service/API tests and full backend auth tests**

```bash
uv run pytest tests/test_password_reset_service.py tests/test_browser_password_reset_api.py tests/test_browser_auth_service.py tests/test_browser_auth_api.py -q
```

Expected: all reset and existing browser-auth tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/hms_backend/app/modules/identity/password_reset.py backend/src/hms_backend/app/api/browser_auth.py backend/src/hms_backend/app/modules/identity/browser_auth.py backend/tests/test_password_reset_service.py backend/tests/test_browser_password_reset_api.py
git commit -m "feat(auth): add one-time password reset API"
```

### Task 4: Add Sensitive SES Delivery Worker

**Files:**
- Create: `backend/src/hms_backend/app/modules/notifications/password_reset_delivery.py`
- Modify: `backend/src/hms_backend/app/modules/notifications/tasks.py`
- Modify: `backend/src/hms_backend/app/modules/notifications/templates.py`
- Modify: `backend/src/hms_backend/app/core/celery_app.py`
- Test: `backend/tests/test_password_reset_delivery.py`

- [ ] **Step 1: Write failing delivery tests**

Test that the worker selects pending envelopes, decrypts only in memory, builds
the CloudFront reset URL, calls the existing SES adapter, persists only status,
attempt count, provider ID, and redacted errors, scrubs ciphertext on success or
final failure, and ignores expired/consumed rows. Assert the permanent
`Notification` and `OutboxEvent` tables never receive reset content.

- [ ] **Step 2: Run the tests and confirm failure**

```bash
cd backend
uv run pytest tests/test_password_reset_delivery.py -q
```

Expected: worker/module import failure.

- [ ] **Step 3: Implement the worker and schedule**

Add a `password_reset_delivery_task` using the existing async task engine and
SES channel adapter. Reuse the `PASSWORD_RESET` subject/body template, passing a
single generated link only to the transient `OutgoingMessage`. Use bounded
attempts and a short retry delay; after the final failure clear the ciphertext
and keep a redacted provider error. Add a periodic schedule in `celery_app.py`
at the same operational cadence as notification dispatch.

- [ ] **Step 4: Run delivery and notification regression tests**

```bash
uv run pytest tests/test_password_reset_delivery.py tests/test_notification_channels.py tests/test_notifications_engine.py -q
uv run ruff check src/hms_backend/app/modules/notifications/password_reset_delivery.py src/hms_backend/app/modules/notifications/tasks.py src/hms_backend/app/modules/notifications/templates.py
```

Expected: all tests pass and no raw-token assertion is violated.

- [ ] **Step 5: Commit**

```bash
git add backend/src/hms_backend/app/modules/notifications/password_reset_delivery.py backend/src/hms_backend/app/modules/notifications/tasks.py backend/src/hms_backend/app/modules/notifications/templates.py backend/src/hms_backend/app/core/celery_app.py backend/tests/test_password_reset_delivery.py
git commit -m "feat(auth): deliver reset links through secure SES worker"
```

### Task 5: Wire the Staff Auth Client and Provider

**Files:**
- Modify: `web/apps/staff/src/auth/authTypes.ts`
- Modify: `web/apps/staff/src/auth/authClient.ts`
- Modify: `web/apps/staff/src/auth/AuthProvider.tsx`
- Create: `web/apps/staff/src/auth/passwordReset.ts`
- Test: `web/apps/staff/src/__tests__/authClient.test.ts`
- Test: `web/apps/staff/src/__tests__/AuthProvider.test.tsx`

- [ ] **Step 1: Write failing client/provider tests**

Cover exact request paths, JSON bodies, generic confirmation state, reset token
capture from `window.location`, removal of the token from browser history via
`history.replaceState`, successful confirmation returning to signed-out, and
network error recovery.

- [ ] **Step 2: Run focused frontend tests and confirm failure**

```bash
cd web/apps/staff
npm test -- --run src/__tests__/authClient.test.ts src/__tests__/AuthProvider.test.tsx
```

Expected: missing methods/states and failing assertions.

- [ ] **Step 3: Add typed recovery contracts**

Add `password-reset-request`, `password-reset`, `password-reset-sent`, and
`password-reset-complete` states plus typed `requestPasswordReset(email)` and
`confirmPasswordReset(token, newPassword)` context methods. Keep token in a ref
or local component state only; never localStorage, analytics, or React state
that outlives the public flow.

- [ ] **Step 4: Implement typed HTTP methods and provider transitions**

Add `POST /api/v1/auth/browser/password/reset-request` and
`POST /api/v1/auth/browser/password/reset-confirm` methods. Capture the query
token once at the auth boundary, immediately replace the URL with
`/reset-password`, and preserve the token in memory for the reset form.

- [ ] **Step 5: Run the focused tests and commit**

```bash
npm test -- --run src/__tests__/authClient.test.ts src/__tests__/AuthProvider.test.tsx
git add web/apps/staff/src/auth/authTypes.ts web/apps/staff/src/auth/authClient.ts web/apps/staff/src/auth/AuthProvider.tsx web/apps/staff/src/auth/passwordReset.ts web/apps/staff/src/__tests__/authClient.test.ts web/apps/staff/src/__tests__/AuthProvider.test.tsx
git commit -m "feat(staff): wire password reset auth states"
```

Expected: focused tests pass.

### Task 6: Build the Secure Operations Gateway UI

**Files:**
- Modify: `web/apps/staff/src/auth/AuthFlow.tsx`
- Modify: `web/apps/staff/src/auth/authUi.tsx`
- Modify: `web/apps/staff/src/styles.css`
- Test: `web/apps/staff/src/__tests__/AuthFlow.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Add tests for the selected Option A layout, visible labels, show/hide controls,
forgot-password navigation, generic confirmation, reset validation, loading,
success, invalid-link recovery, `aria-live` error/status regions, keyboard
activation, and a mobile class/markup that avoids horizontal overflow.

- [ ] **Step 2: Run UI tests and confirm failure**

```bash
cd web/apps/staff
npm test -- --run src/__tests__/AuthFlow.test.tsx
```

Expected: missing recovery screens and controls.

- [ ] **Step 3: Implement reusable form primitives and screens**

Add a shared `PasswordField` with accessible toggle labels, a `SecurityGateway`
shell for the navy trust panel/white form panel, and focused screen components
for sign-in, request, reset, and complete states. Keep one primary action per
screen. Use `inputMode`, `type`, `name`, `autoComplete`, and direct field errors.

- [ ] **Step 4: Add Motion transitions and responsive styles**

Use `motion/react` `AnimatePresence`, `m`, and `useReducedMotion` with centralized
tokens: 0.16 s fast, 0.22 s normal, and an 8 px vertical offset. Animate only
opacity/transform. Add `@media (prefers-reduced-motion: reduce)` handling and
responsive breakpoints for 375, 768, 1024, and 1440 widths. Preserve visible
focus rings, 44 px controls, contrast, and no horizontal scroll.

- [ ] **Step 5: Run frontend quality checks**

```bash
npm test -- --run src/__tests__/AuthFlow.test.tsx
npm run build
```

Expected: all UI tests pass and Vite produces a production build without type
errors. Existing bundle-size warnings may remain if already present.

- [ ] **Step 6: Commit**

```bash
git add web/apps/staff/src/auth/AuthFlow.tsx web/apps/staff/src/auth/authUi.tsx web/apps/staff/src/styles.css web/apps/staff/src/__tests__/AuthFlow.test.tsx
git commit -m "feat(staff): redesign authentication and password recovery"
```

### Task 7: Wire AWS Dev Configuration and Deployment Checks

**Files:**
- Modify: `infra/terraform/envs/dev/main.tf`
- Modify: `infra/terraform/envs/dev/variables.tf` or existing variables file
- Modify: `infra/terraform/envs/dev/outputs.tf` if needed
- Modify: `.github/workflows/deploy-aws-dev.yml`
- Test: existing Terraform validation and deployment smoke checks

- [ ] **Step 1: Add configuration validation tests/plan assertions**

Assert the ECS API/worker/beat task definitions receive the CloudFront staff
URL, password-reset TTL, and Secrets Manager-backed encryption key; assert the
key is not written as a plaintext Terraform variable or checked-in `.env`.

- [ ] **Step 2: Update Terraform and workflow**

Use the existing AWS dev secret patterns and task-definition environment wiring.
Add a password-reset encryption secret, preserve the deployed SES region/from
settings, and ensure worker/beat tasks include the new delivery task. Keep
`AUTH_BROWSER_ALLOWED_ORIGINS` aligned with the staff CloudFront origin.

- [ ] **Step 3: Run infrastructure checks**

```bash
terraform -chdir=infra/terraform/envs/dev fmt -check
terraform -chdir=infra/terraform/envs/dev validate
```

When AWS SSO is valid, run `terraform plan` and inspect it for only the intended
secret/task/migration changes. Do not apply production or legacy HMS changes.

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/envs/dev .github/workflows/deploy-aws-dev.yml
git commit -m "feat(deploy): configure secure password reset delivery"
```

### Task 8: Full Verification, Commit, Push, and AWS Smoke Test

**Files:**
- No new production files; update documentation only if runbook steps change.

- [ ] **Step 1: Run the backend regression suite**

```bash
cd backend
uv run pytest -q
uv run ruff check src tests
uv run alembic check
```

Expected: all backend tests pass, Ruff is clean, and Alembic reports no pending
model drift.

- [ ] **Step 2: Run the full staff suite and build**

```bash
cd web/apps/staff
npm test -- --run
npm run build
```

Expected: all staff tests pass and production build succeeds.

- [ ] **Step 3: Run browser verification locally**

Use the browser control skill against the local staff app and verify sign-in,
forgot-password, generic confirmation, reset URL state, invalid-link recovery,
password visibility, keyboard focus, reduced motion, and 375/768/1024/1440
layouts. Do not submit a real password or mutate live production data.

- [ ] **Step 4: Push the implementation branch**

```bash
git status --short --branch
git push origin codex/aws-dev-deployment-foundation
```

Expected: clean working tree and successful push.

- [ ] **Step 5: Deploy AWS dev through GitHub Actions**

Run the existing deployment workflow with the branch/commit after AWS SSO and
required SES/Secrets Manager configuration are confirmed. Verify migration,
ECS service rollout, worker task availability, S3 staff assets, and CloudFront
invalidation.

- [ ] **Step 6: Run the deployed smoke test**

Verify that the staff CloudFront URL renders the new gateway, forgot-password
request returns the generic message, the delivery worker sends only to the
dedicated development mailbox, the link opens the reset route, the reset works
once, the second use fails generically, and the user must complete MFA on the
next login. Record only status and non-sensitive IDs; never print the reset URL,
token, password, or secret.

---

## Plan Self-Review

- Spec coverage: security invariants are covered in Tasks 1–4; UI and motion in
  Tasks 5–6; deployment and AWS delivery in Tasks 7–8; regression and browser
  verification in Task 8.
- No raw reset token is written to the permanent notification log; Task 4 tests
  this explicitly.
- The `PasswordResetSecret`, `PasswordResetService`, provider methods, and API
  route names are consistent across tasks.
- The plan contains no production-data scraping, no hard deletion, and no
  instruction to print credentials.
- No placeholders or unspecified implementation gaps remain.
