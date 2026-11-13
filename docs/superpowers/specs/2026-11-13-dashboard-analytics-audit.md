# Dashboard & Analytics audit and metric contracts (Phase A)

Base: `main` @ 55cc7f5. Read-only audit; no behaviour changed by this document.
Locations are in `backend/src/hms_backend/app/api/records.py` (`records.py`) unless stated.
"Reproduced" below means established by reading the code and schema; no finding has been run
against data yet. Each finding lists the regression test that will prove it before the fix lands.

## 1. Data flow

```
assets / retest_schedules / certificates / inspections / customers / audit_events
  -> records.py: GET /dashboard (get_dashboard, :1604), GET /analytics/overview (:1801)
  -> schemas.py: DashboardRead, AnalyticsOverviewRead
  -> web/apps/staff/src/api/hmsClient.ts: toDashboard (:925), toAnalyticsOverview (:1004)
  -> OperationalWorkspace.tsx / AnalyticsWorkspace.tsx
  -> KPI cards, sparkline/trend SVG, fleet ring, tables, CSV export, escalation
```

Trend and Recent Activity bypass those endpoints: the Dashboard separately calls
`GET /admin/audit-events?limit=100&sort=-sequence` (`OperationalWorkspace.tsx:116`).

## 2. Facts from the model that constrain the design

- `RetestSchedule.asset_id` is `unique=True` (`modules/scheduling/models.py`). There is at most
  one schedule row per asset, so "overdue schedules" and "assets with an overdue schedule" are
  numerically equal today. They must still be labelled for what they count, because the unique
  constraint also covers soft-deleted rows and could be relaxed later. Tests for "duplicate
  schedules" are therefore not constructible; the contract tests assert the 1:1 invariant instead.
- `RetestScheduleStatus` is `UPCOMING|DUE|OVERDUE|SUSPENDED`. There is no COMPLETED state. A
  completed retest is represented by moving `due_at` forward. `status` is only written by the
  migration tool and on create/update; nothing recomputes it, so `due_at` is the source of truth
  for "overdue", not `status`.
- `Asset.lifecycle_status` is `DRAFT|IN_SERVICE|DUE|OVERDUE|CONDEMNED|RETIRED`, but no code path
  moves an asset from IN_SERVICE to DUE/OVERDUE after creation (only `tooling/migration.py` and
  seed set it). `IN_SERVICE` therefore does not mean "not overdue".
- `Asset.next_retest_due_at` exists as a second copy of the due date and can drift from
  `RetestSchedule.due_at`.
- `CertificateStatus` is `DRAFT|ISSUED|SUPERSEDED|REVOKED`. `valid_until` is nullable with no
  documented meaning for NULL. `Certificate.inspection_id` is unique; `asset_id` is not, so one
  asset can have several certificates.
- `/admin/audit-events` requires `Permission.AUDIT_READ` via `_require_admin` (`admin.py:749`).

## 3. Findings

### P0

**P0-1. Overdue retests are hidden by the reporting period.**
`get_dashboard` :1639-1643 restricts `RetestSchedule.due_at` to `[start.date(), end.date()]`
before computing `overdue_schedules` (:1647), so the queue, the count, the pagination total and
the export all drop schedules that became overdue before the window. With the default "Last 1
month", a retest overdue for 3 months disappears. Analytics does the same at :1868-1872.
- Reproduce: schedule `due_at = today - 90d`, request `/dashboard` with the default 30-day window.
- Expected: appears in `overdue_retests`, `overdue_total` includes it.
- Actual: absent.
- Test: `test_dashboard_overdue_ignores_reporting_window` and the Analytics equivalent.

**P0-2. The escalation action does not match the queue it is launched from.**
`escalate_overdue_retests` (:2070) escalates every non-suspended schedule with `due_at < today`
for the principal's scope, regardless of asset lifecycle or reporting period. The confirm dialog
(`OperationalWorkspace.tsx:371`) states the count from the window-filtered `overdueTotal`.
Today the dialog under-reports what will be notified. After P0-1 is fixed the counts will agree
only if both use one shared definition (section 4). It also notifies for CONDEMNED/RETIRED/DRAFT
assets, which the Dashboard and Analytics treat inconsistently (see P1-2).
- Test: seed old-overdue, condemned-overdue and suspended schedules; assert dialog count equals
  `dispatched` on first send and 0 on second send the same day.

**P0-3. "Overdue" KPI is a schedule count shown as an asset count, in the wrong denominator.**
`overdue_assets=overdue_total` (:1708) is `COUNT(schedules)` while the field and KPI card say
assets. Equal today (unique constraint) but mislabelled in the contract.

### P1

**P1-1. "Total Assets" is "assets created in the period".** :1628-1637 filters
`Asset.created_at`. `total_assets`, `in_service_assets`, `total_customers` (:1665-1669) all
become activity counts under a snapshot label. Fleet total flips with the selector.

**P1-2. Fleet health partition is not mutually exclusive and uses inconsistent populations.**
Dashboard: `inServiceAssets` (lifecycle `IN_SERVICE`), `dueSoonAssets`, `overdueAssets` come from
independent queries; the ring (`FleetHealthPanel`) sums them as a partition
(`healthTotal = inService + dueSoon + overdue`, `OperationalWorkspace.tsx:171`). An asset that is
IN_SERVICE (always, per section 2) and overdue is counted in both, so the denominator exceeds
the fleet and "% healthy" is understated. Analytics computes a different partition
(`fleet_posture`, :1979) from `fleet_asset_ids` (excludes DRAFT/CONDEMNED/RETIRED), so the two
pages disagree for the same scope. Dashboard counts CONDEMNED/RETIRED/DRAFT assets in
`total_assets` and overdue; Analytics excludes them from posture but not from `overdue_assets`
(:1895 uses all schedules, not the fleet subset).

**P1-3. Certificate coverage is restricted by `issued_at` in the period.** :1877-1881. A valid
certificate issued last year is dropped; coverage and "expired" are wrong. Further:
- `valid_until is None` is treated as perpetual (:1905); no rule exists for that.
- `expiring_soon` and `expired` count certificate rows, not assets, and count ISSUED rows that
  are already superseded in effect by a newer certificate for the same asset.
- Coverage denominator is "IN_SERVICE assets created in the period", not the eligible fleet.
- `valid_until == reference_date` is counted as valid (`>=`); the contract below makes the
  inclusive end explicit.

**P1-4. Period semantics are mixed and mislabelled.** `_reporting_dates` (:357) maps a timestamp
interval to `[start.date(), end.date()]`, which includes the end's calendar day even when the
half-open timestamp interval ends at 00:00 (custom range: end is exclusive-next-midnight, so the
extra day is one day too many for date columns). Presets are rolling hours (`last_hour`, 30 and
90 day approximations) computed in the browser's clock; custom ranges are built as UTC midnight
(`reportingPeriod.ts:36`), so a user in UTC+10 selecting "5 Nov" gets 10:00 local on 5 Nov to
10:00 local on 6 Nov. `reference_date = min(today_utc, window_end_date)` (:1622) silently turns
the "current" snapshot into a historical one for past windows, while counts such as
`in_service_assets` remain current: a historical label on current state. Inspection filtering
uses a status-dependent timestamp (`_inspection_in_reporting_window`, :367), so one inspection
moves between periods as its status changes, and Dashboard filters `awaiting_review` by
`coalesce(submitted_at, created_at)` while Analytics uses the same rule in Python — equal today
only by accident.

**P1-5. Trends are built from the newest 100 audit events and visible only to admins.**
`listAuditEvents({limit:100})` (`OperationalWorkspace.tsx:116`) returns the most recent 100 rows
across all entities, then the client filters to the window and buckets into 8 equal slices. In a
busy system 100 events can span minutes, so the chart looks complete but is truncated. The
endpoint requires AUDIT_READ, so for other roles the call fails, the `catch` sets `[]`, and the
chart says "No recorded operational activity", which is false. Event classification uses
substring matching on `action + entity` (`activitySeriesFor`, :558): "schedule" matches
`inspection_appointment...` and `booking` actions as retests; `retest_schedule.escalated`
matches "escalat" first (correct) but `retest_schedule.updated` is counted as a retest
regardless of what changed. The KPI sparklines reuse these series, and the "Healthy Fleet" card
shows the assets series, which is unrelated to health. The vocabulary (section 2 of the code
grep) has no `asset.created` for imports (`tooling` writes none), so "assets added" can
undercount. The "Escalations" KPI counts escalated rows on the visible page only
(`dashboard.overdueRetests.filter(...)`, :186), not all escalated schedules.

**P1-6. Analytics loads whole tables into Python.** :1873-1883 loads every inspection and
certificate in scope, then loops. Unbounded memory and N+1 via relationship loading
(`customer_risk` reads `schedule.asset.customer`). Aggregation belongs in SQL.

**P1-7. Frontend reliability.**
- Dashboard: two independent requests share one `active` flag, but a failed refresh after a
  successful first load replaces the page with an error (:159) instead of showing last good
  data plus an error; a successful `getDashboard` with an out-of-range page triggers another
  request (:100) while `dashboardLoading` is cleared only on the later load, so a stale frame
  can show a mismatched page.
- Audit events request has no error state; a failure is indistinguishable from "no activity".
- Escalation: the guard is the `isEscalating` state flag, not a ref, so two clicks dispatched
  before React re-renders could both pass it. Unverified: `ConfirmDialog`/`ActionButton` may
  already disable on `pending`; Phase C will test it before changing anything. The server
  dedupe key `RETEST_OVERDUE:manual:<id>:<date>` limits impact to a duplicate request.
- CSV export covers only the loaded page and is named `overdue-retests.csv` with no scope or
  date; the notice says "current page" but the filename does not.
- Analytics has no stale-response guard beyond `active`, no retry once data exists, and keeps
  showing the previous period's data while loading with no indication.
- Hard-coded `syncRows` in `OperationalWorkspace.tsx:55` is fake data in a production module
  (outside Dashboard scope; flagged only).

### P2

- KPI helper text "Requires immediate action" is not defined by any rule.
- `Fleet Health` ring is a three-segment donut; per the brief a stacked bar communicates a
  partition better.
- Sparklines have no axis, value, or accessible text (`aria-hidden`), so they carry no
  information for assistive tech.
- Trend chart: no y-axis, no tooltips, no keyboard inspection, 8 fixed buckets with labels that
  are bucket ends; line style distinguishes series only by colour.
- Greeting uses browser local time while data uses UTC.

## 4. Metric contracts (proposed)

Definitions are evaluated against one `as_of` instant captured once per request and returned.

Common: scope = `_apply_asset_scope`/`_apply_customer_scope` (unchanged). Excludes soft-deleted
assets, customers, schedules, certificates, inspections.

| Metric | Definition | Depends on period? |
|---|---|---|
| Fleet (denominator) | Visible assets with `lifecycle_status NOT IN (DRAFT, CONDEMNED, RETIRED)` | No |
| Overdue retests | Fleet assets whose schedule has `status != SUSPENDED` and `due_at < as_of_date` | No |
| Due soon | Same population, `as_of_date <= due_at <= as_of_date + 7` | No |
| On track | Fleet minus overdue minus due soon (assets with no schedule are On track only if not otherwise classified; counted and exposed separately as `unscheduled`) | No |
| Suspended | Fleet assets with a SUSPENDED schedule (own bucket, excluded from overdue) | No |
| Fleet health % | `on_track / fleet`, where overdue, due-soon, on-track, suspended, unscheduled partition the fleet | No |
| Awaiting review | Inspections with `status = SUBMITTED` (current queue) | No |
| Certificate coverage | Fleet assets with at least one `ISSUED` certificate with `valid_until >= as_of_date`; a NULL `valid_until` is **not covered** pending a product decision (see section 7) | No |
| Assets added | `Asset.created_at` in `[start, end)` | Yes |
| Inspections performed | by status-specific timestamp in `[start, end)`; each status is its own series | Yes |
| Certificates issued | `issued_at` in `[start, end)` | Yes |
| Retests escalated | audit `retest_schedule.escalated` in `[start, end)` or `escalated_at` in `[start, end)` | Yes |

Intervals: event timestamps use `start <= t < end` in UTC. Date-only deadlines are never filtered
by the reporting period. The period label will say so ("Period applies to activity, not current
status").

Timezone contract: the API receives UTC instants plus an IANA zone name (default
`Australia/Sydney`, to be confirmed). Calendar-date conversions and bucket boundaries use that
zone; storage stays UTC. The response echoes the zone.

Shared implementation: one module (`modules/reporting/`) holding the population predicates and
counts used by both endpoints, so Dashboard and Analytics cannot drift.

## 5. API contract proposal

Additive; existing fields kept and deprecated where semantics change.

- `GET /dashboard`: add `as_of`, `fleet_total`, `overdue_schedules`, `overdue_assets`
  (distinct), `escalated_schedules`, `fleet_status{on_track,due_soon,overdue,suspended,unscheduled}`.
  Reporting params stop affecting overdue/due-soon/fleet values.
- `GET /analytics/overview`: same snapshot block plus `certificate_coverage` with separate
  `eligible_assets`, `covered_assets`, `certificates_expiring_assets`, `expired_assets`,
  `certificates_issued_in_period`.
- New `GET /reporting/activity?start_at&end_at&tz&bucket=auto`: returns
  `{timezone, bucket, buckets:[{start,end,assets_added,inspections,retests,escalations}]}`
  computed by SQL `date_trunc`/`generate_series`, bounded to a maximum bucket count, scoped by
  principal, available to every role that can read the Dashboard (not AUDIT_READ). Series come
  from the domain tables (created_at, submitted_at, `escalated_at`, schedule changes only where a
  dedicated timestamp exists), not from substring matching on audit actions.
- New `GET /retest-schedules` filter for the queue export (`overdue=true`, same predicate) so
  Export can cover all rows, not one page.

## 6. Proposed test coverage (before each fix)

Backend: old overdue vs window (P0-1); suspended excluded; condemned/retired excluded and
escalation count equal to dialog count (P0-2); 1:1 schedule invariant; asset created before
period still counted in fleet (P1-1); partition sums to fleet with overlapping statuses (P1-2);
old valid certificate counted, multiple certificates per asset count once, `valid_until` equal to
as-of date, NULL `valid_until` (P1-3); boundary timestamps at `start`, `end - 1us`, `end`; DST
transition and month/year end in the chosen zone (P1-4); activity buckets reconcile to row
counts for 5,000 seeded events, empty period, other-customer data excluded, non-admin allowed
(P1-5); statement count bounded for analytics (P1-6); Dashboard vs Analytics return equal snapshot
numbers.

Frontend: KPI labels/definitions; stale-response ordering; failed refresh keeps last data with
error; retry; escalation double click sends once; export names and row scope; chart accessible
table and keyboard; reduced motion.

E2E: deterministic fixture where the overdue retest stays visible under Last 1 week; old
certificate counts toward coverage; the date filter includes no extra day; chart totals match
the underlying lists; drill-down opens the record. Responsive screenshots at 390, 768, 1024,
1440 with an overflow assertion.

## 7. Open decisions needed before Phase B

1. Reporting timezone: fixed `Australia/Sydney`, per-customer, or per-user? (Affects every date
   boundary.) Recommendation: one organisation zone, configurable, default Australia/Sydney.
2. Certificates with NULL `valid_until`: not covered (recommended, safer for compliance) or
   perpetual?
3. Assets with no retest schedule: shown as `unscheduled` (recommended) or treated as on track?
4. Is `lifecycle_status` DUE/OVERDUE intended to be maintained, or retired in favour of schedule
   dates? The contract above uses schedule dates only.
5. Should HMS_ADMIN-and-below roles see activity counts that include other users' actions inside
   their customer scope? (Proposed: yes, scope by asset/customer, not by actor.)

## 8. Implementation impact

Backend: new `modules/reporting` (queries), changes to `records.py` dashboard/analytics handlers,
additive schemas, one new route, possibly indexes after `EXPLAIN` on `certificates(asset_id,
status, valid_until)` and `retest_schedules(due_at)` (the latter exists). No migration expected
unless EXPLAIN shows a need. Consumers: only `hmsClient.ts` and the two workspaces plus
`test_core_records_api.py`, `DashboardAssetIdentity.test.tsx`, `AppRouting.test.tsx`,
`hmsClient.test.ts`. Customer portal does not call these endpoints (to be confirmed in Phase B).
