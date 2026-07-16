# Code Quality and Security Cleanup

## Goal

Remove duplicated or inactive implementations identified during review while preserving existing staff password-reset URLs and keeping the deployed AWS branch secure.

## Design

### Password reset compatibility

Keep the existing `/api/v1/auth/password/reset-request` and `/api/v1/auth/password/reset-confirm` paths for compatibility. Both endpoints will call `PasswordResetService`, which is the only implementation responsible for rate limiting, opaque token generation, token persistence, encrypted delivery, expiry, supersession, and one-time consumption. The old HS256 reset-token encoder/decoder and notification construction will no longer be used for password recovery.

The browser-auth routes remain unchanged and continue to use the same service. Reset requests will preserve generic responses for unknown email addresses. Reset confirmation will preserve the existing HTTP contract while returning the service's safe validation errors.

### Cryptography configuration cleanup

Retain only `auth_password_reset_encryption_key`, `auth_password_reset_encryption_keys`, `auth_password_reset_key_version`, and the reset lifetime/rate-limit settings used by `password_reset_tokens.py` and `password_reset.py`. Remove the unused legacy `secret_envelope.py`, its tests, and the old `auth_password_reset_keys` setting. No database migration is required because the removed abstraction has no runtime model or persisted format in this branch.

### Frontend loading and quality

Keep the authenticated shell and customer workspace eager. Load the remaining staff workspaces with `React.lazy` and `Suspense` so the initial dashboard bundle does not include every module. Use an existing workspace-state loading presentation for the fallback.

Move Vite, TypeScript, and the Vite React plugin to development dependencies in both web applications. Add a minimal ESLint flat configuration for TypeScript, React hooks, and unused code, with a `lint` script. Existing hook dependency suppressions will be removed by making the effects use correct dependency lists.

Move the identical staff date-time formatter into a small shared utility. No date library will be added; native string/locale behavior is sufficient for the current display contract.

## Verification

- Backend regression tests prove both legacy reset paths use the new service and do not issue HS256 reset tokens.
- Existing browser password-reset, auth, notification, and configuration tests remain green.
- Staff and inspector lint, TypeScript builds, and production Vite builds pass.
- The final diff is checked for whitespace errors, duplicate reset settings, and remaining imports of the removed crypto module.

## Out of scope

- Changing password policy, MFA behavior, notification providers, database schema, or public API response formats.
- Introducing a UI component library, date library, or additional runtime dependency.
