# Secure Password Reset and Authentication UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a premium BAT Operations authentication gateway and a secure, one-time, email-based forgotten-password flow that preserves MFA and revokes existing sessions.

**Architecture:** Add focused password-reset persistence and a `PasswordResetService` beside the existing browser-auth state machine. Reset secrets are hashed for confirmation and encrypted only inside a short-lived SES delivery envelope, keeping the permanent notification log secret-free. Extend the existing React auth provider/client with public recovery states and render all auth steps inside one responsive Motion-powered gateway shell.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2 async, Alembic, PostgreSQL/SQLite tests, Redis rate limiting, Celery, AWS SES v2, cryptography AES-GCM, React 19, TypeScript, Vite, Motion, Lucide, Vitest, Testing Library, Playwright, Terraform, ECS Fargate, CloudFront.

---

## File Structure

### Backend

- Create `backend/src/hms_backend/app/core/secret_envelope.py`: versioned AES-256-GCM helper for short-lived security delivery content.
- Create `backend/src/hms_backend/app/modules/identity/password_reset.py`: reset request/confirmation and secure delivery service.
- Modify `backend/src/hms_backend/app/modules/identity/models.py`: reset token and encrypted delivery models.
- Create `backend/src/hms_backend/app/modules/identity/tasks.py`: Celery entry point for pending reset email delivery.
- Modify `backend/src/hms_backend/app/api/browser_auth.py`: public reset request and confirmation endpoints.
- Modify `backend/src/hms_backend/app/core/config.py`: reset TTL, staff URL, keyring, and retry configuration.
- Modify `backend/src/hms_backend/app/core/celery_app.py`: register and schedule reset delivery.
- Modify `backend/src/hms_backend/app/modules/notifications/templates.py`: explicit 15-minute reset wording.
- Create `backend/alembic/versions/20260713_0010_password_reset.py`: reset persistence migration.
- Create `backend/tests/test_secret_envelope.py`: cryptographic round-trip and misuse cases.
- Create `backend/tests/test_password_reset_service.py`: request, confirmation, audit, sync, and session tests.
- Modify `backend/tests/test_browser_auth_api.py`: endpoint enumeration and error-contract tests.
- Create `backend/tests/test_password_reset_delivery.py`: SES delivery, retry, and ciphertext scrubbing tests.
- Modify `backend/tests/test_auth_production_config.py`: deployed configuration validation.

### Staff Web

- Modify `web/apps/staff/src/auth/authTypes.ts`: reset states and response types.
- Modify `web/apps/staff/src/auth/authClient.ts`: reset request/confirmation methods.
- Modify `web/apps/staff/src/auth/AuthProvider.tsx`: recovery state transitions and URL-token capture.
- Modify `web/apps/staff/src/auth/AuthFlow.tsx`: sign-in, forgot, confirmation, reset, and success screens.
- Modify `web/apps/staff/src/auth/authUi.tsx`: gateway shell, password field, motion tokens, and status primitives.
- Modify `web/apps/staff/src/styles.css`: responsive Secure Operations Gateway styling.
- Modify `web/apps/staff/src/__tests__/AuthFlow.test.tsx`: screen behavior and accessibility.
- Modify `web/apps/staff/src/__tests__/AuthProvider.test.tsx`: provider reset state machine.
- Create `web/apps/staff/src/__tests__/authClient.test.ts`: request contracts.
- Modify `web/apps/staff/e2e/staff-auth.spec.ts`: browser reset flow and responsive assertions.

### Runtime and AWS

- Modify `docker-compose.yml`: local staff URL and reset keyring.
- Modify `infra/terraform/envs/dev/main.tf`: generated reset encryption key, Secrets Manager wiring, staff CloudFront URL, and ECS environment.
- Modify `infra/terraform/envs/dev/variables.tf`: active reset key version.
- Modify `infra/terraform/envs/dev/terraform.tfvars.example`: documented defaults.
- Modify `.github/workflows/deploy-aws-dev.yml`: preserve migration-first deployment and add reset smoke checks.

---

### Task 1: Versioned Security Envelope

**Files:**
- Create: `backend/tests/test_secret_envelope.py`
- Create: `backend/src/hms_backend/app/core/secret_envelope.py`
- Modify: `backend/src/hms_backend/app/core/config.py`

- [ ] **Step 1: Write failing encryption tests**

```python
def test_envelope_round_trip_binds_context(monkeypatch):
    key = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
    monkeypatch.setattr(settings, "auth_password_reset_keys", {1: key})
    monkeypatch.setattr(settings, "auth_password_reset_key_version", 1)
    sealed = seal_secret("reset-secret", context="reset-1:user-1")
    assert sealed.ciphertext != "reset-secret"
    assert open_secret(sealed, context="reset-1:user-1") == "reset-secret"

def test_envelope_rejects_wrong_context(monkeypatch):
    key = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
    monkeypatch.setattr(settings, "auth_password_reset_keys", {1: key})
    monkeypatch.setattr(settings, "auth_password_reset_key_version", 1)
    sealed = seal_secret("reset-secret", context="reset-1:user-1")
    with pytest.raises(InvalidTag):
        open_secret(sealed, context="reset-2:user-1")
```

- [ ] **Step 2: Verify RED**

Run: `cd backend && uv run pytest tests/test_secret_envelope.py -q`

Expected: import failure because `secret_envelope` does not exist.

- [ ] **Step 3: Implement the focused helper and settings**

Add settings:

```python
auth_password_reset_ttl_seconds: int = 900
auth_password_reset_key_version: int = 1
auth_password_reset_keys: dict[int, str] = Field(default_factory=dict)
auth_password_reset_delivery_max_attempts: int = 5
auth_password_reset_delivery_retry_seconds: int = 60
staff_web_public_url: str = "http://127.0.0.1:8080"
```

Implement `SealedSecret`, 12-byte random nonces, base64-url encoding, key-length validation, `seal_secret`, and `open_secret`. Bind AES-GCM associated data to `reset_id:user_id`.

- [ ] **Step 4: Verify GREEN**

Run: `cd backend && uv run pytest tests/test_secret_envelope.py tests/test_auth_production_config.py -q`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/hms_backend/app/core/config.py backend/src/hms_backend/app/core/secret_envelope.py backend/tests/test_secret_envelope.py backend/tests/test_auth_production_config.py
git commit -m "feat(auth): add secure reset delivery envelope"
```

### Task 2: Password Reset Persistence

**Files:**
- Modify: `backend/src/hms_backend/app/modules/identity/models.py`
- Create: `backend/alembic/versions/20260713_0010_password_reset.py`
- Modify: `backend/tests/test_browser_auth_models.py`
- Modify: `backend/tests/test_migration_browser_auth.py`

- [ ] **Step 1: Write failing model and migration tests**

Assert that metadata and migration create:

```python
expected_tables = {"password_reset_tokens", "password_reset_deliveries"}
assert expected_tables <= set(Base.metadata.tables)
```

Assert token digests are unique, reset rows reference users with cascade delete,
and deliveries reference reset rows one-to-one.

- [ ] **Step 2: Verify RED**

Run: `cd backend && uv run pytest tests/test_browser_auth_models.py tests/test_migration_browser_auth.py -q`

Expected: missing table assertions fail.

- [ ] **Step 3: Add models and migration**

Create `PasswordResetToken` with `id`, `token_hash`, `user_id`, `expires_at`,
`consumed_at`, `superseded_at`, `requested_ip`, `requested_user_agent`, and
`created_at`. Create `PasswordResetDelivery` with `reset_id`, `recipient_email`,
`ciphertext`, `key_version`, `status`, `attempts`, `scheduled_for`, `sent_at`,
`failed_at`, `provider_message_id`, `error`, and `created_at`.

Migration revision is `20260713_0010`, down revision `20260712_0009`, with
indexes for active token lookup and pending delivery scheduling.

- [ ] **Step 4: Verify GREEN**

Run: `cd backend && uv run pytest tests/test_browser_auth_models.py tests/test_migration_browser_auth.py -q`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/hms_backend/app/modules/identity/models.py backend/alembic/versions/20260713_0010_password_reset.py backend/tests/test_browser_auth_models.py backend/tests/test_migration_browser_auth.py
git commit -m "feat(auth): persist one-time password resets"
```

### Task 3: Password Reset Domain Service

**Files:**
- Create: `backend/src/hms_backend/app/modules/identity/password_reset.py`
- Create: `backend/tests/test_password_reset_service.py`

- [ ] **Step 1: Write failing request tests**

Cover eligible, unknown, deleted, and disabled users. For an eligible user assert:

```python
issued = await service.request_reset(session, email=EMAIL, ip="203.0.113.4", user_agent="pytest")
assert issued is True
token = await session.scalar(select(PasswordResetToken))
delivery = await session.scalar(select(PasswordResetDelivery))
assert token.token_hash not in delivery.ciphertext
assert delivery.recipient_email == EMAIL
```

Issue twice and assert the earlier token has `superseded_at` set.

- [ ] **Step 2: Verify request tests fail**

Run: `cd backend && uv run pytest tests/test_password_reset_service.py -q`

Expected: import failure because `PasswordResetService` does not exist.

- [ ] **Step 3: Implement reset issuance**

Use `generate_opaque_token`, `digest_opaque_token`, `seal_secret`, normalized
email lookup, a 15-minute aware expiry, and one transaction-owned service method.
Return only a boolean for internal testability; the API must ignore it.

- [ ] **Step 4: Verify request tests pass**

Run the focused service tests and expect PASS.

- [ ] **Step 5: Write failing confirmation tests**

Cover valid, malformed, expired, consumed, and superseded tokens; weak password;
session revocation; lockout clearing; MFA preservation; audit event; and
`SyncChange`. Verify the audit payload does not contain `password_hash`, token,
or ciphertext.

- [ ] **Step 6: Verify confirmation tests fail**

Run the focused test module. Expected: `confirm_reset` is missing.

- [ ] **Step 7: Implement atomic confirmation**

Lock the matching reset row, validate the centralized password policy, update the
Argon2 hash and safe account fields, revoke browser sessions, consume/supersede
tokens, scrub pending delivery ciphertext, add a content-free `SyncChange`, and
append a redacted `auth.password.reset` audit event.

- [ ] **Step 8: Verify GREEN**

Run: `cd backend && uv run pytest tests/test_password_reset_service.py tests/test_browser_auth_service.py -q`

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add backend/src/hms_backend/app/modules/identity/password_reset.py backend/tests/test_password_reset_service.py
git commit -m "feat(auth): implement one-time password recovery"
```

### Task 4: Browser Reset API and Rate Limiting

**Files:**
- Modify: `backend/src/hms_backend/app/api/browser_auth.py`
- Modify: `backend/tests/test_browser_auth_api.py`

- [ ] **Step 1: Write failing API tests**

Test that `POST /api/v1/auth/browser/password/reset-request` returns the same 200
body for known and unknown email addresses, and that
`POST /api/v1/auth/browser/password/reset-confirm` returns 400 with the same
message for invalid token variants. Test independent account-fingerprint and IP
rate-limit keys and `Retry-After` on 429.

- [ ] **Step 2: Verify RED**

Run: `cd backend && uv run pytest tests/test_browser_auth_api.py -q`

Expected: 404 for both new routes.

- [ ] **Step 3: Add request schemas and endpoints**

```python
class BrowserPasswordResetRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)

class BrowserPasswordResetConfirmRequest(BaseModel):
    token: str = Field(min_length=32, max_length=512)
    new_password: str
```

Use a dedicated `LoginRateLimiter` namespace for reset requests. Always commit and
return `{"message": "If an eligible account exists, a reset link has been sent."}`.
Map all token failures to `Invalid or expired reset link.` and safe password
policy failures to their actionable message.

- [ ] **Step 4: Verify GREEN**

Run the API and service test modules. Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/hms_backend/app/api/browser_auth.py backend/tests/test_browser_auth_api.py
git commit -m "feat(auth): expose secure browser password reset"
```

### Task 5: Secure SES Reset Delivery

**Files:**
- Create: `backend/src/hms_backend/app/modules/identity/tasks.py`
- Modify: `backend/src/hms_backend/app/modules/identity/password_reset.py`
- Modify: `backend/src/hms_backend/app/modules/notifications/templates.py`
- Modify: `backend/src/hms_backend/app/core/celery_app.py`
- Create: `backend/tests/test_password_reset_delivery.py`

- [ ] **Step 1: Write failing delivery tests**

Use a fake SES adapter. Assert pending delivery decrypts only in memory, renders a
URL under `staff_web_public_url`, sends exactly once, stores the provider message
ID, and sets `ciphertext` to `None`. Assert retry scheduling on transient failure
and scrubbing on final failure or token expiry.

- [ ] **Step 2: Verify RED**

Run: `cd backend && uv run pytest tests/test_password_reset_delivery.py -q`

Expected: delivery function import failure.

- [ ] **Step 3: Implement delivery and Celery task**

Add `deliver_pending_password_resets(session_factory, adapter, settings, limit)`
and a Celery task named `identity.deliver_password_resets`. Schedule it every 30
seconds. Reuse `render(NotificationCategory.PASSWORD_RESET, EMAIL, context)` and
`AwsSesEmailAdapter`; never create `Notification` or `OutboxEvent` rows.

- [ ] **Step 4: Verify GREEN**

Run: `cd backend && uv run pytest tests/test_password_reset_delivery.py tests/test_notification_channels.py tests/test_notification_policy.py -q`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/hms_backend/app/modules/identity/tasks.py backend/src/hms_backend/app/modules/identity/password_reset.py backend/src/hms_backend/app/modules/notifications/templates.py backend/src/hms_backend/app/core/celery_app.py backend/tests/test_password_reset_delivery.py
git commit -m "feat(auth): deliver reset links securely through SES"
```

### Task 6: Frontend Reset Client and State Machine

**Files:**
- Modify: `web/apps/staff/src/auth/authTypes.ts`
- Modify: `web/apps/staff/src/auth/authClient.ts`
- Modify: `web/apps/staff/src/auth/AuthProvider.tsx`
- Create: `web/apps/staff/src/__tests__/authClient.test.ts`
- Modify: `web/apps/staff/src/__tests__/AuthProvider.test.tsx`

- [ ] **Step 1: Write failing client and provider tests**

Assert exact JSON contracts, then drive provider states:

```typescript
"signed-out" -> "reset-request" -> "reset-email-sent"
"reset-password" -> "reset-complete" -> "signed-out"
```

Initialize at `/reset-password?token=abc`, assert the token is held only in
memory, and assert `history.replaceState` removes it from the visible URL.

- [ ] **Step 2: Verify RED**

Run: `cd web/apps/staff && npm test -- --run src/__tests__/authClient.test.ts src/__tests__/AuthProvider.test.tsx`

Expected: missing methods and state types.

- [ ] **Step 3: Implement typed client and provider transitions**

Add `requestPasswordReset`, `confirmPasswordReset`, `openResetRequest`,
`returnToSignIn`, and `resetPassword`. Keep access tokens in the existing ref and
never put reset tokens in React-rendered text, local storage, session storage, or
logging.

- [ ] **Step 4: Verify GREEN**

Run the focused tests and `npm run build`. Expected: tests and TypeScript pass.

- [ ] **Step 5: Commit**

```bash
git add web/apps/staff/src/auth/authTypes.ts web/apps/staff/src/auth/authClient.ts web/apps/staff/src/auth/AuthProvider.tsx web/apps/staff/src/__tests__/authClient.test.ts web/apps/staff/src/__tests__/AuthProvider.test.tsx
git commit -m "feat(staff): add password recovery state machine"
```

### Task 7: Secure Operations Gateway UI

**Files:**
- Modify: `web/apps/staff/src/auth/authUi.tsx`
- Modify: `web/apps/staff/src/auth/AuthFlow.tsx`
- Modify: `web/apps/staff/src/styles.css`
- Modify: `web/apps/staff/src/__tests__/AuthFlow.test.tsx`

- [ ] **Step 1: Write failing UI behavior tests**

Assert password visibility controls, accessible names, correct autocomplete,
Forgot Password navigation, generic sent confirmation, reset mismatch and policy
errors, pending labels, invalid-link recovery, successful return to sign-in, and
one visible primary action per screen.

- [ ] **Step 2: Verify RED**

Run: `cd web/apps/staff && npm test -- --run src/__tests__/AuthFlow.test.tsx`

Expected: missing links, screens, and accessible controls.

- [ ] **Step 3: Build reusable auth primitives**

Create a password field with Lucide `Eye`/`EyeOff`, form status with `AlertCircle`
or `CheckCircle2`, centralized Motion tokens, and the responsive gateway shell.
Use `AnimatePresence`, `m`, and `useReducedMotion`; animations use opacity and at
most 8 px translation for 160-240 ms.

- [ ] **Step 4: Implement all approved screens and styling**

Desktop uses the navy trust panel plus form panel. At 767 px and below, collapse
the trust content into the form header. Preserve 44 px controls, 16 px mobile
inputs, visible focus, AA contrast, a 4/8 px spacing scale, and no horizontal
overflow.

- [ ] **Step 5: Verify GREEN**

Run: `cd web/apps/staff && npm test -- --run src/__tests__/AuthFlow.test.tsx && npm run build`

Expected: focused tests and production build pass.

- [ ] **Step 6: Commit**

```bash
git add web/apps/staff/src/auth/authUi.tsx web/apps/staff/src/auth/AuthFlow.tsx web/apps/staff/src/styles.css web/apps/staff/src/__tests__/AuthFlow.test.tsx
git commit -m "style(staff): deliver secure operations auth gateway"
```

### Task 8: Local and AWS Runtime Configuration

**Files:**
- Modify: `backend/tests/test_auth_production_config.py`
- Modify: `docker-compose.yml`
- Modify: `infra/terraform/envs/dev/main.tf`
- Modify: `infra/terraform/envs/dev/variables.tf`
- Modify: `infra/terraform/envs/dev/terraform.tfvars.example`

- [ ] **Step 1: Write failing production-config tests**

Assert deployed browser auth rejects a missing reset keyring or staff URL and
accepts valid 32-byte active key material.

- [ ] **Step 2: Verify RED**

Run: `cd backend && uv run pytest tests/test_auth_production_config.py -q`

Expected: current validator does not report reset configuration.

- [ ] **Step 3: Wire local and Terraform configuration**

Generate a 32-byte reset key, store active and versioned values in the existing
app secret, expose them to all backend ECS tasks, and set
`STAFF_WEB_PUBLIC_URL=https://${aws_cloudfront_distribution.staff.domain_name}`.
Add equivalent development values to Compose without committing a real secret.

- [ ] **Step 4: Validate configuration**

Run:

```bash
cd infra/terraform/envs/dev
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
cd ../../../..
docker compose config --quiet
```

Expected: all commands succeed without exposing secret values.

- [ ] **Step 5: Commit**

```bash
git add backend/src/hms_backend/app/core/config.py backend/tests/test_auth_production_config.py docker-compose.yml infra/terraform/envs/dev/main.tf infra/terraform/envs/dev/variables.tf infra/terraform/envs/dev/terraform.tfvars.example
git commit -m "chore(auth): configure password recovery runtime"
```

### Task 9: Regression, Browser Verification, Deployment

**Files:**
- Modify: `web/apps/staff/e2e/staff-auth.spec.ts`
- Modify: `.github/workflows/deploy-aws-dev.yml`

- [ ] **Step 1: Add Playwright coverage**

Cover sign-in gateway rendering, forgot-password confirmation, invalid reset-link
recovery, password visibility, tab order, 375/768/1024/1440 layouts, and reduced
motion. Use synthetic accounts and intercept email delivery in local e2e; never
alter legacy production data.

- [ ] **Step 2: Run focused e2e verification**

Run: `cd web/apps/staff && npm run test:e2e -- staff-auth.spec.ts`

Expected: all authentication e2e tests pass. Any failure must be reproduced in
the focused Vitest or backend test for the owning component before changing
production code.

- [ ] **Step 3: Run full verification**

```bash
cd backend
uv run ruff check .
uv run mypy src
uv run pytest -q
cd ../web/apps/staff
npm test -- --run
npm run build
```

Expected: all checks pass; only the already-known Vite bundle-size advisory may
remain.

- [ ] **Step 4: Add deployment smoke checks**

After ECS stabilization and CloudFront invalidation, verify the staff index,
generic reset-request response, and invalid-token response without issuing a
real reset. Keep the real SES link test as a manual dev-environment check against
a dedicated test account.

- [ ] **Step 5: Commit, push, and deploy**

```bash
git add web/apps/staff/e2e/staff-auth.spec.ts .github/workflows/deploy-aws-dev.yml
git commit -m "test(auth): verify password recovery end to end"
git push origin codex/aws-dev-deployment-foundation
gh workflow run deploy-aws-dev.yml --ref codex/aws-dev-deployment-foundation
```

- [ ] **Step 6: Verify AWS**

Confirm migration `20260713_0010`, healthy API/worker/beat ECS services, successful
staff S3 sync and CloudFront invalidation, no secret values in logs, responsive
gateway rendering, generic request behavior, one-time reset completion, session
revocation, and MFA-required sign-in using only the dedicated AWS dev account.

---

## Plan Self-Review

- Every approved design requirement maps to a task.
- The reset token is never persisted in plaintext or in permanent notifications.
- Backend policy remains authoritative; frontend strength is guidance only.
- Existing password, MFA, refresh, and logout flows receive regression coverage.
- Production configuration fails fast when reset encryption is incomplete.
- Deployment applies the migration before the new API and worker code stabilize.
