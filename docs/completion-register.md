# Completion register

Work that is known, deliberately not done yet, and must not be lost. Update this file
when an item is started, decided or finished.

| # | Item | State | Notes |
|---|---|---|---|
| 1 | Staff scheduling / dispatch calendar | open | Product work |
| 2 | Inspector agenda / calendar | open | Product UI work for the Inspector app; separate from sync resilience (PR C) |
| 3 | Reports / history review | open | |
| 4 | Whole-product E2E and UI/UX attack-and-fix pass | open | Includes the deferred authenticated live checks (portal login, org switch, live booking, scoped bell, notifications page, certificate/PDF, staff login/bell) |
| 5 | Direct password-management endpoints: `/auth/password`, `/auth/users/{id}/password`, and the reset aliases (`/auth/password/reset-request`, `/auth/password/reset-confirm`) | **decision needed: retire or harden** | Found during PR C. `/auth/password` and `/auth/users/{id}/password` check only `min_length=10` (not `validate_password_policy`), write no audit event, do not revoke browser refresh sessions, and have no lockout beyond the global limiter. No web app calls them (staff use the browser flow). The reset endpoints were not changed in PR C. |
| 6 | Fully offline cold start of the Inspector | open (decision) | The saved assigned-work snapshot is now persisted and hydrates as soon as the user is authenticated, but the sign-in check (`/auth/browser/refresh` + `/me`) must still succeed after a browser restart. Working fully offline from a cold start needs a persisted, device-bound identity: a security decision, not part of the sync protocol. |
| 7 | Old-client bootstrap path (`_legacy_bootstrap`, 2,000-item ceiling) | open, time-boxed | Remove when no registered device reports an app version below 0.2.0 and the paged Inspector has been live for one offline window (7 days). See `docs/sync-bootstrap-paging.md`. |
