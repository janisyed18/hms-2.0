# Staff scheduling and dispatch calendar

The Scheduling workspace is a first-class Staff module (Operations > Scheduling) for
HMS admins, super admins and inspectors (an inspector sees only their assigned,
confirmed work, as everywhere else). Customers keep the Bookings view in their portal.

## Data

* `GET /api/v1/inspection-schedule?start&end[&customer_id&location_id&inspector_user_id&status&unassigned&limit]`
  (`records.py`). Read only. `start`/`end` are mandatory, time-zone aware, `end > start`
  and at most 43 days apart (six whole local weeks plus a daylight-saving hour); `limit`
  defaults to 500, maximum 1000, and the response carries `total` so the UI can say when
  a period is only partly shown. It returns the existing `InspectionBookingRead` shape
  (customer, location with its scheduling zone, assets, persisted appointment snapshot,
  change requests) plus `inspectors` (id and display name) for the inspectors in the
  result. Visibility is exactly that of `/inspection-bookings`.
* `GET /api/v1/inspection-bookings?has_pending_change=true` feeds the pending-requests
  queue with reschedules awaiting a decision, wherever they fall in time.
* A booking's `scheduled_at`/`scheduled_end_at` always hold its *current* slot
  (rescheduling rewrites them), so the range filter is a comparison on those columns.
* Migration `20261023_0023` adds `ix_inspection_bookings_scheduled_at`. The query also
  carries a redundant `scheduled_at >= start - 2 days` bound so the index has both ends.
  PostgreSQL 16, 150,000 bookings, one-week range, `EXPLAIN (ANALYZE, BUFFERS)`:
  sequential scan about 42 ms and 2,747 buffers; index plus the lower bound about 2.2 ms
  and 29 buffers (without the lower bound the index alone scanned 61,000 rows).
* There is no new mutation endpoint. Every action calls the existing validated one.

## Views

* **Day** (primary): hour scale, one lane per inspector plus an Unassigned lane, blocks
  positioned by elapsed time (correct on 23- and 25-hour daylight-saving days), side by
  side where they overlap, a current-time line on today. Each lane shows
  "N visits · Xh scheduled" (a count, not a claim about remaining capacity). With nine or
  more inspectors idle ones are hidden behind a toggle; the grid scrolls both ways with
  sticky headers and time column.
* **Week**: seven day columns on the same grid; day headers open the Day view.
* **Month**: six-week Monday-first grid with per-day counts by status, unassigned and
  overlapping counts; a day opens the Day view. It is a summary, not a dispatch surface.
* **List**: searchable, paginated table of the same period and filters (the accessible
  equivalent of the calendar).
* **Pending requests**: new booking requests and reschedule requests with age, requested
  time, current appointment and the next action.
* Today / Previous / Next / jump-to-date keep the chosen range (a day, a week or a month).

## Status

Presentation groups mapped from existing server state (`statusOf`): awaiting approval,
change requested, confirmed, completed, no show, cancelled, declined. Status is never
colour alone: every block names it in text, and each group has its own border style.

## Time zones

The calendar has an explicit zone (default Australia/Sydney, changeable). Day boundaries,
block positions and the "now" line use it; nothing reads the browser's zone. A visit is
*described* in its own location's zone: a confirmed appointment shows the persisted
`local_start_snapshot` / `local_end_snapshot` (so a later tzdata change cannot silently
move a promised time), a pending request is computed from its instant in the location's
zone, and the zone abbreviation is added when it differs from the calendar's. Tests run
with the browser set to other zones and across a daylight-saving change.

## Actions (all existing endpoints)

Details drawer: assign and approve (inspector chosen, availability re-checked by the
server), decline and cancel (two-step), approve a customer's reschedule with an inspector,
request a reschedule (opens the existing booking form: availability quote, inspector,
reason; the server validates and checks concurrency). A stale or conflicting action (HTTP
409/404) keeps the drawer open, explains that the booking changed, reloads that booking
and the range. There is no separate "reassign" endpoint: changing the inspector of a
confirmed visit is a reschedule with another inspector.

## Creating from the calendar

"Book inspection" opens the existing booking form with the viewed day (Day view) as its
date. The form still obtains an availability quote; nothing is created from a cell click.

## Known limitations

* No drag-and-drop and no click-an-empty-slot creation (the validated button flow is used).
* The time zone list is a fixed set of Australian zones plus UTC.
* More than `limit` visits in a period are truncated with a visible notice; narrow the
  range or filters.
* Capacity is shown as workload only; HMS has no working-hours model per inspector.
* Not covered here: Inspector agenda/calendar, fully offline Inspector cold start,
  Reports/history, direct password endpoints, the retest discrepancy found in the live
  audit (see `completion-register.md`).
