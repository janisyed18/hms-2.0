import { CalendarClock, ChevronDown, FileText, MapPin, RefreshCw, UserRound } from "lucide-react";
import { useState } from "react";

import type { InspectionBookingChangeRequest, InspectionBookingRecord, ScheduleInspector } from "../domain/types";
import { formatWithZone } from "../scheduling/zonedTime";
import { assetLabel } from "../utils/identity";
import { ActionButton } from "./interaction/ActionButton";

/** What a card needs from the workspace. Every action stays owned by `useInspectionsWorkspace`. */
export interface InspectionBookingCardProps {
  booking: InspectionBookingRecord;
  canBook: boolean;
  canApproveBookings: boolean;
  inspectors: ScheduleInspector[];
  /** The key of the action running (`approve:<id>`, `approve-change:<id>`, `confirm:<id>`), if any. */
  pendingAction: string | null;
  onApprove: (bookingId: string, inspectorId: string) => void;
  onDecline: (booking: InspectionBookingRecord) => void;
  onRequestReschedule: (booking: InspectionBookingRecord) => void;
  onCancel: (booking: InspectionBookingRecord) => void;
  onChangeInspector: (booking: InspectionBookingRecord) => void;
  onApproveReschedule: (changeId: string, inspectorId: string) => void;
  onConfirmReschedule: (changeId: string) => void;
}

const OPEN_CHANGE = ["PENDING_ADMIN_APPROVAL", "PENDING_CUSTOMER_CONFIRMATION"];

/** Booking status only. The appointment and the reschedule request each have their own status. */
function bookingStatusClass(status: InspectionBookingRecord["status"]) {
  if (status === "APPROVED") return "booking-status booking-status--approved";
  if (status === "PENDING_APPROVAL") return "booking-status booking-status--pending";
  if (status === "REJECTED") return "booking-status booking-status--rejected";
  return "booking-status booking-status--neutral";
}

function InspectorSelect({
  label,
  value,
  inspectors,
  onChange
}: {
  label: string;
  value: string;
  inspectors: ScheduleInspector[];
  onChange: (value: string) => void;
}) {
  return (
    <span className="booking-select">
      <select aria-label={label} onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">Assign inspector</option>
        {inspectors.map((inspector) => (
          <option key={inspector.id} value={inspector.id}>{inspector.displayName}</option>
        ))}
      </select>
      <ChevronDown aria-hidden="true" size={16} />
    </span>
  );
}

/**
 * One inspection booking: site and customer, what and when, the booking's status, and the actions its
 * state allows to this user. Reschedules and the assigned inspector sit in a second row, only when they apply.
 */
export function InspectionBookingCard({
  booking,
  canBook,
  canApproveBookings,
  inspectors,
  pendingAction,
  onApprove,
  onDecline,
  onRequestReschedule,
  onCancel,
  onChangeInspector,
  onApproveReschedule,
  onConfirmReschedule
}: InspectionBookingCardProps) {
  // Which inspector was picked for this booking or for one of its reschedule requests, keyed by id.
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<string | null>(null);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const zone = booking.location.schedulingTimezone;
  const when = (value: string) => formatWithZone(value, zone);
  const busy = pendingAction !== null;
  const confirmed = booking.status === "APPROVED" && booking.appointment?.status === "CONFIRMED";
  const openChange = booking.changeRequests.some((change) => OPEN_CHANGE.includes(change.status));
  const byStatus = (status: InspectionBookingChangeRequest["status"]) => booking.changeRequests.filter((change) => change.status === status);
  const awaitingAdmin = byStatus("PENDING_ADMIN_APPROVAL");
  const awaitingCustomer = byStatus("PENDING_CUSTOMER_CONFIRMATION");
  // Existing API states encode the two supported reschedule origins:
  // a customer request needs admin approval; an admin proposal needs customer confirmation.
  const rescheduleRequester = awaitingAdmin.length ? "Customer" : awaitingCustomer.length ? "Admin" : null;
  const inspectorName =
    inspectors.find((inspector) => inspector.id === booking.inspectorUserId)?.displayName ??
    (booking.inspectorUserId ? "Assigned" : "Not assigned");
  const assets = booking.assets.map(assetLabel).join(", ");
  const pendingAssignment = canApproveBookings && booking.status === "PENDING_APPROVAL";
  const displayedStatus = openChange ? "Reschedule requested" : booking.status === "PENDING_APPROVAL" ? "Requested" : booking.status === "APPROVED" ? "Approved" : booking.status === "REJECTED" ? "Rejected" : "Cancelled";
  const choose = (key: string, value: string) => setPicked((current) => ({ ...current, [key]: value }));

  function approve(key: string, run: (inspectorId: string) => void) {
    if (!picked[key]) {
      setMissing(key);
      return;
    }
    run(picked[key]);
  }

  const missingPrompt = (key: string) =>
    missing === key && !picked[key] ? <small className="field-error" role="alert">Choose an inspector to assign first.</small> : null;

  return (
    <article className="inspection-booking-card">
      <div className="booking-card__primary">
        <div className="booking-card__site">
          <span aria-hidden="true" className="booking-card__icon"><MapPin size={18} /></span>
          <span className="booking-card__text">
            <strong>{booking.location.name}</strong>
            <span>{booking.customer.name}</span>
          </span>
        </div>
        <div className="booking-card__details">
          <span className="booking-card__line"><FileText aria-hidden="true" size={15} /><span>{assets}</span></span>
          <span className="booking-card__line">
            <CalendarClock aria-hidden="true" size={15} />
            <time dateTime={booking.scheduledAt}>{when(booking.scheduledAt)}</time>
          </span>
        </div>
        <div className="booking-card__status">
          <span className="booking-card__status-label">Status</span>
          <span className={bookingStatusClass(openChange ? "PENDING_APPROVAL" : booking.status)}>{displayedStatus}</span>
          {rescheduleRequester ? <small className="booking-card__status-origin">Requested by: {rescheduleRequester}</small> : null}
        </div>
        <div className="booking-card__actions">
          {pendingAssignment ? (
            <div className="booking-assignment-action">
              <ActionButton disabled={busy} onClick={() => setAssignmentOpen((open) => !open)} variant="primary">
                Assign inspector
              </ActionButton>
              {assignmentOpen ? (
                <div className="booking-assignment-choices">
                  <InspectorSelect
                    inspectors={inspectors}
                    label={`Assign inspector for ${booking.location.name}`}
                    onChange={(value) => choose(booking.id, value)}
                    value={picked[booking.id] ?? ""}
                  />
                  <ActionButton
                    disabled={busy}
                    onClick={() => approve(booking.id, (inspectorId) => onApprove(booking.id, inspectorId))}
                    pending={pendingAction === `approve:${booking.id}`}
                    pendingLabel="Approving…"
                    variant="primary"
                  >
                    Confirm assignment & approve
                  </ActionButton>
                  {missingPrompt(booking.id)}
                </div>
              ) : null}
            </div>
          ) : null}
          {canApproveBookings && booking.status === "PENDING_APPROVAL" ? (
            <ActionButton disabled={busy} onClick={() => onDecline(booking)} variant="ghost">Reject request</ActionButton>
          ) : null}
          {canApproveBookings && confirmed && !openChange ? (
            <ActionButton
              aria-label={`Change inspector for ${booking.location.name}`}
              disabled={busy}
              onClick={() => onChangeInspector(booking)}
              variant="secondary"
            >
              <RefreshCw aria-hidden="true" size={14} /> Change inspector
            </ActionButton>
          ) : null}
          {canBook && (booking.status === "PENDING_APPROVAL" || confirmed) ? (
            <details className="booking-action-menu">
              <summary aria-label={`Actions for ${booking.location.name}`}>Actions <ChevronDown aria-hidden="true" size={14}/></summary>
              <div className="booking-action-menu__items">
                {confirmed && !openChange ? (
                  <ActionButton disabled={busy} onClick={() => onRequestReschedule(booking)} variant="secondary">Request reschedule</ActionButton>
                ) : null}
                <ActionButton disabled={busy} onClick={() => onCancel(booking)} variant="ghost">Cancel booking</ActionButton>
              </div>
            </details>
          ) : null}
        </div>
      </div>

      {canApproveBookings && confirmed ? (
        <div className="booking-card__row assigned-inspector">
          <UserRound aria-hidden="true" size={16} />
          <span>Assigned inspector:</span>
          <strong className="assigned-inspector__name">{inspectorName}</strong>
          {openChange ? (
            <small className="field-hint">Cannot change inspector while a reschedule is pending.</small>
          ) : null}
        </div>
      ) : null}

      {canApproveBookings ? awaitingAdmin.map((change) => (
        <div className="booking-card__row booking-card__row--reschedule" key={change.id}>
          <CalendarClock aria-hidden="true" size={16} />
          <span className="booking-card__row-text">
            <strong>Reschedule request:</strong>
            <time dateTime={change.startsAt}>{when(change.startsAt)}</time>
          </span>
          <span className="booking-card__row-actions">
            <InspectorSelect
              inspectors={inspectors}
              label={`Assign inspector for reschedule at ${booking.location.name}`}
              onChange={(value) => choose(change.id, value)}
              value={picked[change.id] ?? ""}
            />
            <ActionButton
              disabled={busy}
              onClick={() => approve(change.id, (inspectorId) => onApproveReschedule(change.id, inspectorId))}
              pending={pendingAction === `approve-change:${change.id}`}
              pendingLabel="Approving…"
              variant="primary"
            >
              Approve reschedule
            </ActionButton>
          </span>
          {missingPrompt(change.id)}
        </div>
      )) : null}

      {canApproveBookings ? awaitingCustomer.map((change) => (
        <div className="booking-card__row booking-card__row--reschedule" key={change.id}>
          <CalendarClock aria-hidden="true" size={16} />
          <span className="booking-card__row-text">
            <strong>Reschedule request:</strong>
            <time dateTime={change.startsAt}>{when(change.startsAt)}</time>
          </span>
          <span className="booking-status booking-status--pending">Awaiting customer confirmation</span>
        </div>
      )) : null}

      {canBook && !canApproveBookings ? awaitingAdmin.map((change) => (
        <div className="booking-card__row booking-card__row--reschedule" key={change.id}>
          <CalendarClock aria-hidden="true" size={16} />
          <span className="booking-card__row-text">
            <strong>Reschedule request:</strong>
            <time dateTime={change.startsAt}>{when(change.startsAt)}</time>
          </span>
          <span className="booking-status booking-status--pending">Awaiting admin approval</span>
        </div>
      )) : null}

      {canBook && !canApproveBookings ? awaitingCustomer.map((change) => (
        <div className="booking-card__row booking-card__row--reschedule" key={change.id}>
          <CalendarClock aria-hidden="true" size={16} />
          <span className="booking-card__row-text">
            <strong>Reschedule request:</strong>
            <time dateTime={change.startsAt}>{when(change.startsAt)}</time>
          </span>
          <ActionButton
            disabled={busy}
            onClick={() => onConfirmReschedule(change.id)}
            pending={pendingAction === `confirm:${change.id}`}
            pendingLabel="Confirming…"
            variant="primary"
          >
            Confirm reschedule
          </ActionButton>
        </div>
      )) : null}
    </article>
  );
}
