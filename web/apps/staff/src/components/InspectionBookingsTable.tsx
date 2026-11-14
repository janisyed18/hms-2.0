import { CalendarClock, ChevronDown, ClipboardCheck, MapPin, RefreshCw, UserRound } from "lucide-react";
import { useEffect, useState } from "react";

import type { InspectionBookingChangeRequest, InspectionBookingRecord, ScheduleInspector } from "../domain/types";
import { formatWithZone } from "../scheduling/zonedTime";
import { assetLabel } from "../utils/identity";
import { ActionButton } from "./interaction/ActionButton";

export interface InspectionBookingsTableProps {
  bookings: InspectionBookingRecord[];
  canBook: boolean;
  canApproveBookings: boolean;
  inspectors: ScheduleInspector[];
  loading: boolean;
  /** True when a filter is narrowing the list, so an empty table can say why. */
  filtered: boolean;
  /** The key of the action running (`approve:<id>`, `approve-change:<id>`, `confirm:<id>`), if any. */
  pendingAction: string | null;
  onAssign: (booking: InspectionBookingRecord) => void;
  onChangeInspector: (booking: InspectionBookingRecord) => void;
  onDecline: (booking: InspectionBookingRecord) => void;
  onRequestReschedule: (booking: InspectionBookingRecord) => void;
  onCancel: (booking: InspectionBookingRecord) => void;
  onApproveReschedule: (booking: InspectionBookingRecord, changeId: string) => void;
  onConfirmReschedule: (changeId: string) => void;
}

const OPEN_CHANGE = ["PENDING_ADMIN_APPROVAL", "PENDING_CUSTOMER_CONFIRMATION"];

/**
 * Who asked for a reschedule, named by the role stored against the request. Roles the
 * screen has no word for return null, so nothing is claimed about the origin.
 */
function requesterLabel(role: string | null): string | null {
  if (role === "CUSTOMER_USER") return "Customer";
  if (role === "HMS_ADMIN" || role === "SUPER_ADMIN") return "Admin";
  if (role === "INSPECTOR") return "Inspector";
  return null;
}

/**
 * A booking's own reference, short enough to read out and still a part of its id, so
 * searching for what is printed here finds the booking.
 */
export function bookingReference(id: string): string {
  return `HMS-${id.replaceAll("-", "").slice(-10).toUpperCase()}`;
}

/** Where the visit is, as a person would say it, falling back to the site's name. */
function placeLabel(location: InspectionBookingRecord["location"]): string {
  const parts = [location.city, location.state].filter(Boolean);
  return parts.length ? parts.join(", ") : location.name;
}

interface RowState {
  /** What the status column says, and the badge's tone. */
  label: string;
  tone: "pending" | "approved" | "rejected" | "neutral";
  caption: string;
  /** The open reschedule request, when one is waiting on somebody. */
  change: InspectionBookingChangeRequest | null;
  awaitingAdmin: boolean;
  awaitingCustomer: boolean;
  confirmed: boolean;
}

function rowState(booking: InspectionBookingRecord): RowState {
  const open = booking.changeRequests.filter((change) => OPEN_CHANGE.includes(change.status));
  const awaitingAdmin = open.some((change) => change.status === "PENDING_ADMIN_APPROVAL");
  const awaitingCustomer = open.some((change) => change.status === "PENDING_CUSTOMER_CONFIRMATION");
  const confirmed = booking.status === "APPROVED" && booking.appointment?.status === "CONFIRMED";
  if (open.length) {
    return {
      label: "Reschedule requested",
      tone: "pending",
      caption: awaitingAdmin ? "Pending approval" : "Awaiting customer confirmation",
      change: open[0],
      awaitingAdmin,
      awaitingCustomer,
      confirmed
    };
  }
  const base = { change: null, awaitingAdmin: false, awaitingCustomer: false, confirmed } as const;
  if (booking.status === "PENDING_APPROVAL") {
    return { label: "Requested", tone: "pending", caption: "New inspection request", ...base };
  }
  if (booking.status === "REJECTED") {
    return { label: "Rejected", tone: "rejected", caption: "Not approved", ...base };
  }
  if (booking.status === "CANCELLED") {
    return { label: "Cancelled", tone: "neutral", caption: "No longer scheduled", ...base };
  }
  return { label: "Approved", tone: "approved", caption: "Scheduled and confirmed", ...base };
}

/**
 * Inspection bookings as one table: what was asked for, when and where, who is going,
 * where it stands, and the actions that state allows. Every action is owned by the
 * workspace; this decides only which of them apply.
 */
export function InspectionBookingsTable({
  bookings,
  canBook,
  canApproveBookings,
  inspectors,
  loading,
  filtered,
  pendingAction,
  onAssign,
  onChangeInspector,
  onDecline,
  onRequestReschedule,
  onCancel,
  onApproveReschedule,
  onConfirmReschedule
}: InspectionBookingsTableProps) {
  const busy = pendingAction !== null;
  // The open menu is React's to remember. A <details> is the browser's, and every reload
  // of the list — an approval's refresh, the inspector roster arriving — reset it, so the
  // menu shut itself the moment something else finished.
  const [openFor, setOpenFor] = useState<string | null>(null);
  useEffect(() => {
    if (openFor === null) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event.type === "pointerdown" && (event.target as HTMLElement | null)?.closest(".booking-action-menu")) return;
      setOpenFor(null);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [openFor]);

  if (!loading && bookings.length === 0) {
    return (
      <p className="inspection-booking-empty">
        <CalendarClock aria-hidden="true" size={22} />
        {filtered ? (
          <span><strong>No bookings match these filters.</strong> Clear the filters to see every booking.</span>
        ) : (
          <span><strong>No inspection bookings are scheduled.</strong> Book a site visit to coordinate inspection work.</span>
        )}
      </p>
    );
  }

  return (
    <div className="inspection-booking-table-wrap">
      <table className="inspection-booking-table" aria-label="Inspection bookings">
        <thead>
          <tr>
            <th scope="col">Inspection details</th>
            <th scope="col">Schedule &amp; location</th>
            <th scope="col">Assigned inspector</th>
            <th scope="col">Status</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading && bookings.length === 0 ? (
            <tr><td colSpan={5} className="booking-table__loading">Loading bookings</td></tr>
          ) : null}
          {bookings.map((booking) => {
            const state = rowState(booking);
            const zone = booking.location.schedulingTimezone;
            const inspectorName =
              inspectors.find((inspector) => inspector.id === booking.inspectorUserId)?.displayName ??
              (booking.inspectorUserId ? "Assigned" : null);
            const requester = state.change ? requesterLabel(state.change.requestedByRole) : null;
            const decidable = booking.status !== "REJECTED" && booking.status !== "CANCELLED";
            const menuItems = [
              canBook && state.confirmed && !state.change
                ? { key: "reschedule", label: "Request reschedule", run: () => onRequestReschedule(booking) }
                : null,
              canBook && state.confirmed && !state.change
                ? { key: "cancel", label: "Cancel booking", run: () => onCancel(booking) }
                : null,
              canApproveBookings && booking.status === "PENDING_APPROVAL"
                ? { key: "decline", label: "Decline request", run: () => onDecline(booking) }
                : null,
              canApproveBookings && state.awaitingAdmin && state.change
                ? { key: "approve-change", label: "Approve reschedule", run: () => onApproveReschedule(booking, state.change!.id) }
                : null,
              canBook && !canApproveBookings && state.awaitingCustomer && state.change
                ? { key: "confirm-change", label: "Confirm reschedule", run: () => onConfirmReschedule(state.change!.id) }
                : null
            ].filter((item) => item !== null);

            return (
              <tr key={booking.id} className="booking-row">
                <td className="booking-row__cell"><div className="booking-row__details">
                  <span aria-hidden="true" className={`booking-row__icon tone-${state.tone}`}>
                    {booking.status === "PENDING_APPROVAL" ? <ClipboardCheck size={18} /> : <MapPin size={18} />}
                  </span>
                  <span className="booking-row__identity">
                    <strong>{booking.location.name}</strong>
                    <span>{booking.customer.name}</span>
                    <span className="booking-row__ref" title={booking.id}>REF: {bookingReference(booking.id)}</span>
                  </span>
                  </div>
                </td>
                <td className="booking-row__cell"><div className="booking-row__schedule">
                  <span className="booking-row__line">
                    <CalendarClock aria-hidden="true" size={15} />
                    <time dateTime={booking.scheduledAt}>{formatWithZone(booking.scheduledAt, zone)}</time>
                  </span>
                  <span className="booking-row__line">
                    <MapPin aria-hidden="true" size={15} />
                    <span>{placeLabel(booking.location)}</span>
                  </span>
                  <span className="booking-row__assets">{booking.assets.map(assetLabel).join(", ")}</span>
                  </div>
                </td>
                <td className="booking-row__cell"><div className="booking-row__inspector">
                  {canApproveBookings ? (
                    inspectorName ? (
                      <span className="assigned-inspector__name"><UserRound aria-hidden="true" size={16} />{inspectorName}</span>
                    ) : (
                      <span className="booking-row__unassigned"><UserRound aria-hidden="true" size={16} />Not assigned</span>
                    )
                  ) : (
                    <span className="booking-row__muted">—</span>
                  )}
                  </div>
                </td>
                <td className="booking-row__cell"><div className="booking-row__status">
                  <span className="booking-row__field-label">Status</span>
                  <span className={`booking-status booking-status--${state.tone}`}>{state.label}</span>
                  <small className="booking-row__caption">{state.caption}</small>
                  {requester ? <small className="booking-row__requested-by">Requested by: {requester}</small> : null}
                  </div>
                </td>
                <td className="booking-row__cell"><div className="booking-row__actions">
                  {canApproveBookings && booking.status === "PENDING_APPROVAL" ? (
                    <ActionButton
                      aria-label={`Assign inspector for ${booking.location.name}`}
                      disabled={busy}
                      onClick={() => onAssign(booking)}
                      variant="primary"
                    >
                      <UserRound aria-hidden="true" size={15} /> Assign inspector
                    </ActionButton>
                  ) : null}
                  {canApproveBookings && state.confirmed && booking.status === "APPROVED" ? (
                    <ActionButton
                      aria-label={`Change inspector for ${booking.location.name}`}
                      disabled={busy || state.change !== null}
                      title={state.change ? "Reassignment is paused while a reschedule is pending." : undefined}
                      onClick={() => onChangeInspector(booking)}
                      variant="secondary"
                    >
                      <RefreshCw aria-hidden="true" size={14} /> Change inspector
                    </ActionButton>
                  ) : null}
                  {decidable && menuItems.length ? (
                    <div className="booking-action-menu">
                      <button
                        aria-expanded={openFor === booking.id}
                        aria-haspopup="menu"
                        aria-label={`Actions for ${booking.location.name}`}
                        className="booking-action-menu__summary"
                        onClick={() => setOpenFor((current) => (current === booking.id ? null : booking.id))}
                        type="button"
                      >
                        Actions <ChevronDown aria-hidden="true" size={15} />
                      </button>
                      {openFor === booking.id ? (
                        <div className="booking-action-menu__items" role="menu">
                          {menuItems.map((item) => (
                            <ActionButton
                              disabled={busy}
                              key={item.key}
                              onClick={() => { setOpenFor(null); item.run(); }}
                              pending={pendingAction === `approve-change:${state.change?.id}` && item.key === "approve-change"}
                              pendingLabel="Approving…"
                              variant="ghost"
                            >
                              {item.label}
                            </ActionButton>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {!decidable ? <span className="booking-row__muted">No actions</span> : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
