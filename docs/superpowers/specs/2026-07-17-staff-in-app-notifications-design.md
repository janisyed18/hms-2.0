# Staff In-App Notifications

**Status:** Approved design
**Date:** 2026-07-17

## Goal

Replace the staff shell's static notification copy and hard-coded badge with a
server-backed in-app notification feed whose unread state is persisted per
recipient.

## Decisions

- The feed reads only `IN_APP` notifications for the authenticated staff user.
- Each notification gains a nullable `read_at` timestamp. An unread item has no
  timestamp; opening it marks it read exactly once.
- `POST /api/v1/notifications/{id}/read` is idempotent and only permits the
  current recipient to mark an in-app notification read. Other users receive
  `404`, avoiding cross-user record disclosure.
- `GET /api/v1/notifications/me` returns the newest in-app rows plus the
  persisted unread total for the top-bar badge.
- The popover is a compact, keyboard-accessible feed: unread rows have a blue
  dot and subtle selected surface; read rows remain available without that
  emphasis. It shows an explicit loading, empty, and error state.
- Opening a notification persists its read state and, when it has an existing
  asset or customer link, moves the staff user to that workspace. Record-detail
  deep linking is out of scope because notification rows do not yet retain
  inspection or certificate identifiers.

## Out Of Scope

- Bulk mark-as-read, notification deletion, and user notification preferences.
- Polling, WebSockets, browser push, or a new state-management package.
- Mock notification rows when the API is unavailable.

## Acceptance Criteria

- Badge count is the backend unread total, never a hard-coded value.
- Opening an unread notification removes its unread presentation and decrements
  the badge after the API confirms the persisted state.
- An in-app feed never exposes email or SMS delivery rows.
- The API prevents one user from reading another user's notification.
- The complete backend and staff tests plus the production build pass.
