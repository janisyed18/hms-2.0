import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { InspectionBookingRecord } from "../../domain/types";
import {
  STATUS_META,
  durationMinutes,
  formatDuration,
  type InspectorOption,
  type ScheduleEntry
} from "../../scheduling/scheduleModel";
import { formatDateTime, zoneLabel } from "../../scheduling/zonedTime";
import type { ActionNotice } from "../../hooks/useSchedulingWorkspace";
import { ActionButton } from "../interaction/ActionButton";
import { RequiredMark } from "../interaction/FormPrimitives";
import { visitTimes } from "./TimeGrid";
import { assetLabel } from "../../utils/identity";

const CHANGE_LABEL: Record<string, string> = {
  PENDING_ADMIN_APPROVAL: "Waiting for admin approval",
  PENDING_CUSTOMER_CONFIRMATION: "Waiting for customer confirmation",
  APPLIED: "Applied",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled"
};

function age(from: string): string {
  const days = Math.floor((Date.now() - new Date(from).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

export function AppointmentDrawer({
  busy,
  busyKey,
  canApproveBookings,
  canBook,
  entry,
  gridZone,
  inspectors,
  notice,
  onApprove,
  onApproveReschedule,
  onCancel,
  onClose,
  onDecline,
  onReschedule
}: {
  busy: boolean;
  /** Which action is in flight, so its button can say what it is doing. */
  busyKey?: string | null;
  canApproveBookings: boolean;
  canBook: boolean;
  entry: ScheduleEntry;
  gridZone: string;
  inspectors: InspectorOption[];
  notice: ActionNotice | null;
  onApprove: (bookingId: string, inspectorId: string) => Promise<boolean>;
  onApproveReschedule: (bookingId: string, changeId: string, inspectorId: string) => Promise<boolean>;
  onCancel: (bookingId: string) => Promise<boolean>;
  onClose: () => void;
  onDecline: (bookingId: string) => Promise<boolean>;
  onReschedule: (booking: InspectionBookingRecord) => void;
}) {
  const booking = entry.booking;
  const heading = useRef<HTMLHeadingElement>(null);
  const [inspectorId, setInspectorId] = useState("");
  const [confirming, setConfirming] = useState<"decline" | "cancel" | null>(null);
  const [inspectorError, setInspectorError] = useState<string | null>(null);
  const chooserRef = useRef<HTMLSelectElement>(null);

  // Below this width the drawer covers the whole screen, so it behaves as a modal dialog.
  const [fullScreen] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 800px)").matches
  );
  const drawer = useRef<HTMLElement>(null);
  // Focus moves into the drawer when it opens and returns to the block that opened it. When the
  // opener is gone (an approved request leaves the pending list) it lands on the open view's tab.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    heading.current?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
      else document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    };
  }, []);
  // An action can remove the very button that was focused (an approved request no longer offers
  // "Assign & approve"). Focus would then fall to the page, out of the drawer, where Escape and
  // Tab no longer reach it: bring it back to the heading, which also announces the new state.
  useEffect(() => {
    if (document.activeElement === document.body) heading.current?.focus();
  }, [entry.status, notice]);
  // A different booking starts with a clean slate.
  useEffect(() => {
    setInspectorId("");
    setConfirming(null);
    setInspectorError(null);
  }, [booking.id]);

  /** Assigning needs an inspector: say so next to the field instead of leaving a dead button. */
  function needInspector(run: () => void) {
    if (!inspectorId) {
      setInspectorError("Choose an inspector to assign.");
      chooserRef.current?.focus();
      return;
    }
    run();
  }

  const zone = entry.timeZone;
  const appointment = booking.appointment;
  const pendingAdmin = booking.changeRequests.filter((change) => change.status === "PENDING_ADMIN_APPROVAL");
  const awaitingCustomer = booking.changeRequests.some((change) => change.status === "PENDING_CUSTOMER_CONFIRMATION");
  const isPending = booking.status === "PENDING_APPROVAL";
  const isConfirmed = booking.status === "APPROVED" && appointment?.status === "CONFIRMED";
  const hasOpenChange = pendingAdmin.length > 0 || awaitingCustomer;
  const noActions =
    !(isPending && canApproveBookings) &&
    !(isConfirmed && canBook && !hasOpenChange) &&
    !(pendingAdmin.length > 0 && canApproveBookings);

  const chooser = (
    <select
      aria-describedby={inspectorError ? "schedule-inspector-error" : undefined}
      aria-invalid={inspectorError ? true : undefined}
      aria-label="Inspector to assign"
      aria-required="true"
      onChange={(event) => { setInspectorId(event.target.value); setInspectorError(null); }}
      ref={chooserRef}
      required
      value={inspectorId}
    >
      <option value="">Choose an inspector</option>
      {inspectors.map((inspector) => (
        <option key={inspector.id} value={inspector.id}>
          {inspector.name}
        </option>
      ))}
    </select>
  );

  return (
    <aside
      aria-labelledby="schedule-drawer-title"
      aria-modal={fullScreen ? true : undefined}
      className="schedule-drawer"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
        if (event.key !== "Tab" || !fullScreen || !drawer.current) return;
        // Tab stays inside a full-screen drawer: nothing behind it can be seen or used.
        const focusable = Array.from(
          drawer.current.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled)")
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        // The heading takes focus on open and is not itself a tab stop, so it counts as "before first".
        const atStart = document.activeElement === first || document.activeElement === heading.current;
        if (event.shiftKey && atStart) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      ref={drawer}
      role="dialog"
    >
      <header>
        <div>
          <p className="schedule-drawer__eyebrow">{STATUS_META[entry.status].label}</p>
          <h3 id="schedule-drawer-title" ref={heading} tabIndex={-1}>
            {entry.customerName} · {entry.locationName}
          </h3>
        </div>
        <button aria-label="Close appointment details" onClick={onClose} type="button">
          <X aria-hidden="true" size={18} />
        </button>
      </header>

      {notice ? (
        <p className={`schedule-notice is-${notice.kind}`} role={notice.kind === "success" ? "status" : "alert"}>
          {notice.message}
        </p>
      ) : null}

      <dl className="schedule-drawer__facts">
        <div>
          <dt>When</dt>
          <dd>
            <time dateTime={booking.scheduledAt}>{formatDateTime(entry.start, zone)}</time>
            <span>
              {visitTimes(entry, zone)} · {formatDuration(durationMinutes(entry))}
            </span>
          </dd>
        </div>
        <div>
          <dt>Time zone</dt>
          <dd>
            {zone} ({zoneLabel(entry.start, zone)}
            {appointment ? `, UTC${appointment.utcOffsetStart}` : ""})
            {zone !== gridZone ? <span>The calendar is showing {gridZone}.</span> : null}
          </dd>
        </div>
        <div>
          <dt>Inspector</dt>
          <dd>{entry.inspectorName}</dd>
        </div>
        <div>
          <dt>Booking</dt>
          <dd>
            {booking.status.replace("_", " ").toLowerCase()}
            {appointment
              ? ` · appointment ${appointment.status.toLowerCase().replace("_", " ")}, revision ${appointment.revisionNumber}`
              : " · no appointment yet"}
          </dd>
        </div>
        <div>
          <dt>Assets ({booking.assets.length})</dt>
          <dd>{booking.assets.map(assetLabel).join(", ") || "None"}</dd>
        </div>
        {booking.additionalInformation ? (
          <div>
            <dt>Notes</dt>
            <dd>{booking.additionalInformation}</dd>
          </div>
        ) : null}
        {booking.rejectionReason ? (
          <div>
            <dt>Declined because</dt>
            <dd>{booking.rejectionReason}</dd>
          </div>
        ) : null}
      </dl>

      {booking.changeRequests.length > 0 ? (
        <section aria-label="Reschedule requests" className="schedule-drawer__changes">
          <h4>Reschedule requests</h4>
          <ul>
            {booking.changeRequests.map((change) => (
              <li key={change.id}>
                <strong>{CHANGE_LABEL[change.status] ?? change.status}</strong>
                <span>
                  Requested time: <time dateTime={change.startsAt}>{formatDateTime(change.startsAt, zone)}</time>
                  {change.emergency ? " (emergency)" : ""}
                </span>
                <span>Raised {age(change.createdAt)}{change.reason ? ` · ${change.reason}` : ""}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Actions" className="schedule-drawer__actions">
        {isPending && canApproveBookings ? (
          <>
            <label>
              <span>Inspector<RequiredMark /></span>
              {chooser}
              {inspectorError ? <small className="field-error" id="schedule-inspector-error">{inspectorError}</small> : null}
            </label>
            <div className="row-actions">
              <ActionButton
                disabled={busy && busyKey !== "approve"}
                onClick={() => needInspector(() => void onApprove(booking.id, inspectorId))}
                pending={busy && busyKey === "approve"}
                pendingLabel="Approving…"
                variant="primary"
              >
                Assign &amp; approve
              </ActionButton>
              {confirming === "decline" ? (
                <>
                  <ActionButton disabled={busy && busyKey !== "decline"} onClick={() => void onDecline(booking.id).then(() => setConfirming(null))} pending={busy && busyKey === "decline"} pendingLabel="Declining…" variant="danger">
                    Confirm decline
                  </ActionButton>
                  <ActionButton disabled={busy} onClick={() => setConfirming(null)} variant="ghost">
                    Keep request
                  </ActionButton>
                </>
              ) : (
                <ActionButton disabled={busy} onClick={() => setConfirming("decline")} variant="ghost">
                  Decline
                </ActionButton>
              )}
            </div>
          </>
        ) : null}

        {pendingAdmin.length > 0 && canApproveBookings
          ? pendingAdmin.map((change) => (
              <div className="schedule-drawer__approve" key={change.id}>
                <label>
                  <span>Inspector for the new time<RequiredMark /></span>
                  {chooser}
                  {inspectorError ? <small className="field-error" id="schedule-inspector-error">{inspectorError}</small> : null}
                </label>
                <ActionButton
                  disabled={busy && busyKey !== "approve-reschedule"}
                  onClick={() => needInspector(() => void onApproveReschedule(booking.id, change.id, inspectorId))}
                  pending={busy && busyKey === "approve-reschedule"}
                  pendingLabel="Approving…"
                  variant="primary"
                >
                  Approve reschedule
                </ActionButton>
              </div>
            ))
          : null}

        {awaitingCustomer ? (
          <p className="schedule-drawer__hint">
            A new time has been proposed and is waiting for the customer to confirm it.
          </p>
        ) : null}

        {isConfirmed && canBook && !hasOpenChange ? (
          <div className="row-actions">
            <ActionButton disabled={busy} onClick={() => onReschedule(booking)} variant="secondary">
              Request reschedule
            </ActionButton>
            {confirming === "cancel" ? (
              <>
                <ActionButton disabled={busy && busyKey !== "cancel"} onClick={() => void onCancel(booking.id).then(() => setConfirming(null))} pending={busy && busyKey === "cancel"} pendingLabel="Cancelling…" variant="danger">
                  Confirm cancel booking
                </ActionButton>
                <ActionButton disabled={busy} onClick={() => setConfirming(null)} variant="ghost">
                  Keep booking
                </ActionButton>
              </>
            ) : (
              <ActionButton disabled={busy} onClick={() => setConfirming("cancel")} variant="ghost">
                Cancel booking
              </ActionButton>
            )}
          </div>
        ) : null}
        {isConfirmed && canApproveBookings && !hasOpenChange ? (
          <p className="schedule-drawer__hint">
            To change the inspector, request a reschedule and choose another inspector: the
            new time is checked for availability first.
          </p>
        ) : null}
        {noActions && !awaitingCustomer ? (
          <p className="schedule-drawer__hint">No further actions are available for this booking.</p>
        ) : null}
      </section>
    </aside>
  );
}
