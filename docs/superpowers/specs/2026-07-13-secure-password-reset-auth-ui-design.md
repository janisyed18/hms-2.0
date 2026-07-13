# BAT HMS Secure Password Reset and Authentication UI Design

**Status:** Approved

**Date:** 2026-07-13

**Scope:** Staff web authentication and self-service forgotten-password recovery

## Objective

Replace the basic staff sign-in presentation with a polished, accessible BAT
Operations authentication gateway and add secure self-service password recovery.
The change must preserve the existing browser authentication state machine,
Argon2 password storage, MFA requirements, rotating refresh sessions, audit
trail, and AWS SES notification delivery.

## Experience Direction

The approved visual direction is **Secure Operations Gateway**.

On desktop, the authentication surface is a two-part gateway: a navy BAT trust
panel and a focused white form panel. The trust panel identifies BAT HMS as an
operations console and briefly establishes that access is encrypted, audited,
and MFA protected. It does not contain marketing content or oversized display
type.

On mobile and tablet, the trust panel collapses into a compact branded header
and one short security line above the form. The form remains the primary content
and must fit without horizontal scrolling at 375 px.

The existing BAT navy, operational blue, neutral surface, border, success, and
error tokens remain authoritative. Lucide remains the single icon family. Form
controls use visible labels, at least 44 px interaction height, visible keyboard
focus, correct autocomplete values, and inline recovery-oriented errors.

## Authentication Screens

### Sign In

The sign-in screen contains:

- Email address with `autocomplete="username"`.
- Password with `autocomplete="current-password"`.
- A show/hide password control with an accessible label.
- A visible **Forgot password?** action adjacent to the password label.
- One primary **Sign in securely** action with pending feedback.
- A concise HMS administrator support line.

Authentication failures remain generic. Rate-limit feedback states when the user
may retry without exposing account state.

### Forgot Password

The screen asks only for the account email. Submission always transitions to the
same confirmation state, regardless of whether an eligible account exists. The
confirmation explains that the link expires after 15 minutes and suggests
checking junk mail. It provides a clear return to sign-in action.

### Reset Password

The reset screen is reached through `/reset-password?token=<opaque-token>` and
contains:

- New password with `autocomplete="new-password"` and visibility control.
- Confirmation field with `autocomplete="new-password"`.
- Persistent password-policy guidance.
- Password strength feedback for guidance only; the backend policy is
  authoritative.
- Inline mismatch and policy errors.
- One primary **Reset password** action with pending feedback.

Invalid, malformed, expired, used, and superseded tokens produce the same safe
error and a **Request another link** recovery action.

### Reset Complete

Success confirms that the password changed and all existing sessions were signed
out. The only primary action returns to sign-in. The user then signs in with the
new password and completes the normal MFA step. Password reset does not disable,
remove, or bypass MFA.

## Motion Direction

Motion is restrained and communicates state changes:

| Surface | Trigger | Motion | Purpose | Reduced-motion behavior |
| --- | --- | --- | --- | --- |
| Authentication panel | Initial load | Opacity and 8 px rise, 220 ms | Establish focus | Opacity only, effectively instant |
| Form step | Step change | Crossfade with 8 px directional offset, 160-220 ms | Preserve flow continuity | Short opacity change |
| Primary button | Press/pending | Small scale feedback and spinner transition | Confirm input and system activity | Color and spinner state only |
| Success state | Reset accepted | Check icon and content fade, under 240 ms | Confirm completion | Instant icon and content |

Motion uses the installed `motion` package, centralized duration/easing tokens,
transform and opacity only, and `useReducedMotion`. Animation never delays input
or navigation.

## Reset Token Architecture

Password reset uses persisted, opaque, single-use tokens rather than reusable
signed links.

1. Generate at least 32 bytes using a cryptographically secure random source.
2. Return the raw token only as part of the email link.
3. Persist its SHA-256 digest in the reset-token record. A separately encrypted,
   short-lived delivery envelope may hold the token only until SES delivery.
4. Associate the record with one user and an expiry 15 minutes after issuance.
5. Mark the token consumed atomically with the password update.
6. Invalidate unconsumed older tokens for the user when issuing a replacement.
7. Never log, audit, persist, or return the raw token through an API response.

The reset-token record contains an identifier, token digest, user identifier,
expiry, creation time, consumed time, and request metadata needed for security
auditing. Cleanup of expired rows may be performed separately; correctness does
not depend on cleanup timing.

### Sensitive Email Delivery

The general HMS notification log permanently stores rendered message bodies for
compliance, so password-reset links must not be materialized there. Password
reset therefore uses a dedicated short-lived delivery envelope created in the
same transaction as the reset-token record.

- The envelope stores the raw token only as AES-256-GCM ciphertext with a key
  version and authenticated context bound to the reset record and user.
- A dedicated password-reset delivery task decrypts the token in memory, renders
  the existing `PASSWORD_RESET` email template, and sends it through the existing
  AWS SES adapter.
- The ciphertext is scrubbed after successful delivery, final failure, or token
  expiry. Delivery status, attempts, timestamps, and a redacted error remain for
  operations support.
- The general `Notification` and `OutboxEvent` records never receive the token,
  reset URL, rendered sensitive body, or ciphertext.
- The encryption key is independent of the token digest and is supplied through
  AWS Secrets Manager. It is versioned so key rotation does not strand pending
  deliveries.

## Request Flow

`POST /api/v1/auth/browser/password/reset-request` accepts an email address.

- Apply independent rate limits to a normalized account fingerprint and source
  IP.
- Always return the same successful message and status.
- Perform a timing-normalizing operation for unknown accounts.
- Do not issue a token for deleted or disabled accounts.
- For an eligible account, invalidate earlier active tokens, create the digest
  record and encrypted delivery envelope, and commit them in one transaction.
- Build the reset URL from a dedicated staff-web public URL setting, not the API
  base URL.

The email is delivered by the dedicated security-email task through the existing
AWS SES adapter. The template identifies BAT Engineering, states the 15-minute
expiry, includes a single reset action, and explains how to ignore an
unrequested message.

## Confirmation Flow

`POST /api/v1/auth/browser/password/reset-confirm` accepts the raw token and new
password.

- Digest the token and lock/load the matching record.
- Reject missing, expired, consumed, or superseded records through one generic
  error.
- Enforce the existing centralized password policy.
- Hash the password with Argon2.
- Set `password_changed_at` and clear `must_change_password`.
- Clear temporary password lockout counters and restore a time-expired lock to
  active; a deliberately disabled account remains disabled.
- Atomically consume the reset token and invalidate other active reset tokens.
- Revoke all browser refresh sessions for the user.
- Append an `auth.password.reset` audit event without token or password data.
- Record the user mutation in `SyncChange` without credential material.
- Commit all security mutations together.

No access or refresh token is issued from reset confirmation.

## Security and Privacy Invariants

- Request responses do not reveal whether an email exists, is disabled, or is
  eligible for browser login.
- Raw reset tokens and passwords never enter logs, audit payloads, permanent
  notification records, analytics, or UI telemetry. A reset token exists in the
  database only as a digest and short-lived AES-GCM ciphertext pending delivery.
- Reset tokens are one-time, short-lived, random, and server-revocable.
- Password reset revokes every existing browser session.
- Reset does not bypass or reset MFA.
- Error messages do not distinguish expired, used, malformed, and superseded
  tokens.
- Rate limiting protects both account and IP dimensions.
- All database mutations required by the reset complete atomically.

## Frontend Architecture

The existing `AuthProvider` continues to own authenticated session state. Public
recovery state is added to the authentication flow rather than introducing a
second authentication application. The browser-auth client gains typed request
and confirmation methods. URL parsing occurs at the authentication boundary so
the reset token is removed from browser history after it is captured in memory.

Reusable authentication primitives cover labeled fields, password visibility,
status feedback, strength guidance, buttons, and the branded gateway shell. The
screen components remain focused on one state each. The desktop application shell
is not loaded until authentication succeeds.

## Error Handling

- Network failure keeps entered non-secret email data and provides retry.
- Password fields are cleared after a rejected reset confirmation.
- The first invalid field receives focus after client-side validation.
- Backend policy text is displayed next to the password field.
- Reset-request confirmation remains generic even if notification dispatch later
  fails; delivery failure is handled by the notification retry and admin log.
- Invalid reset links offer a direct route to request a replacement.

## Verification

Backend tests must demonstrate:

- Generic responses for known, unknown, deleted, and disabled accounts.
- Account and IP rate limiting.
- Only token digests are persisted.
- 15-minute expiry.
- A newer request supersedes previous tokens.
- Tokens can be consumed exactly once.
- Invalid token variants receive one generic error.
- Existing password policy is enforced.
- Password changes, reset-token consumption, session revocation, lockout reset,
  and audit creation are atomic and correct.
- MFA enrollment and recovery data remain unchanged.
- The sensitive delivery envelope is authenticated, decryptable only with the
  configured key, and scrubbed after delivery, final failure, or expiry.
- The email uses the configured staff-web URL and the general notification log
  contains no reset secret or URL.

Frontend tests must demonstrate:

- Forgot-password navigation and generic confirmation.
- Password visibility controls and autocomplete semantics.
- Reset URL token capture and history cleanup.
- Password mismatch, policy, pending, success, and invalid-link states.
- Return to sign-in after success.
- Existing login, forced-password-change, MFA, recovery-code, refresh, and logout
  flows remain functional.
- Keyboard navigation, focus behavior, accessible names, and reduced-motion
  handling.

Browser verification covers 375 px, 768 px, 1024 px, and 1440 px widths; no
horizontal overflow; sign-in and reset state transitions; and a deployed AWS
request-to-email-link-to-reset flow using a dedicated development account.

## Deployment

Terraform/ECS configuration exposes the CloudFront staff application URL to the
backend as the reset-link base and provides the versioned password-reset delivery
encryption key through AWS Secrets Manager. The existing SES identity,
notification worker, SES adapter, and CloudFront deployment pipeline are reused.
The migration is applied before the API task starts serving the new endpoints.
Staff assets are rebuilt, uploaded to S3, and followed by CloudFront invalidation.

No production or legacy HMS data is used during verification.
