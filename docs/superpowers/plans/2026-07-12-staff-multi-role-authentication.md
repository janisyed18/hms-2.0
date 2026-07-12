# HMS Staff Multi-Role Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the staff console's implicit development identity with secure multi-role browser login, mandatory first-login password change and TOTP MFA, rotating browser sessions, and persisted role-aware user administration while preserving the existing native inspector authentication contract.

**Architecture:** Add a browser-specific authentication state machine under `/api/v1/auth/browser/*`. It uses existing Argon2 passwords and HMS RBAC, opaque one-time challenges, encrypted TOTP secrets, hashed recovery codes, and rotating refresh tokens held in a strict HttpOnly cookie. The React staff app owns only the short-lived access token in memory, restores a session through the refresh cookie, never falls back to mock identity, and renders modules and user-admin actions from backend permissions.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2, Alembic, PostgreSQL/SQLite tests, Redis/fakeredis, Argon2id, PyOTP, `cryptography` AES-GCM, React 19, TypeScript, Vite, Vitest, Testing Library, `qrcode.react`, `@zxcvbn-ts/core`, Docker Compose.

---

## Guardrails

- Preserve the existing `/api/v1/auth/login` bearer-token behavior used by the native inspector app and API clients.
- Add browser auth as a separate contract; do not store browser access tokens in local storage, session storage, or cookies.
- Never return or log password hashes, raw passwords, refresh tokens, TOTP secrets after enrollment, or recovery-code hashes.
- Keep backend authorization and customer scoping authoritative; hidden React controls are only presentation.
- Do not add or modify the unrelated untracked `docs/hms-role-access-matrix.xlsx` file.
- Every security-sensitive state change must revoke relevant sessions and append a redacted audit event.

## Task 1: Add Browser Security Persistence

**Files:**
- Modify: `backend/src/hms_backend/app/modules/identity/models.py`
- Create: `backend/alembic/versions/20260712_0009_browser_auth_security.py`
- Modify: `backend/src/hms_backend/app/api/schemas.py`
- Create: `backend/tests/test_browser_auth_models.py`

The persisted contract is:

```python
class AccountStatus(StrEnum):
    ACTIVE = "ACTIVE"
    LOCKED = "LOCKED"
    DISABLED = "DISABLED"


class BrowserAuthStage(StrEnum):
    PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED"
    MFA_ENROLLMENT_REQUIRED = "MFA_ENROLLMENT_REQUIRED"
    MFA_REQUIRED = "MFA_REQUIRED"


class BrowserAuthChallenge(Base):
    __tablename__ = "browser_auth_challenges"
    id: Mapped[str]
    token_hash: Mapped[str]
    user_id: Mapped[str]
    stage: Mapped[str]
    expires_at: Mapped[datetime]
    attempt_count: Mapped[int]
    consumed_at: Mapped[datetime | None]


class BrowserRefreshSession(Base):
    __tablename__ = "browser_refresh_sessions"
    id: Mapped[str]
    user_id: Mapped[str]
    family_id: Mapped[str]
    token_hash: Mapped[str]
    expires_at: Mapped[datetime]
    idle_expires_at: Mapped[datetime]
    last_used_at: Mapped[datetime | None]
    revoked_at: Mapped[datetime | None]
    replaced_by_id: Mapped[str | None]
    user_agent: Mapped[str | None]
    ip_address: Mapped[str | None]


class MfaRecoveryCode(Base):
    __tablename__ = "mfa_recovery_codes"
    id: Mapped[str]
    user_id: Mapped[str]
    code_digest: Mapped[str]
    consumed_at: Mapped[datetime | None]
```

- [ ] Write failing model tests that create all three security records and assert uniqueness/expiry fields:
  - `BrowserAuthChallenge`: hashed opaque token, user id, stage, expiry, attempt count, consumed timestamp.
  - `BrowserRefreshSession`: hashed refresh token, family id, expiry/idle expiry, last-used/revoked/replaced timestamps, user-agent and IP metadata.
  - `MfaRecoveryCode`: user id, keyed digest, consumed timestamp.
- [ ] Add `User` account-security fields: `account_status`, `must_change_password`, `password_changed_at`, `mfa_enabled`, `mfa_secret_ciphertext`, `mfa_secret_key_version`, `mfa_last_accepted_step`, failed password/MFA counters, `locked_until`, and `last_login_at`.
- [ ] Add indexes for normalized email lookup, challenge token hash, refresh token hash/family, active sessions by user, and recovery-code ownership.
- [ ] Keep existing users deployable by migrating them to `ACTIVE`; set `must_change_password=false` for existing rows so deployment does not strand current accounts. Newly created local-password users will explicitly set it to true in application code.
- [ ] Add `0009` upgrade/downgrade operations with revision `20260712_0009` and down revision `20260707_0008`.
- [ ] Extend `UserRead` with account status, MFA state, forced-change state, lock expiry, and last login, but never secret material.
- [ ] Run the focused tests and migration check:

```bash
cd backend
uv run pytest tests/test_browser_auth_models.py -q
uv run alembic upgrade head
uv run alembic downgrade 20260707_0008
uv run alembic upgrade head
```

Expected: tests pass and the migration performs a clean up/down/up cycle.

- [ ] Commit:

```bash
git add backend/src/hms_backend/app/modules/identity/models.py backend/src/hms_backend/app/api/schemas.py backend/alembic/versions/20260712_0009_browser_auth_security.py backend/tests/test_browser_auth_models.py
git commit -m "feat(auth): add browser account security persistence"
```

## Task 2: Implement Password Policy and Credential Primitives

**Files:**
- Modify: `backend/pyproject.toml`
- Modify: `backend/uv.lock`
- Modify: `backend/src/hms_backend/app/core/config.py`
- Modify: `backend/src/hms_backend/app/core/passwords.py`
- Create: `backend/src/hms_backend/app/core/mfa.py`
- Create: `backend/src/hms_backend/app/core/session_tokens.py`
- Create: `backend/src/hms_backend/app/data/common_passwords.txt`
- Create: `backend/tests/test_password_policy.py`
- Create: `backend/tests/test_mfa_security.py`
- Create: `backend/tests/test_session_tokens.py`

The security module APIs are fixed as follows:

```python
@dataclass(frozen=True)
class PasswordPolicyResult:
    valid: bool
    errors: tuple[str, ...]


def validate_password_policy(password: str) -> PasswordPolicyResult: ...
def generate_temporary_password() -> str: ...


@dataclass(frozen=True)
class EncryptedTotpSecret:
    ciphertext: str
    key_version: int


def generate_totp_secret() -> str: ...
def build_totp_uri(secret: str, *, email: str, issuer: str) -> str: ...
def encrypt_totp_secret(secret: str, *, user_id: str) -> EncryptedTotpSecret: ...
def decrypt_totp_secret(value: EncryptedTotpSecret, *, user_id: str) -> str: ...
def verify_totp(secret: str, code: str, *, now: datetime) -> int | None: ...
def generate_recovery_codes(count: int = 10) -> tuple[str, ...]: ...
def recovery_code_digest(code: str) -> str: ...


@dataclass(frozen=True)
class OpaqueToken:
    raw: str
    digest: str


def generate_opaque_token() -> OpaqueToken: ...
def digest_opaque_token(raw: str) -> str: ...
```

- [ ] Add failing password-policy tests for 12-128 Unicode characters, whitespace/passphrase acceptance, no truncation, and common-password rejection.
- [ ] Add failing MFA tests for AES-256-GCM encrypt/decrypt, wrong-key rejection, TOTP validation, same-time-step replay rejection input, recovery-code generation, and keyed digest verification.
- [ ] Add failing opaque-token tests proving only SHA-256/HMAC digests are persisted and raw values are URL-safe random strings.
- [ ] Add `pyotp` as a backend dependency. Use the already available `cryptography` package through `pyjwt[crypto]`; do not create custom encryption.
- [ ] Implement `validate_password_policy`, `generate_temporary_password`, and a packaged local common-password deny list in `core/passwords.py`.
- [ ] Implement `core/mfa.py` using PyOTP and AES-GCM. Require a decoded 32-byte encryption key, include the user id as authenticated associated data, and version encrypted values so future key rotation is possible.
- [ ] Implement recovery codes as high-entropy human-readable values whose stored form is an HMAC digest with a separate configured pepper.
- [ ] Implement opaque challenge/refresh token generation and digest helpers in `core/session_tokens.py`.
- [ ] Add settings for MFA encryption key, recovery-code pepper, issuer name, challenge TTL, access TTL, refresh idle/absolute TTL, cookie name/path/secure flag, allowed browser origins, and password bounds.
- [ ] Add a production configuration validator that fails startup when browser login is enabled outside local/test and required signing/encryption/pepper values are missing.
- [ ] Run:

```bash
cd backend
uv sync
uv run pytest tests/test_password_policy.py tests/test_mfa_security.py tests/test_session_tokens.py -q
uv run ruff check src/hms_backend/app/core tests/test_password_policy.py tests/test_mfa_security.py tests/test_session_tokens.py
```

Expected: all primitive tests pass and Ruff is clean.

- [ ] Commit:

```bash
git add backend/pyproject.toml backend/uv.lock backend/src/hms_backend/app/core backend/src/hms_backend/app/data backend/tests/test_password_policy.py backend/tests/test_mfa_security.py backend/tests/test_session_tokens.py
git commit -m "feat(auth): add password and MFA security primitives"
```

## Task 3: Build the Browser Authentication Service

**Files:**
- Create: `backend/src/hms_backend/app/modules/identity/browser_auth.py`
- Modify: `backend/src/hms_backend/app/core/config.py`
- Modify: `backend/src/hms_backend/app/core/redis.py`
- Create: `backend/tests/test_browser_auth_service.py`
- Create: `backend/tests/test_auth_rate_limits.py`

- [ ] Write service tests for every state transition:
  - password valid -> `PASSWORD_CHANGE_REQUIRED`, `MFA_ENROLLMENT_REQUIRED`, or `MFA_REQUIRED` challenge;
  - temporary password change revokes old sessions and advances the same challenge;
  - enrollment secret is encrypted before flush and confirmation returns recovery codes once;
  - TOTP and recovery verification creates a refresh session and records last login;
  - challenge expiry, consumption, wrong stage, and retry exhaustion are rejected;
  - refresh rotation revokes/replaces the prior token;
  - reuse of a rotated token revokes its entire family;
  - logout and global revocation are idempotent.
- [ ] Write fakeredis tests for rate limits keyed independently by normalized account and source IP, progressive temporary lockout, retry-after calculation, and successful-login counter reset.
- [ ] Implement `BrowserAuthService` with transaction boundaries around challenge consumption, recovery-code use, TOTP timestep updates, and refresh rotation.
- [ ] Keep public login failures generic. Store detailed reason only in a redacted audit event such as `auth.login.failed`, with email represented by a non-reversible keyed identifier rather than plaintext for unknown accounts.
- [ ] Add Redis helpers that fail securely for login throttling in deployed environments but can use an in-process bounded fallback in local/test when Redis is unavailable.
- [ ] Revoke all browser sessions after password change, password reset, MFA reset, account disable, role change, or security-sensitive email change.
- [ ] Run:

```bash
cd backend
uv run pytest tests/test_browser_auth_service.py tests/test_auth_rate_limits.py -q
uv run ruff check src/hms_backend/app/modules/identity/browser_auth.py src/hms_backend/app/core/redis.py tests/test_browser_auth_service.py tests/test_auth_rate_limits.py
uv run mypy src/hms_backend/app/modules/identity/browser_auth.py
```

Expected: state-machine, replay, revocation, and throttling tests pass.

- [ ] Commit:

```bash
git add backend/src/hms_backend/app/modules/identity/browser_auth.py backend/src/hms_backend/app/core/config.py backend/src/hms_backend/app/core/redis.py backend/tests/test_browser_auth_service.py backend/tests/test_auth_rate_limits.py
git commit -m "feat(auth): implement browser authentication state machine"
```

## Task 4: Expose Browser Auth Endpoints and Cookie Rotation

**Files:**
- Create: `backend/src/hms_backend/app/api/browser_auth.py`
- Modify: `backend/src/hms_backend/app/api/auth.py`
- Modify: `backend/src/hms_backend/app/main.py`
- Modify: `backend/src/hms_backend/app/api/dependencies.py`
- Create: `backend/tests/test_browser_auth_api.py`
- Modify: `backend/tests/test_auth_login.py`

Use one discriminated response contract throughout the browser flow:

```python
class BrowserAuthNextStep(StrEnum):
    PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED"
    MFA_ENROLLMENT_REQUIRED = "MFA_ENROLLMENT_REQUIRED"
    MFA_REQUIRED = "MFA_REQUIRED"
    RECOVERY_CODES = "RECOVERY_CODES"
    AUTHENTICATED = "AUTHENTICATED"


class BrowserChallengeResponse(BaseModel):
    next_step: BrowserAuthNextStep
    challenge: str
    expires_in: int


class BrowserAuthenticatedResponse(BaseModel):
    next_step: Literal[BrowserAuthNextStep.AUTHENTICATED]
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int


class BrowserRecoveryCodesResponse(BaseModel):
    next_step: Literal[BrowserAuthNextStep.RECOVERY_CODES]
    access_token: str
    expires_in: int
    recovery_codes: list[str]
```

The endpoint payloads are `BrowserLoginRequest(email, password)`,
`BrowserPasswordChangeRequest(challenge, new_password)`,
`BrowserChallengeRequest(challenge)`, and
`BrowserCodeRequest(challenge, code)`. Refresh and logout accept no token in
JSON; they read only the configured cookie.

- [ ] Write API tests for:
  - `POST /api/v1/auth/browser/login`;
  - `POST /api/v1/auth/browser/password`;
  - `POST /api/v1/auth/browser/mfa/enrollment`;
  - `POST /api/v1/auth/browser/mfa/confirm`;
  - `POST /api/v1/auth/browser/mfa/verify`;
  - `POST /api/v1/auth/browser/recovery/verify`;
  - `POST /api/v1/auth/browser/refresh`;
  - `POST /api/v1/auth/browser/logout`;
  - `GET /api/v1/auth/browser/me`.
- [ ] Assert that intermediate responses contain only a short-lived opaque challenge and next-stage enum, never an access or refresh token.
- [ ] Assert successful MFA returns a short-lived access token and sets the refresh cookie with `HttpOnly`, `SameSite=Strict`, configured `Secure`, and narrow `/api/v1/auth/browser` path attributes.
- [ ] Assert refresh/logout reject a missing or disallowed `Origin`; allow configured localhost origins in local mode and exact HTTPS staff origins in deployed mode.
- [ ] Assert refresh rotates the cookie and a second use of the old cookie fails and revokes the family.
- [ ] Implement request/response schemas and route handlers in a new router. Keep the existing `/auth/login`, `/auth/password`, and native bearer tests unchanged except for stronger shared password policy where applicable.
- [ ] Add a browser access-token claim such as `client=staff-web`; still resolve role/customer scope from the persisted user in `get_current_principal`.
- [ ] Make `_persisted_user_principal` reject `DISABLED` users and currently locked browser accounts while preserving valid native inspector behavior for active users.
- [ ] Return display name, email, account status, roles, permissions, and customer ids from `/auth/browser/me`.
- [ ] Run:

```bash
cd backend
uv run pytest tests/test_browser_auth_api.py tests/test_auth_login.py tests/test_auth_crypto.py -q
uv run ruff check src tests/test_browser_auth_api.py
```

Expected: browser auth endpoints pass and existing native login tests remain green.

- [ ] Commit:

```bash
git add backend/src/hms_backend/app/api/browser_auth.py backend/src/hms_backend/app/api/auth.py backend/src/hms_backend/app/api/dependencies.py backend/src/hms_backend/app/main.py backend/tests/test_browser_auth_api.py backend/tests/test_auth_login.py
git commit -m "feat(auth): expose secure staff browser sessions"
```

## Task 5: Harden User Administration and Privilege Boundaries

**Files:**
- Modify: `backend/src/hms_backend/app/api/admin.py`
- Modify: `backend/src/hms_backend/app/api/schemas.py`
- Create: `backend/src/hms_backend/app/modules/identity/user_admin.py`
- Create: `backend/tests/test_user_admin_security.py`
- Modify: `backend/tests/test_admin_api.py`

Use explicit command endpoints and response types:

```text
POST  /api/v1/admin/users
PATCH /api/v1/admin/users/{user_id}
POST  /api/v1/admin/users/{user_id}/disable
POST  /api/v1/admin/users/{user_id}/enable
POST  /api/v1/admin/users/{user_id}/unlock
POST  /api/v1/admin/users/{user_id}/password-reset
POST  /api/v1/admin/users/{user_id}/mfa-reset
```

```python
class UserCreateResult(BaseModel):
    user: UserRead
    temporary_password: str


class TemporaryPasswordResult(BaseModel):
    user_id: str
    temporary_password: str
```

- [ ] Write authorization matrix tests proving:
  - Super Admin can create and manage all six roles, including Super Admin;
  - HMS Admin can create/manage only HMS Admin, Inspector, Assembly, Reviewer, and Customer User;
  - HMS Admin cannot edit, disable, reset password/MFA, unlock, or elevate a Super Admin;
  - non-admin roles cannot call user-admin endpoints;
  - Customer User requires exactly one active customer id and non-customer roles cannot retain an unintended customer scope.
- [ ] Change user creation to generate a temporary password server-side, hash it, set `must_change_password=true`, and return the plaintext password only in the create response.
- [ ] Generate `oidc_subject` server-side for local users; do not ask staff operators to invent identity-provider subjects.
- [ ] Add endpoints for update, disable, enable, unlock, temporary-password reset, and MFA reset. Prefer explicit commands over overloading soft delete.
- [ ] Require recent authentication for password/MFA reset, role elevation, disable, and security-sensitive email change. Represent it through access-token `auth_time` and a configurable maximum age.
- [ ] Revoke active browser sessions on security-sensitive changes.
- [ ] Append redacted audit events for create, edit, role change, enable/disable, unlock, password reset, MFA reset, and denied privilege escalation.
- [ ] Return one-time secrets from create/reset endpoints only; ensure list/get schemas cannot serialize them.
- [ ] Run:

```bash
cd backend
uv run pytest tests/test_user_admin_security.py tests/test_admin_api.py -q
uv run ruff check src/hms_backend/app/api/admin.py src/hms_backend/app/modules/identity/user_admin.py tests/test_user_admin_security.py
```

Expected: all privilege-boundary and one-time-secret tests pass.

- [ ] Commit:

```bash
git add backend/src/hms_backend/app/api/admin.py backend/src/hms_backend/app/api/schemas.py backend/src/hms_backend/app/modules/identity/user_admin.py backend/tests/test_user_admin_security.py backend/tests/test_admin_api.py
git commit -m "feat(admin): add secure role-aware user lifecycle"
```

## Task 6: Add Development-Only Role Account Seeding

**Files:**
- Modify: `backend/src/hms_backend/app/tooling/local_seed.py`
- Modify: `backend/src/hms_backend/app/cli.py`
- Create: `backend/tests/test_dev_auth_seed.py`
- Modify: `README.md`

- [ ] Write tests proving the command refuses `production`, `prod`, or `staging`, creates one account for every role, assigns the Customer User to a synthetic customer, hashes unique temporary passwords, and prints each credential once.
- [ ] Add an explicit command such as `uv run hms-seed --auth-test-accounts`; do not make credential generation happen during ordinary application startup.
- [ ] Use the approved addresses: `super.admin@example.test`, `hms.admin@example.test`, `inspector@example.test`, `assembly@example.test`, `reviewer@example.test`, and `customer.user@example.test`.
- [ ] Make the command idempotent for account rows while rotating a temporary password only when the operator supplies an explicit `--reset-existing` flag.
- [ ] Print a terminal table containing email, role, one-time temporary password, and customer assignment. Never write it to a file.
- [ ] Document that each account must complete real password change and MFA enrollment.
- [ ] Run:

```bash
cd backend
uv run pytest tests/test_dev_auth_seed.py -q
ENVIRONMENT=local uv run hms-seed --auth-test-accounts
```

Expected: six random credentials print once; the command refuses production-like environments in its test.

- [ ] Commit:

```bash
git add backend/src/hms_backend/app/tooling/local_seed.py backend/src/hms_backend/app/cli.py backend/tests/test_dev_auth_seed.py README.md
git commit -m "feat(dev): seed one secure account per HMS role"
```

## Task 7: Add the Staff Auth Client and Provider

**Files:**
- Modify: `web/apps/staff/src/domain/types.ts`
- Modify: `web/apps/staff/src/api/hmsClient.ts`
- Create: `web/apps/staff/src/auth/AuthProvider.tsx`
- Create: `web/apps/staff/src/auth/authTypes.ts`
- Create: `web/apps/staff/src/__tests__/AuthProvider.test.tsx`
- Modify: `web/apps/staff/src/__tests__/hmsClient.test.ts`

The provider's public contract is:

```typescript
type AuthState =
  | { status: "loading" }
  | { status: "signed-out"; message?: string }
  | { status: "password-change"; challenge: string }
  | { status: "mfa-enrollment"; challenge: string; otpauthUri?: string; manualKey?: string }
  | { status: "mfa-challenge"; challenge: string }
  | { status: "recovery-codes"; session: StaffSession; recoveryCodes: string[] }
  | { status: "authenticated"; session: StaffSession }
  | { status: "expired"; message: string };

interface AuthContextValue {
  state: AuthState;
  login(email: string, password: string): Promise<void>;
  changeRequiredPassword(password: string): Promise<void>;
  startMfaEnrollment(): Promise<void>;
  confirmMfa(code: string): Promise<void>;
  verifyMfa(code: string): Promise<void>;
  verifyRecoveryCode(code: string): Promise<void>;
  acknowledgeRecoveryCodes(): void;
  logout(): Promise<void>;
  getAccessToken(): string | null;
}
```

- [ ] Write client tests for all browser auth endpoints, `credentials: "include"` on refresh/logout, bearer injection from an in-memory token getter, and exactly one refresh-and-retry on a protected-request 401.
- [ ] Replace `loadAuthSessionWithFallback` usage for auth with explicit signed-out/error results. Keep mock fallback helpers only for non-auth demo data and ensure they cannot synthesize identity.
- [ ] Add auth types for loading, signed out, password-change required, MFA enrollment required, MFA challenge required, recovery-code display, authenticated, and expired/error states.
- [ ] Implement `AuthProvider` that attempts one cookie refresh on initial load, owns the access token only in React state/ref, loads `/auth/browser/me`, and clears all auth and API state on logout or failed refresh.
- [ ] Ensure concurrent 401s share one in-flight refresh promise rather than rotating the cookie multiple times.
- [ ] Do not put the token or temporary/recovery credentials in local storage, session storage, URL parameters, query strings, or browser history.
- [ ] Run:

```bash
cd web/apps/staff
npm test -- --run src/__tests__/hmsClient.test.ts src/__tests__/AuthProvider.test.tsx
npm run build
```

Expected: client/provider tests pass and TypeScript build succeeds.

- [ ] Commit:

```bash
git add web/apps/staff/src/domain/types.ts web/apps/staff/src/api/hmsClient.ts web/apps/staff/src/auth web/apps/staff/src/__tests__/hmsClient.test.ts web/apps/staff/src/__tests__/AuthProvider.test.tsx
git commit -m "feat(staff): add browser authentication provider"
```

## Task 8: Build Sign-In, Password, and MFA Screens

**Files:**
- Modify: `web/apps/staff/package.json`
- Modify: `web/apps/staff/package-lock.json`
- Create: `web/apps/staff/src/auth/AuthFlow.tsx`
- Create: `web/apps/staff/src/auth/LoginScreen.tsx`
- Create: `web/apps/staff/src/auth/PasswordChangeScreen.tsx`
- Create: `web/apps/staff/src/auth/MfaEnrollmentScreen.tsx`
- Create: `web/apps/staff/src/auth/MfaChallengeScreen.tsx`
- Create: `web/apps/staff/src/auth/RecoveryCodesScreen.tsx`
- Create: `web/apps/staff/src/__tests__/AuthFlow.test.tsx`
- Modify: `web/apps/staff/src/styles.css`

- [ ] Add `qrcode.react`, `@zxcvbn-ts/core`, and `@zxcvbn-ts/language-common`.
- [ ] Write component tests for generic login errors, disabled submit while pending, password policy feedback, paste/password-manager compatibility, QR and manual key enrollment, six-digit TOTP entry, recovery-code switch, one-time recovery-code acknowledgement, expired challenge return to sign-in, and no secret persistence after unmount.
- [ ] Build a focused BAT-branded login/auth layout with proper labels, `autocomplete` attributes (`username`, `current-password`, `new-password`, `one-time-code`), accessible error summaries, focus management, and responsive dimensions.
- [ ] Use `QRCodeSVG` from `qrcode.react`; do not hand-draw QR SVG.
- [ ] Show zxcvbn strength as guidance while rendering backend policy errors as authoritative.
- [ ] Make recovery codes printable/copyable only from the one-time screen, require acknowledgement, and clear them from provider state on exit.
- [ ] Add restrained transitions that respect `prefers-reduced-motion`; no layout-shifting animations.
- [ ] Run:

```bash
cd web/apps/staff
npm install
npm test -- --run src/__tests__/AuthFlow.test.tsx
npm run build
```

Expected: auth screen tests and production build pass.

- [ ] Commit:

```bash
git add web/apps/staff/package.json web/apps/staff/package-lock.json web/apps/staff/src/auth web/apps/staff/src/__tests__/AuthFlow.test.tsx web/apps/staff/src/styles.css
git commit -m "feat(staff): build password and authenticator login flow"
```

## Task 9: Gate the App Shell and Implement Logout/Account Security

**Files:**
- Modify: `web/apps/staff/src/main.tsx`
- Modify: `web/apps/staff/src/App.tsx`
- Modify: `web/apps/staff/src/components/AppShell.tsx`
- Create: `web/apps/staff/src/components/AccountSecurity.tsx`
- Modify: `web/apps/staff/src/__tests__/App.test.tsx`
- Create: `web/apps/staff/src/__tests__/AccountSecurity.test.tsx`

- [ ] Write tests proving unauthenticated users see only auth screens, authenticated users receive the server session, sidebar and user-menu logout both work, failed refresh returns to login, and no mock admin appears after a 401.
- [ ] Wrap the staff entry point in `AuthProvider`; render `AuthFlow` until authenticated and pass the resulting session into `HmsApp`.
- [ ] Remove `mockStaffSession` initialization and `loadAuthSessionWithFallback` from the production app path. Keep `initialSession` only as an explicit test/story seam.
- [ ] Add functional logout callbacks to both shell logout controls and close all popovers during logout.
- [ ] Add an Account & Security view showing identity, role, customer scope, MFA state, password-change action, session expiry guidance, and recovery-code/MFA reset guidance without displaying secret material.
- [ ] Ensure module navigation uses backend permissions and that Customer User cannot access cross-customer records even through direct API calls.
- [ ] Run:

```bash
cd web/apps/staff
npm test -- --run src/__tests__/App.test.tsx src/__tests__/AccountSecurity.test.tsx
npm run build
```

Expected: gating/logout tests pass and no mock identity is reachable through production startup.

- [ ] Commit:

```bash
git add web/apps/staff/src/main.tsx web/apps/staff/src/App.tsx web/apps/staff/src/components/AppShell.tsx web/apps/staff/src/components/AccountSecurity.tsx web/apps/staff/src/__tests__/App.test.tsx web/apps/staff/src/__tests__/AccountSecurity.test.tsx
git commit -m "feat(staff): gate console and add secure logout"
```

## Task 10: Complete Dynamic Users & Roles UI

**Files:**
- Modify: `web/apps/staff/src/components/SystemWorkspace.tsx`
- Create: `web/apps/staff/src/components/UserAdminDialog.tsx`
- Create: `web/apps/staff/src/components/OneTimeCredentialDialog.tsx`
- Modify: `web/apps/staff/src/api/hmsClient.ts`
- Modify: `web/apps/staff/src/domain/types.ts`
- Create: `web/apps/staff/src/__tests__/UserAdministration.test.tsx`

- [ ] Write role-matrix UI tests for all six roles, including that HMS Admin never receives Super Admin management controls while Super Admin does.
- [ ] Extend API mappings for account status, MFA status, lock expiry, last login, and one-time temporary-password responses.
- [ ] Replace archive-only behavior with create, edit, disable, enable, unlock, temporary-password reset, and MFA reset commands.
- [ ] Require customer selection only for Customer User and validate it before submission.
- [ ] Show one-time temporary passwords in a dedicated dialog after create/reset. Prevent reopening after close and remove the value from state immediately when dismissed.
- [ ] Add confirmation dialogs for disabling, role elevation, password reset, and MFA reset; show backend privilege errors without optimistic role changes.
- [ ] Add clear loading, empty, disabled, locked, and API-error states. Never fall back to mock users after an authenticated API failure.
- [ ] Run:

```bash
cd web/apps/staff
npm test -- --run src/__tests__/UserAdministration.test.tsx
npm run build
```

Expected: all six role views and lifecycle commands pass component tests.

- [ ] Commit:

```bash
git add web/apps/staff/src/components/SystemWorkspace.tsx web/apps/staff/src/components/UserAdminDialog.tsx web/apps/staff/src/components/OneTimeCredentialDialog.tsx web/apps/staff/src/api/hmsClient.ts web/apps/staff/src/domain/types.ts web/apps/staff/src/__tests__/UserAdministration.test.tsx
git commit -m "feat(staff): complete role-aware user administration"
```

## Task 11: Enforce Role Views and Customer Scope End-to-End

**Files:**
- Modify: `web/apps/staff/src/App.tsx`
- Modify: `web/apps/staff/src/components/AppShell.tsx`
- Modify: `backend/tests/test_rbac.py`
- Create: `backend/tests/test_customer_user_scope.py`
- Create: `web/apps/staff/src/__tests__/RoleNavigation.test.tsx`

- [ ] Add backend tests for the six approved role permission matrices and customer-scoped list/detail access across customers, assets, inspections, certificates, and retest schedules.
- [ ] Add frontend tests that render each server session and assert only the approved navigation and commands are visible.
- [ ] Adjust HMS Admin inspection/certificate modules to be visible as read-only while protected review/approval commands remain unavailable unless the backend grants the corresponding permission.
- [ ] Ensure Inspector, Assembly, Reviewer, and Customer User dashboards lead directly to their primary workflows rather than an admin-only dashboard.
- [ ] Verify forged role/customer headers cannot change authorization in bearer mode because the backend resolves both from the User row.
- [ ] Run:

```bash
cd backend
uv run pytest tests/test_rbac.py tests/test_customer_user_scope.py -q
cd ../web/apps/staff
npm test -- --run src/__tests__/RoleNavigation.test.tsx
```

Expected: backend scope and frontend visibility matrices match the approved design.

- [ ] Commit:

```bash
git add backend/tests/test_rbac.py backend/tests/test_customer_user_scope.py web/apps/staff/src/App.tsx web/apps/staff/src/components/AppShell.tsx web/apps/staff/src/__tests__/RoleNavigation.test.tsx
git commit -m "feat(auth): enforce six HMS role workspaces"
```

## Task 12: Configure Docker and Deployment Secrets Safely

**Files:**
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify after merging the deployment foundation: `infra/terraform/envs/dev/main.tf`
- Modify after merging the deployment foundation: `infra/terraform/envs/dev/variables.tf`
- Modify after merging the deployment foundation: `infra/terraform/envs/dev/terraform.tfvars.example`
- Modify: `.github/workflows/deploy-aws-dev.yml`
- Modify: `README.md`
- Create: `backend/tests/test_auth_production_config.py`

- [ ] Add tests that production-like settings reject missing signing, MFA encryption, recovery pepper, allowed origins, and secure-cookie configuration.
- [ ] Add local Compose values using generated development-only secrets, `AUTH_BROWSER_COOKIE_SECURE=false`, and exact localhost origins. Do not commit real production credentials.
- [ ] Add AWS Secrets Manager references for bearer signing secret, MFA encryption key, and recovery-code pepper; configure the staff CloudFront origin in the allowed-origin setting and enforce secure cookies.
- [ ] Add a deploy-time validation command before ECS rollout so invalid auth configuration fails CI rather than serving a broken login.
- [ ] Document secret generation/rotation and recovery implications. TOTP encryption-key rotation must support the stored key-version field; do not destroy the previous key until enrolled secrets are rewrapped or reset.
- [ ] Run:

```bash
cd backend
uv run pytest tests/test_auth_production_config.py -q
cd ..
docker compose config --quiet
```

Expected: production config tests pass and Compose renders without exposing secret values.

- [ ] Commit:

```bash
git add .env.example docker-compose.yml infra .github/workflows/deploy-aws-dev.yml README.md backend/tests/test_auth_production_config.py
git commit -m "chore(auth): wire browser security configuration"
```

## Task 13: Full Regression and Browser Acceptance

**Files:**
- Create: `web/apps/staff/playwright.config.ts`
- Create: `web/apps/staff/e2e/staff-auth.spec.ts`
- Modify: `web/apps/staff/package.json`
- Modify: `web/apps/staff/package-lock.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

- [ ] Run complete backend quality gates:

```bash
cd backend
uv run ruff check . ../tooling
uv run mypy src tests ../tooling
uv run pytest
```

Expected: all backend checks pass, including existing inspector/mobile authentication tests.

- [ ] Run complete staff checks:

```bash
cd web/apps/staff
npm test -- --run
npm run build
```

Expected: all Vitest tests and production build pass.

- [ ] Rebuild and start the local stack:

```bash
cd ../../..
docker compose --profile frontend up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8000/health/ready
```

Expected: Postgres, Redis, API, worker, beat, certificate engine, and staff UI are healthy; readiness returns 200.

- [ ] Seed the six role accounts and retain the terminal output only for this acceptance run.
- [ ] Install `@playwright/test`, add `test:e2e`, and configure `webServer` to run the staff Vite app against the Docker API. Add browser acceptance coverage for each account: first login, forced password change, MFA enrollment, recovery-code acknowledgement, logout, second login with TOTP, role-specific navigation, and logout from both controls.
- [ ] Add negative browser/API coverage for wrong password, expired challenge, wrong/replayed TOTP, consumed recovery code, disabled account, timed lock, unauthorized module, HMS Admin Super Admin escalation, forged customer scope, refresh reuse, and session revocation after reset.
- [ ] Verify responsive auth and user-admin screens at desktop and mobile widths, keyboard-only use, focus order, labels, contrast, no overlaps, and reduced-motion behavior.
- [ ] Inspect browser console/network logs: no uncaught errors, no raw secrets in URLs/logs, no access token persisted, and refresh cookie is HttpOnly/SameSite/secure as appropriate.
- [ ] Add the browser smoke test to CI after unit/integration checks.
- [ ] Commit:

```bash
git add web/apps/staff/playwright.config.ts web/apps/staff/e2e/staff-auth.spec.ts web/apps/staff/package.json web/apps/staff/package-lock.json .github/workflows/ci.yml README.md
git commit -m "test(auth): cover staff login and role journeys end to end"
```

## Final Verification and Review

- [ ] Run `git status --short` and confirm only intended files are changed; leave `docs/hms-role-access-matrix.xlsx` untouched.
- [ ] Search for forbidden placeholders and accidental secret persistence:

```bash
rg -n "TODO|FIXME|mockStaffSession|localStorage|sessionStorage|temporary_password|mfa_secret|refresh_token" backend/src web/apps/staff/src
```

Expected: matches are reviewed and intentional; production auth has no mock fallback or browser token storage.

- [ ] Run the complete verification commands from Task 13 once more on the final tree.
- [ ] Request a code review focused on session rotation/reuse detection, privilege escalation, secret leakage, customer scoping, and native inspector regression risk.
- [ ] Address findings, rerun affected tests, then use `superpowers:finishing-a-development-branch` to decide merge/PR handling.
