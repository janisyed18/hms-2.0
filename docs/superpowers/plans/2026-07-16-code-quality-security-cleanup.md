# Code Quality and Security Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the legacy password-reset security path, eliminate dead crypto/configuration, and reduce frontend production overhead without changing user-facing reset URLs.

**Architecture:** Both legacy and browser password-reset routes will call `PasswordResetService`; the service remains the only token generator, rate limiter, delivery encryptor, and one-time token consumer. Staff workspaces will be lazy-loaded from the existing `App.tsx` shell, while shared display helpers remain small native utilities.

**Tech Stack:** FastAPI, SQLAlchemy, pytest, React 19, Vite, TypeScript, React lazy loading, ESLint flat config, existing Motion/Lucide dependencies.

---

### Task 1: Add legacy password-reset regression coverage

**Files:**
- Modify: `backend/tests/test_browser_password_reset_api.py`

- [ ] **Step 1: Add a failing compatibility test**

Add a test that posts to `/api/v1/auth/password/reset-request`, reads the encrypted delivery row, decrypts the opaque token, confirms through `/api/v1/auth/password/reset-confirm`, and proves a second confirmation is rejected. Assert the decrypted token is not a JWT-shaped three-segment token.

```python
@pytest.mark.asyncio
async def test_legacy_reset_alias_uses_one_time_password_reset_service(
    client: httpx.AsyncClient,
    session_factory: SessionFactory,
) -> None:
    await seed(session_factory)
    requested = await client.post(
        "/api/v1/auth/password/reset-request", json={"email": EMAIL}
    )
    assert requested.status_code == 200

    async with session_factory() as session:
        delivery = await session.scalar(select(PasswordResetDelivery))
        user = await session.scalar(select(User).where(User.email == EMAIL))
        assert delivery is not None and user is not None
        token = decrypt_password_reset_delivery(
            EncryptedPasswordResetDelivery(delivery.ciphertext, delivery.key_version),
            reset_id=delivery.reset_id,
            user_id=user.id,
        )

    assert token.count(".") != 2
    confirmed = await client.post(
        "/api/v1/auth/password/reset-confirm",
        json={"token": token, "new_password": "N3w-Reset-Passphrase!"},
    )
    assert confirmed.status_code == 200

    reused = await client.post(
        "/api/v1/auth/password/reset-confirm",
        json={"token": token, "new_password": "N3w-Reset-Passphrase!"},
    )
    assert reused.status_code == 400
    assert reused.json()["detail"] == "Invalid or expired reset link."
```

- [ ] **Step 2: Run the focused test and verify it fails for the right reason**

Run: `uv run pytest tests/test_browser_password_reset_api.py::test_legacy_reset_alias_uses_one_time_password_reset_service -q`

Expected: FAIL because the legacy endpoint does not create a `PasswordResetDelivery` row and produces the old HS256 token.

### Task 2: Route legacy reset endpoints through the hardened service

**Files:**
- Modify: `backend/src/hms_backend/app/api/auth.py`
- Test: `backend/tests/test_browser_password_reset_api.py`

- [ ] **Step 1: Replace legacy reset implementation**

Import `Request`, `GENERIC_RESET_MESSAGE`, `INVALID_RESET_ERROR`, `PasswordResetError`, and `PasswordResetService`. Keep the existing request/response models and URLs. The request endpoint passes client IP and user-agent to `PasswordResetService.request`, commits, and returns the existing generic response. The confirm endpoint calls `PasswordResetService.confirm`, rolls back on `PasswordResetError`, maps it to HTTP 400, commits on success, and returns the existing success message. Remove `decode_hs256_bearer_token`, `TokenValidationError`, `_RESET_PURPOSE`, `NotificationCategory`, and direct `emit_event` usage from this reset flow.

- [ ] **Step 2: Run the focused regression test**

Run: `uv run pytest tests/test_browser_password_reset_api.py::test_legacy_reset_alias_uses_one_time_password_reset_service -q`

Expected: PASS.

- [ ] **Step 3: Run all reset tests**

Run: `uv run pytest tests/test_browser_password_reset_api.py tests/test_password_reset_service.py tests/test_password_reset_tokens.py -q`

Expected: all tests pass.

### Task 3: Delete the inactive password-reset crypto path

**Files:**
- Modify: `backend/src/hms_backend/app/core/config.py`
- Delete: `backend/src/hms_backend/app/core/secret_envelope.py`
- Delete: `backend/tests/test_secret_envelope.py`

- [ ] **Step 1: Remove only unused settings**

Delete `auth_password_reset_keys`, `auth_password_reset_delivery_max_attempts`, and `auth_password_reset_delivery_retry_seconds` from the old local-token section. Keep the single `auth_password_reset_key_version` and `auth_password_reset_ttl_seconds` declarations in the browser-auth password-reset section.

- [ ] **Step 2: Delete the unused module and tests**

Remove the legacy AES-GCM envelope module and its tests. Keep `password_reset_tokens.py` as the only reset-delivery encryption implementation.

- [ ] **Step 3: Verify no runtime references remain**

Run: `rg -n "secret_envelope|auth_password_reset_keys|auth_password_reset_delivery" backend/src backend/tests`

Expected: no matches.

### Task 4: Consolidate the staff date formatter

**Files:**
- Create: `web/apps/staff/src/utils/dateTime.ts`
- Modify: `web/apps/staff/src/components/OperationalWorkspace.tsx`
- Modify: `web/apps/staff/src/components/SystemWorkspace.tsx`

- [ ] **Step 1: Add the shared native formatter**

Create `formatDateTime(value: string): string` with the existing replacement behavior.

```ts
export function formatDateTime(value: string): string {
  return value.replace("T", " ").replace(/Z$/, "");
}
```

- [ ] **Step 2: Replace both local definitions**

Import the shared helper in both workspaces and delete their duplicate local functions.

- [ ] **Step 3: Run TypeScript compilation**

Run: `npm run build` from `web/apps/staff`.

Expected: the build succeeds.

### Task 5: Add frontend linting and correct hook dependencies

**Files:**
- Modify: `web/apps/staff/package.json`
- Modify: `web/apps/staff/package-lock.json`
- Create: `web/apps/staff/eslint.config.ts`
- Modify: `web/apps/staff/src/auth/AuthFlow.tsx`
- Modify: `web/apps/staff/src/components/UserAdminDialog.tsx`
- Repeat the package/config changes for `web/apps/inspector`

- [ ] **Step 1: Install development-only lint packages**

Run in each app: `npm install --save-dev eslint typescript-eslint eslint-plugin-react-hooks`.

- [ ] **Step 2: Add the minimal flat config and script**

Use `typescript-eslint` recommended rules and the React Hooks flat recommended rules. Ignore `dist`, `node_modules`, coverage, and Vite config files. Add `"lint": "eslint ."` to each package.

```ts
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "vite.config.ts"] },
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended
);
```

- [ ] **Step 3: Fix the two suppressed effects**

Use complete dependency arrays for the MFA enrollment and user-dialog form-seeding effects, preserving their existing behavior. Remove the now-valid `eslint-disable-next-line` comments.

- [ ] **Step 4: Resolve lint findings without suppressions**

Run: `npm run lint` from both web app directories.

Resolve every reported error without adding rule suppressions. If a warning comes from a build/configuration file, add that exact file to the existing ignore list rather than disabling the rule globally. Expected: exit 0 with no warnings or errors.

### Task 6: Split staff workspace loading

**Files:**
- Modify: `web/apps/staff/src/App.tsx`

- [ ] **Step 1: Convert non-shell workspaces to named lazy imports**

Use `lazy(() => import(...).then(({ NamedExport }) => ({ default: NamedExport })))` for analytics, operations, products, reference, inspections, certificates, retest, and system workspaces. Keep auth, shell, customer workspace, and shared state eager.

- [ ] **Step 2: Add a loading boundary**

Wrap the page content in `Suspense` with the existing `WorkspaceState` loading component. Do not change module authorization or navigation logic.

- [ ] **Step 3: Build and inspect bundle output**

Run: `npm run build` from `web/apps/staff`.

Expected: build succeeds and emits separate workspace chunks without the prior 946 KB monolithic warning.

### Task 7: Full verification and final review

**Files:**
- No additional source files.

- [ ] **Step 1: Run backend quality checks**

Run: `uv run ruff check src tests && uv run pytest -q` from `backend`.

- [ ] **Step 2: Run frontend checks**

Run `npm run lint && npm run build && npm test -- --run` from both `web/apps/staff` and `web/apps/inspector`.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --check`, `rg -n "secret_envelope|auth_password_reset_keys|decode_hs256_bearer_token" backend/src`, and `git status --short`.

Expected: no whitespace errors, no legacy reset implementation references, and only intended files changed.
