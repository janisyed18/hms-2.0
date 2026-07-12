# HMS Staff Multi-Role Authentication Design

**Status:** Approved
**Date:** 2026-07-12
**Project:** BAT Engineering HMS 2.0
**Scope:** Staff web login, logout, account security, user administration, MFA,
and role-specific workspaces

## 1. Objective

Replace the staff application's implicit mock/admin session with a real,
server-authoritative authentication flow. Every persisted HMS role must be able
to sign in using its own account and see only its authorized records, modules,
and commands. Super Admin and HMS Admin users must be able to create and manage
additional accounts without exposing credentials after creation.

The implementation must preserve the existing native inspector authentication
and offline session model. Browser authentication is a separate client flow over
the same persisted users, permissions, audit ledger, and Argon2 password store.

## 2. Approved Decisions

| Decision | Approved value |
| --- | --- |
| Authentication implementation | Built into the existing FastAPI and React applications |
| Password hashing | Existing Argon2id implementation |
| MFA | Standards-based TOTP using PyOTP |
| Enrollment QR | `qrcode.react` |
| MFA scope | Required for every account |
| Initial password | Random temporary password, changed on first login |
| Account creation | Super Admin and HMS Admin |
| Super Admin elevation | Super Admin only |
| Browser access token | Short-lived and memory-only |
| Browser refresh token | Rotating Secure, HttpOnly, SameSite=Strict cookie |
| Development accounts | Generated locally, random credentials printed once |
| Mock fallback | Never used after authentication failure |
| Future identity provider | Existing OIDC boundary remains supported |

PyOTP and `qrcode.react` are open-source and require no paid authentication or
messaging provider. The security controls follow the OWASP Authentication,
Password Storage, and Multifactor Authentication cheat sheets.

## 3. Roles and Views

Authorization remains enforced by backend permissions and customer scoping.
Hidden navigation is not a security boundary.

### 3.1 Super Admin

Super Admin can access every module and command, including user creation, all
role assignment, Super Admin elevation, password reset, MFA reset, account
disable/enable, unlock, device administration, and audit review.

### 3.2 HMS Admin

HMS Admin can access dashboard, analytics, customers, assets, products,
reference data, retest schedules, users, devices, and audit. Inspection and
certificate records are visible but their protected review/approval actions
remain permission-controlled. HMS Admin can create and manage lower-privilege
roles but cannot create, elevate, edit, disable, or reset a Super Admin.

### 3.3 Inspector

Inspector can access its operational dashboard, customers and assets as
read-only context, retest schedules, and inspection draft/submission workflows.
The native inspector application continues to provide the offline field flow.

### 3.4 Assembly

Assembly can access its operational dashboard, read customer context, create or
edit permitted asset and assembly records, and view retest scheduling.

### 3.5 Reviewer

Reviewer can access its review dashboard, customer/asset context, submitted
inspections, and certificate review/approval commands.

### 3.6 Customer User

Customer User sees only its assigned customer's dashboard, assets, inspection
history, certificates, and retest schedule. Every query remains customer-scoped.
Creating a Customer User requires exactly one active customer assignment.

## 4. Authentication Protocol

No full access token is issued until all required stages are complete.

```text
Email + password
    -> forced password change when required
    -> TOTP enrollment when required
    -> TOTP or recovery-code challenge
    -> access token + rotating refresh cookie
```

### 4.1 Password Login

The password endpoint returns a short-lived, single-purpose authentication
challenge when the password is valid. Responses for unknown users, wrong
passwords, disabled users, and inappropriate account states use generic public
messages. Internal reason codes are audit-only.

### 4.2 Forced Password Change

A newly created or administratively reset account has
`must_change_password=true`. The restricted challenge permits only the password
change operation. A successful change revokes existing refresh sessions, updates
password security metadata, and advances to MFA enrollment/challenge.

### 4.3 MFA Enrollment

Enrollment creates a random TOTP secret, encrypts it using AES-256-GCM with an
environment-managed key, and returns an `otpauth` URI to the authenticated setup
screen. The screen renders a QR code and a manual setup key. Enrollment is not
enabled until the user supplies a valid current code.

After confirmation, the server creates one-time recovery codes. Their plaintext
values are returned once; only keyed hashes are stored. The UI removes them from
memory when the user leaves the recovery-code screen.

### 4.4 MFA Challenge

Normal login requires a valid TOTP code or unused recovery code. The server
stores the last accepted TOTP time-step and rejects replay in the same window.
Using a recovery code atomically marks that code consumed.

### 4.5 Authenticated Session

The browser receives a short-lived access token in the response body and keeps
it only in React memory. A rotating refresh token is stored only in a Secure,
HttpOnly, SameSite=Strict cookie. Refresh validates the request origin, rotates
the server session and cookie, and rejects reuse of an earlier token.

Logout revokes the refresh session, clears the cookie, clears React/query state,
and returns to the login screen. Password reset, MFA reset, role change, account
disable, or security-sensitive email change revokes all active sessions.

## 5. Account and Credential Model

The User record gains:

- account status: `ACTIVE`, `LOCKED`, or `DISABLED`
- `must_change_password`
- `password_changed_at`
- `mfa_enabled`
- encrypted TOTP secret and key version
- last accepted TOTP time-step
- failed password/MFA counters
- `locked_until`
- `last_login_at`

Separate persisted records hold browser refresh sessions, short-lived login
challenges, and hashed recovery codes. Raw passwords, refresh tokens, TOTP
secrets, and recovery codes never appear in API logs, audit payloads, database
plaintext, or ordinary user responses.

Production encryption and recovery-code keys are supplied by the deployment
secret store. Startup fails closed when required production keys are absent.

## 6. Password and Abuse Controls

- Password length is 12 to 128 characters.
- Passphrases, whitespace, Unicode, paste, and password managers are supported.
- Passwords are never silently truncated.
- A local deny list blocks common/breached passwords without transmitting the
  submitted password to a third party.
- The UI provides a strength indicator but the backend owns enforcement.
- Passwords do not expire periodically; change is required for first login,
  compromise, reset, or authenticator-policy change.
- Temporary passwords use a cryptographically secure generator, are unique per
  account, and are shown once.
- Redis applies limits by normalized account identifier and source IP.
- Repeated password or MFA failures produce progressive temporary lockout up to
  a configurable maximum rather than permanent attacker-triggered lockout.
- Admin unlock and every security-state change are audited.
- Reauthentication is required before password, MFA, email, or privileged user
  administration changes.

## 7. Staff Frontend Architecture

An authentication provider owns the state machine:

- loading existing browser session
- signed out
- password change required
- MFA enrollment required
- MFA challenge required
- authenticated
- session expired or account unavailable

The provider owns the memory access token and supplies an authenticated HMS API
client. A page reload performs one refresh-cookie attempt. An API 401 performs
one refresh-and-retry; failure clears state and displays the login screen. Auth
errors never activate mock data or a development-header identity.

The UI adds:

- focused sign-in screen
- required password-change screen
- authenticator QR/manual-key enrollment screen
- MFA/recovery-code challenge screen
- one-time recovery-code screen
- session-expired state
- personal account/security view

The existing shell receives the authenticated session from `/auth/me`, filters
navigation by backend permissions, and provides functional logout controls in
the sidebar and user menu.

## 8. User Administration

The Users & Roles workspace supports:

- create user with name, email, role, and conditional customer assignment
- edit permitted identity and role fields
- disable or enable account
- unlock a temporarily locked account
- issue a password reset with a one-time temporary password
- reset MFA enrollment
- inspect account status, MFA state, last login, and recent security event

Create/reset responses contain a temporary password once. The frontend shows it
in a protected modal and discards it when closed. No API can read an existing
password or authenticator secret.

Backend authorization prevents privilege escalation even if UI controls are
forged. HMS Admin cannot manage Super Admin accounts or assign Super Admin.

## 9. Development Test Accounts

A development-only command creates one synthetic account per role:

```text
super.admin@example.test
hms.admin@example.test
inspector@example.test
assembly@example.test
reviewer@example.test
customer.user@example.test
```

The command refuses to run in production-like environments. It generates a
different random temporary password for every account, stores only Argon2
hashes, and prints the credentials once to the terminal. Every account follows
the real password-change and MFA-enrollment flow. Customer User is assigned only
to a synthetic customer.

## 10. Error Handling

- Authentication responses are generic and do not reveal account existence.
- Validation errors identify password-policy or MFA setup requirements only
  after a valid restricted challenge exists.
- Rate-limit and lockout responses provide a retry time without exposing failure
  counters.
- Expired/consumed challenges return the user to sign-in without retaining
  password, TOTP, QR, or recovery-code state.
- Cookie refresh failure clears all authenticated client data.
- User-management conflicts and stale versions use the existing ETag/optimistic
  concurrency behavior.
- Loading, empty, disabled, locked, expired, and server-error states are explicit
  and accessible.

## 11. Verification

Backend tests cover:

- all password, forced-change, enrollment, TOTP, recovery, refresh, and logout
  transitions
- expired/consumed challenge rejection and TOTP replay prevention
- encryption-at-rest and absence of plaintext credential material
- common-password rejection and Argon2 rehash
- per-account/IP throttling and timed unlock
- refresh rotation/reuse detection and global revocation
- all six role matrices and customer row scoping
- Super Admin/HMS Admin privilege boundaries
- audit-event coverage without secrets

Frontend tests cover:

- authentication-state routing and page reload recovery
- no mock/admin fallback after auth failure
- password, MFA, recovery, expiry, and logout screens
- one refresh-and-retry behavior
- navigation and commands for all six roles
- create/edit/disable/unlock/reset user workflows
- one-time temporary-password handling
- accessibility and responsive login/account states

Browser acceptance uses every generated development account to complete first
login, password change, MFA enrollment, logout, second login, and role-specific
navigation. Negative acceptance covers disabled/locked accounts, wrong or reused
MFA, consumed recovery codes, refresh reuse, unauthorized routes, and forged
role/customer changes.

## 12. Non-Goals

- Replacing the existing OIDC provider boundary
- Paid SMS/email MFA
- Passkeys/WebAuthn in this phase
- Social login
- Production user migration or legacy-password import
- Displaying fixed test credentials in the login UI or repository

## 13. References

- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP Multifactor Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
- [PyOTP documentation](https://pyauth.github.io/pyotp/)
- [`qrcode.react` package](https://www.npmjs.com/package/qrcode.react)
