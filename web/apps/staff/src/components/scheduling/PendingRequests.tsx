import type { InspectionBookingRecord } from "../../domain/types";
import type { Queue, QueueKind } from "../../hooks/useSchedulingWorkspace";
import { STATUS_META, toEntry, type ScheduleEntry } from "../../scheduling/scheduleModel";
import { formatDateTime } from "../../scheduling/zonedTime";

function age(from: string): string {
  const days = Math.floor((Date.now() - new Date(from).getTime()) / 86_400_000);
  if (days <= 0) return "Raised today";
  return days === 1 ? "Raised 1 day ago" : `Raised ${days} days ago`;
}

const COPY: Record<QueueKind, { title: string; empty: string; more: string; noun: string }> = {
  requests: {
    title: "New booking requests",
    empty: "No new booking requests.",
    more: "Load more booking requests",
    noun: "booking requests"
  },
  changes: {
    title: "Reschedule requests",
    empty: "No reschedule requests.",
    more: "Load more reschedule requests",
    noun: "reschedule requests"
  }
};

/**
 * The two queues are disjoint by business rule: a reschedule can only be raised on an
 * approved booking, and new requests are bookings still awaiting approval. So the sum
 * of the two server totals (the tab badge) counts each booking once.
 */
export function PendingRequests({
  changes,
  inspectorNames,
  onLoadMore,
  onRetry,
  onSelect,
  requests
}: {
  changes: Queue;
  inspectorNames: ReadonlyMap<string, string>;
  onLoadMore: (kind: QueueKind) => void;
  onRetry: (kind: QueueKind) => void;
  onSelect: (entry: ScheduleEntry) => void;
  requests: Queue;
}) {
  const firstLoad = [requests, changes].some((queue) => queue.isLoading && queue.items.length === 0);
  const nothing =
    requests.total === 0 && changes.total === 0 && !requests.error && !changes.error;

  if (firstLoad && requests.total === null && changes.total === null) {
    return (
      <div aria-busy="true" aria-label="Loading pending requests" className="schedule-skeleton" role="status">
        <i /><i /><i />
      </div>
    );
  }
  if (nothing) {
    return (
      <div className="schedule-empty" role="status">
        <strong>Nothing is waiting for a decision</strong>
        <span>New booking requests and reschedule requests appear here.</span>
      </div>
    );
  }

  return (
    <div className="schedule-pending">
      <Section
        inspectorNames={inspectorNames}
        kind="requests"
        onLoadMore={onLoadMore}
        onRetry={onRetry}
        onSelect={onSelect}
        queue={requests}
      />
      <Section
        inspectorNames={inspectorNames}
        kind="changes"
        onLoadMore={onLoadMore}
        onRetry={onRetry}
        onSelect={onSelect}
        queue={changes}
      />
    </div>
  );
}

function Section({
  inspectorNames,
  kind,
  onLoadMore,
  onRetry,
  onSelect,
  queue
}: {
  inspectorNames: ReadonlyMap<string, string>;
  kind: QueueKind;
  onLoadMore: (kind: QueueKind) => void;
  onRetry: (kind: QueueKind) => void;
  onSelect: (entry: ScheduleEntry) => void;
  queue: Queue;
}) {
  const copy = COPY[kind];
  const total = queue.total;
  const loaded = queue.items.length;
  const remaining = total === null ? 0 : Math.max(total - loaded, 0);
  return (
    <section aria-labelledby={`pending-${kind}-heading`}>
      <h3 id={`pending-${kind}-heading`}>
        {copy.title}
        {total === null ? "" : ` (${total})`}
      </h3>
      {total !== null && loaded > 0 ? (
        <p className="schedule-drawer__hint" role="status">
          Showing {loaded} of {total}
        </p>
      ) : null}
      {total === 0 && !queue.error ? <p className="schedule-drawer__hint">{copy.empty}</p> : null}
      <ul>
        {queue.items.map((booking) => (
          <Row booking={booking} inspectorNames={inspectorNames} key={booking.id} kind={kind} onSelect={onSelect} />
        ))}
      </ul>
      {queue.error ? (
        <div className="schedule-error" role="alert">
          <span>
            {loaded > 0
              ? `More ${copy.noun} could not be loaded; the ${loaded} already loaded are still shown. `
              : `The ${copy.noun} could not be loaded. `}
            {queue.error}
          </span>
          <button className="secondary-button" onClick={() => onRetry(kind)} type="button">
            Try again
          </button>
        </div>
      ) : null}
      {remaining > 0 && !queue.error ? (
        <button
          aria-label={`${copy.more} (${remaining} not yet shown)`}
          className="secondary-button"
          disabled={queue.isLoadingMore || queue.isLoading}
          onClick={() => onLoadMore(kind)}
          type="button"
        >
          {queue.isLoadingMore ? "Loading…" : `Load more (${remaining} more)`}
        </button>
      ) : null}
    </section>
  );
}

function Row({
  booking,
  inspectorNames,
  kind,
  onSelect
}: {
  booking: InspectionBookingRecord;
  inspectorNames: ReadonlyMap<string, string>;
  kind: QueueKind;
  onSelect: (entry: ScheduleEntry) => void;
}) {
  const entry = toEntry(booking, inspectorNames);
  const change = booking.changeRequests.find((item) =>
    ["PENDING_ADMIN_APPROVAL", "PENDING_CUSTOMER_CONFIRMATION"].includes(item.status)
  );
  return (
    <li>
      <div>
        <strong>{booking.customer.name}</strong>
        <span>{booking.location.name}</span>
      </div>
      <div>
        {kind === "requests" ? (
          <>
            <span>
              Requested for{" "}
              <time dateTime={booking.scheduledAt}>{formatDateTime(entry.start, entry.timeZone)}</time>
            </span>
            <span>
              {age(booking.createdAt)} · {booking.assets.length} {booking.assets.length === 1 ? "asset" : "assets"}
            </span>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
      <span className={`schedule-status status-${entry.status}`}>{STATUS_META[entry.status].label}</span>
      <button
        aria-label={
          kind === "requests"
            ? `Review request from ${booking.customer.name} at ${booking.location.name}`
            : `Review reschedule for ${booking.customer.name} at ${booking.location.name}`
        }
        onClick={() => onSelect(entry)}
        type="button"
      >
        Review
      </button>
    </li>
  );
}
