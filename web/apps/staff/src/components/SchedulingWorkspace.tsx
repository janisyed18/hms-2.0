import { CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { InspectionBookingForm } from "./InspectionBookingForm";
import { AppointmentDrawer } from "./scheduling/AppointmentDrawer";
import { DayView } from "./scheduling/DayView";
import { MonthView } from "./scheduling/MonthView";
import { PendingRequests } from "./scheduling/PendingRequests";
import { ScheduleList } from "./scheduling/ScheduleList";
import { WeekView } from "./scheduling/WeekView";
import {
  type SchedulingView,
  useSchedulingWorkspace
} from "../hooks/useSchedulingWorkspace";
import {
  STATUS_META,
  STATUS_ORDER,
  type CalendarMode,
  type ScheduleStatus
} from "../scheduling/scheduleModel";
import { addDays, formatYmd, startOfWeek, ymdOf } from "../scheduling/zonedTime";

const ZONES = [
  "Australia/Sydney",
  "Australia/Melbourne",
  "Australia/Brisbane",
  "Australia/Adelaide",
  "Australia/Perth",
  "Australia/Darwin",
  "Australia/Hobart",
  "UTC"
];

const VIEWS: Array<{ id: SchedulingView; label: string }> = [
  { id: "calendar", label: "Calendar" },
  { id: "list", label: "List" },
  { id: "pending", label: "Pending requests" }
];
const MODES: Array<{ id: CalendarMode; label: string }> = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" }
];

function periodLabel(mode: CalendarMode, anchor: string): string {
  if (mode === "day") {
    return formatYmd(anchor, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }
  if (mode === "week") {
    const first = startOfWeek(anchor);
    return `${formatYmd(first, { day: "numeric", month: "short" })} to ${formatYmd(addDays(first, 6), { day: "numeric", month: "short", year: "numeric" })}`;
  }
  return formatYmd(anchor, { month: "long", year: "numeric" });
}

export function SchedulingWorkspace({
  canApproveBookings,
  canBook,
  initialDate
}: {
  canApproveBookings: boolean;
  canBook: boolean;
  initialDate?: string;
}) {
  const workspace = useSchedulingWorkspace({ canApprove: canApproveBookings, initialDate });
  // "Now" only drives the current-time line and the Today highlight.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const today = ymdOf(now, workspace.timeZone);
  const inspectorNames = useMemo(
    () => new Map(workspace.inspectors.map((inspector) => [inspector.id, inspector.name])),
    [workspace.inspectors]
  );
  const zones = useMemo(
    () => (ZONES.includes(workspace.timeZone) ? ZONES : [workspace.timeZone, ...ZONES]),
    [workspace.timeZone]
  );
  const filtered = workspace.activeFilterCount > 0;
  const truncated = workspace.total > workspace.limit;

  return (
    <section aria-labelledby="scheduling-heading" className="scheduling-workspace">
      <header className="scheduling-header">
        <div>
          <span className="inspection-command-eyebrow">Dispatch</span>
          <h2 id="scheduling-heading">Scheduling</h2>
          <p>See who is going where, spot gaps and clashes, and act on requests.</p>
        </div>
        {canBook ? (
          <button className="primary-button" onClick={() => void workspace.openBooking()} type="button">
            <CalendarPlus aria-hidden="true" size={17} />
            Book inspection
          </button>
        ) : null}
      </header>

      <div aria-label="Scheduling views" className="scheduling-tabs" role="tablist">
        {VIEWS.map((item) => (
          <button
            aria-selected={workspace.view === item.id}
            className={workspace.view === item.id ? "is-active" : ""}
            key={item.id}
            onClick={() => workspace.setView(item.id)}
            role="tab"
            type="button"
          >
            {item.label}
            {item.id === "pending" && workspace.pendingTotal ? (
              <span className="scheduling-tabs__count" aria-label={`${workspace.pendingTotal} waiting`}>
                {workspace.pendingTotal}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {workspace.notice && !workspace.selected ? (
        <p
          className={`schedule-notice is-${workspace.notice.kind}`}
          role={workspace.notice.kind === "success" ? "status" : "alert"}
        >
          {workspace.notice.message}
        </p>
      ) : null}

      {workspace.view !== "pending" ? (
        <>
          <div className="scheduling-toolbar">
            {workspace.view === "calendar" ? (
              <div aria-label="Calendar range" className="scheduling-modes" role="group">
                {MODES.map((item) => (
                  <button
                    aria-pressed={workspace.mode === item.id}
                    className={workspace.mode === item.id ? "is-active" : ""}
                    key={item.id}
                    onClick={() => workspace.setMode(item.id)}
                    type="button"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="scheduling-nav" role="group" aria-label="Date navigation">
              <button aria-label={`Previous ${workspace.mode}`} onClick={() => workspace.shift(-1)} type="button">
                <ChevronLeft aria-hidden="true" size={18} />
              </button>
              <button onClick={workspace.goToToday} type="button">
                Today
              </button>
              <button aria-label={`Next ${workspace.mode}`} onClick={() => workspace.shift(1)} type="button">
                <ChevronRight aria-hidden="true" size={18} />
              </button>
              <label className="scheduling-date">
                <span className="sr-only">Jump to date</span>
                <input
                  aria-label="Jump to date"
                  onChange={(event) => workspace.jumpTo(event.target.value)}
                  type="date"
                  value={workspace.anchor}
                />
              </label>
            </div>
            <h3 aria-live="polite" className="scheduling-period">
              <CalendarDays aria-hidden="true" size={18} />
              {periodLabel(workspace.mode, workspace.anchor)}
            </h3>
            <label className="scheduling-zone">
              <span>Calendar time zone</span>
              <select
                onChange={(event) => workspace.changeTimeZone(event.target.value)}
                value={workspace.timeZone}
              >
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div aria-label="Schedule filters" className="scheduling-filters" role="group">
            <label>
              <span>Inspector</span>
              <select
                onChange={(event) => workspace.updateFilters({ inspectorId: event.target.value })}
                value={workspace.filters.inspectorId}
              >
                <option value="">All inspectors</option>
                {workspace.inspectors.map((inspector) => (
                  <option key={inspector.id} value={inspector.id}>
                    {inspector.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Customer</span>
              <select
                onChange={(event) => workspace.updateFilters({ customerId: event.target.value })}
                value={workspace.filters.customerId}
              >
                <option value="">All customers</option>
                {workspace.customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Location</span>
              <select
                onChange={(event) => workspace.updateFilters({ locationId: event.target.value })}
                value={workspace.filters.locationId}
              >
                <option value="">All locations</option>
                {workspace.locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Status</span>
              <select
                onChange={(event) => workspace.updateFilters({ status: event.target.value as ScheduleStatus | "" })}
                value={workspace.filters.status}
              >
                <option value="">All statuses</option>
                {STATUS_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_META[status].label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Assignment</span>
              <select
                onChange={(event) =>
                  workspace.updateFilters({ assignment: event.target.value as "" | "assigned" | "unassigned" })
                }
                value={workspace.filters.assignment}
              >
                <option value="">Assigned and unassigned</option>
                <option value="assigned">Assigned only</option>
                <option value="unassigned">Unassigned only</option>
              </select>
            </label>
            <button
              className="secondary-button"
              disabled={!filtered}
              onClick={workspace.resetFilters}
              type="button"
            >
              Reset filters{filtered ? ` (${workspace.activeFilterCount})` : ""}
            </button>
          </div>

          <ul aria-label="Status legend" className="schedule-legend">
            {STATUS_ORDER.map((status) => (
              <li className={`status-${status}`} key={status} title={STATUS_META[status].hint}>
                {STATUS_META[status].label}
              </li>
            ))}
          </ul>

          <div aria-live="polite" className="schedule-status-line" role="status">
            {workspace.isLoading ? (
              <span>{workspace.hasLoaded ? "Updating the schedule…" : "Loading the schedule…"}</span>
            ) : null}
            {truncated ? (
              <span>
                Showing the first {workspace.limit} of {workspace.total} visits in this period. Narrow
                the filters or the date range to see the rest.
              </span>
            ) : null}
          </div>

          {workspace.rosterError ? (
            <div className="schedule-error" role="alert">
              <span>
                Not every inspector could be loaded, so some may be missing from the pickers.{" "}
                {workspace.rosterError}
              </span>
              <button className="secondary-button" onClick={workspace.retryRoster} type="button">
                <RefreshCw aria-hidden="true" size={15} />
                Try again
              </button>
            </div>
          ) : null}

          {workspace.error ? (
            <div className="schedule-error" role="alert">
              <span>
                {workspace.hasLoaded
                  ? "The schedule could not be refreshed, so the last loaded view is shown. "
                  : "The schedule could not be loaded. "}
                {workspace.error}
              </span>
              <button className="secondary-button" onClick={workspace.refresh} type="button">
                <RefreshCw aria-hidden="true" size={15} />
                Try again
              </button>
            </div>
          ) : null}

          <div
            aria-busy={workspace.isLoading}
            className={`scheduling-stage${workspace.isLoading ? " is-refreshing" : ""}`}
          >
            {!workspace.hasLoaded && workspace.isLoading ? (
              <div aria-label="Loading schedule" className="schedule-skeleton" role="status">
                <i /><i /><i /><i />
              </div>
            ) : workspace.view === "list" ? (
              <ScheduleList entries={workspace.entries} onSelect={(entry) => workspace.setSelectedId(entry.id)} />
            ) : workspace.mode === "day" ? (
              <DayView
                canBook={canBook}
                entries={workspace.entries}
                gridZone={workspace.timeZone}
                inspectors={workspace.inspectors}
                nowMarker={now}
                onBook={() => void workspace.openBooking(workspace.anchor)}
                onSelect={(entry) => workspace.setSelectedId(entry.id)}
                selectedId={workspace.selected?.id ?? null}
                ymd={workspace.anchor}
              />
            ) : workspace.mode === "week" ? (
              <WeekView
                canBook={canBook}
                entries={workspace.entries}
                gridZone={workspace.timeZone}
                nowMarker={now}
                onBook={() => void workspace.openBooking()}
                onOpenDay={workspace.openDay}
                onSelect={(entry) => workspace.setSelectedId(entry.id)}
                selectedId={workspace.selected?.id ?? null}
                ymd={workspace.anchor}
              />
            ) : (
              <MonthView
                entries={workspace.entries}
                gridZone={workspace.timeZone}
                onOpenDay={workspace.openDay}
                today={today}
                ymd={workspace.anchor}
              />
            )}
          </div>
        </>
      ) : (
        <PendingRequests
          changes={workspace.queues.changes}
          inspectorNames={inspectorNames}
          onLoadMore={(kind) => void workspace.loadMoreQueue(kind)}
          onRetry={(kind) => void workspace.retryQueue(kind)}
          onSelect={(entry) => workspace.setSelectedId(entry.id)}
          requests={workspace.queues.requests}
        />
      )}

      {/* The booking form is a modal of its own: the details drawer steps aside for it. */}
      {workspace.selected && !workspace.form.open ? (
        <AppointmentDrawer
          busy={workspace.busy}
          canApproveBookings={canApproveBookings}
          canBook={canBook}
          entry={workspace.selected}
          gridZone={workspace.timeZone}
          inspectors={workspace.inspectors}
          key={workspace.selected.id}
          notice={workspace.notice}
          onApprove={workspace.approveBooking}
          onApproveReschedule={workspace.approveReschedule}
          onCancel={workspace.cancelBooking}
          onClose={() => {
            workspace.setSelectedId(null);
            workspace.setNotice(null);
          }}
          onDecline={workspace.declineBooking}
          onReschedule={(booking) => void workspace.openReschedule(booking)}
        />
      ) : null}

      {canBook ? (
        <InspectionBookingForm
          assetOptions={workspace.assets}
          initialDate={workspace.form.initialDate}
          inspectors={workspace.inspectors.map((inspector) => ({
            id: inspector.id,
            displayName: inspector.name
          }))}
          onClose={workspace.closeForm}
          onReschedule={workspace.submitReschedule}
          onSubmit={workspace.submitBooking}
          open={workspace.form.open}
          requiresInspector={canApproveBookings}
          rescheduleBooking={workspace.form.reschedule}
        />
      ) : null}
    </section>
  );
}
