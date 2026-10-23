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
import { visitTimes } from "./TimeGrid";

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

  // Focus moves into the drawer when it opens and returns to the block that opened it.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    heading.current?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);
  // A different booking starts with a clean slate.
  useEffect(() => {
    setInspectorId("");
    setConfirming(null);
  }, [booking.id]);

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
      aria-label="Inspector to assign"
      onChange={(event) => setInspectorId(event.target.value)}
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
      className="schedule-drawer"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
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
          <dd>{booking.assets.map((asset) => asset.assetNumber).join(", ") || "None"}</dd>
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
              <span>Inspector</span>
              {chooser}
            </label>
            <div className="row-actions">
              <button
                className="primary-button"
                disabled={busy || !inspectorId}
                onClick={() => void onApprove(booking.id, inspectorId)}
                type="button"
              >
                Assign &amp; approve
              </button>
              {confirming === "decline" ? (
                <button disabled={busy} onClick={() => void onDecline(booking.id).then(() => setConfirming(null))} type="button">
                  Confirm decline
                </button>
              ) : (
                <button disabled={busy} onClick={() => setConfirming("decline")} type="button">
                  Decline
                </button>
              )}
            </div>
          </>
        ) : null}

        {pendingAdmin.length > 0 && canApproveBookings
          ? pendingAdmin.map((change) => (
              <div className="schedule-drawer__approve" key={change.id}>
                <label>
                  <span>Inspector for the new time</span>
                  {chooser}
                </label>
                <button
                  className="primary-button"
                  disabled={busy || !inspectorId}
                  onClick={() => void onApproveReschedule(booking.id, change.id, inspectorId)}
                  type="button"
                >
                  Approve reschedule
                </button>
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
            <button disabled={busy} onClick={() => onReschedule(booking)} type="button">
              Request reschedule
            </button>
            {confirming === "cancel" ? (
              <button disabled={busy} onClick={() => void onCancel(booking.id).then(() => setConfirming(null))} type="button">
                Confirm cancel booking
              </button>
            ) : (
              <button disabled={busy} onClick={() => setConfirming("cancel")} type="button">
                Cancel booking
              </button>
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
