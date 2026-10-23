import type { InspectionBookingRecord } from "../../domain/types";
import { STATUS_META, toEntry, type ScheduleEntry } from "../../scheduling/scheduleModel";
import { formatDateTime } from "../../scheduling/zonedTime";

function age(from: string): string {
  const days = Math.floor((Date.now() - new Date(from).getTime()) / 86_400_000);
  if (days <= 0) return "Raised today";
  return days === 1 ? "Raised 1 day ago" : `Raised ${days} days ago`;
}

export function PendingRequests({
  changes,
  error,
  inspectorNames,
  isLoading,
  onRetry,
  onSelect,
  requests
}: {
  changes: InspectionBookingRecord[];
  error: string | null;
  inspectorNames: ReadonlyMap<string, string>;
  isLoading: boolean;
  onRetry: () => void;
  onSelect: (entry: ScheduleEntry) => void;
  requests: InspectionBookingRecord[];
}) {
  if (error) {
    return (
      <div className="schedule-empty" role="alert">
        <strong>Pending requests could not be loaded</strong>
        <span>{error}</span>
        <button className="secondary-button" onClick={onRetry} type="button">
          Try again
        </button>
      </div>
    );
  }
  if (isLoading && requests.length + changes.length === 0) {
    return (
      <div aria-busy="true" aria-label="Loading pending requests" className="schedule-skeleton" role="status">
        <i /><i /><i />
      </div>
    );
  }
  if (requests.length + changes.length === 0) {
    return (
      <div className="schedule-empty" role="status">
        <strong>Nothing is waiting for a decision</strong>
        <span>New booking requests and reschedule requests appear here.</span>
      </div>
    );
  }

  return (
    <div className="schedule-pending">
      <section aria-labelledby="pending-new-heading">
        <h3 id="pending-new-heading">New booking requests ({requests.length})</h3>
        {requests.length === 0 ? <p className="schedule-drawer__hint">No new booking requests.</p> : null}
        <ul>
          {requests.map((booking) => {
            const entry = toEntry(booking, inspectorNames);
            return (
              <li key={booking.id}>
                <div>
                  <strong>{booking.customer.name}</strong>
                  <span>{booking.location.name}</span>
                </div>
                <div>
                  <span>
                    Requested for{" "}
                    <time dateTime={booking.scheduledAt}>{formatDateTime(entry.start, entry.timeZone)}</time>
                  </span>
                  <span>{age(booking.createdAt)} · {booking.assets.length} {booking.assets.length === 1 ? "asset" : "assets"}</span>
                </div>
                <span className={`schedule-status status-${entry.status}`}>{STATUS_META[entry.status].label}</span>
                <button
                  aria-label={`Review request from ${booking.customer.name} at ${booking.location.name}`}
                  onClick={() => onSelect(entry)}
                  type="button"
                >
                  Review
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-labelledby="pending-change-heading">
        <h3 id="pending-change-heading">Reschedule requests ({changes.length})</h3>
        {changes.length === 0 ? <p className="schedule-drawer__hint">No reschedule requests.</p> : null}
        <ul>
          {changes.map((booking) => {
            const entry = toEntry(booking, inspectorNames);
            const change = booking.changeRequests.find((item) =>
              ["PENDING_ADMIN_APPROVAL", "PENDING_CUSTOMER_CONFIRMATION"].includes(item.status)
            );
            return (
              <li key={booking.id}>
                <div>
                  <strong>{booking.customer.name}</strong>
                  <span>{booking.location.name}</span>
                </div>
                <div>
                  <span>
                    Now <time dateTime={booking.scheduledAt}>{formatDateTime(entry.start, entry.timeZone)}</time>
                  </span>
                  {change ? (
                    <span>
                      Requested change to{" "}
                      <time dateTime={change.startsAt}>{formatDateTime(change.startsAt, entry.timeZone)}</time>
                      {" · "}
                      {change.status === "PENDING_ADMIN_APPROVAL" ? "needs admin approval" : "waiting for customer"}
                      {" · "}
                      {age(change.createdAt).toLowerCase()}
                    </span>
                  ) : null}
                </div>
                <span className={`schedule-status status-${entry.status}`}>{STATUS_META[entry.status].label}</span>
                <button
                  aria-label={`Review reschedule for ${booking.customer.name} at ${booking.location.name}`}
                  onClick={() => onSelect(entry)}
                  type="button"
                >
                  Review
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
