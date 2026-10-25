import { useEffect, useRef, useState } from "react";

import { HmsApiError, createHmsClient } from "../api/hmsClient";
import type {
  AssetRecord,
  CustomerRecord,
  InspectionAvailabilitySlot,
  InspectionBookingChangeRequest,
  InspectionBookingRecord
} from "../domain/types";

/** The site's own time zone, never the browser's: customers choose a time at the site. */
function siteZone(zone: string | null | undefined): string {
  return zone || "UTC";
}

function zoneName(instant: Date, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-AU", { timeZone, timeZoneName: "short" })
    .formatToParts(instant)
    .find((item) => item.type === "timeZoneName");
  return part?.value ?? timeZone;
}

/** "Australia/Sydney (AEDT)"; just the zone when its short name adds nothing (UTC). */
function zoneWithName(instant: Date, timeZone: string): string {
  const short = zoneName(instant, timeZone);
  return short === timeZone ? timeZone : `${timeZone} (${short})`;
}

function clock(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit", timeZone }).format(instant);
}

function longDay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone
  }).format(instant);
}

/** "8:00 am to 9:00 am"; when a clock change falls inside the slot, each end names its zone. */
function slotRange(slot: { startsAt: string; endsAt: string }, timeZone: string): string {
  const start = new Date(slot.startsAt);
  const end = new Date(slot.endsAt);
  const startZone = zoneName(start, timeZone);
  const endZone = zoneName(end, timeZone);
  if (startZone === endZone) return `${clock(start, timeZone)} to ${clock(end, timeZone)}`;
  return `${clock(start, timeZone)} ${startZone} to ${clock(end, timeZone)} ${endZone}`;
}

function dayAndTime(value: string, timeZone: string): string {
  const instant = new Date(value);
  return `${longDay(instant, timeZone)}, ${clock(instant, timeZone)} (${zoneName(instant, timeZone)})`;
}

/** A recorded appointment is shown from its stored site-local snapshot, never recomputed. */
function recordedAppointment(appointment: NonNullable<InspectionBookingRecord["appointment"]>): string {
  const start = new Date(`${appointment.localStartSnapshot}Z`);
  const end = new Date(`${appointment.localEndSnapshot}Z`);
  const day = longDay(start, "UTC");
  const endsSameDay = appointment.localStartSnapshot.slice(0, 10) === appointment.localEndSnapshot.slice(0, 10);
  const until = endsSameDay ? clock(end, "UTC") : `${longDay(end, "UTC")}, ${clock(end, "UTC")}`;
  return `${day}, ${clock(start, "UTC")} to ${until} · ${appointment.timezoneId} (UTC${appointment.utcOffsetStart})`;
}

export interface BookingStatusView {
  label: string;
  hint: string;
  tone: "waiting" | "confirmed" | "done" | "closed";
}

/** Customer-facing wording for the backend's booking and appointment states. */
export function bookingStatusView(booking: InspectionBookingRecord): BookingStatusView {
  if (booking.status === "PENDING_APPROVAL") {
    return { label: "Awaiting approval", hint: "We are checking inspector availability for this request.", tone: "waiting" };
  }
  if (booking.status === "REJECTED") {
    return { label: "Declined", hint: "This request was not approved.", tone: "closed" };
  }
  if (booking.status === "CANCELLED") {
    return { label: "Cancelled", hint: "This booking was cancelled and the time was released.", tone: "closed" };
  }
  const appointment = booking.appointment;
  if (appointment?.status === "COMPLETED") return { label: "Completed", hint: "This visit has taken place.", tone: "done" };
  if (appointment?.status === "NO_SHOW") return { label: "Visit did not take place", hint: "The inspector could not complete this visit.", tone: "closed" };
  if (appointment?.status === "CANCELLED") return { label: "Cancelled", hint: "This appointment was cancelled.", tone: "closed" };
  if (appointment?.status === "CONFIRMED") return { label: "Confirmed", hint: "An inspector is booked for this time.", tone: "confirmed" };
  return { label: "Approved", hint: "Approved; the appointment is being finalised.", tone: "waiting" };
}

/** "Main Pump Discharge Hose — HMS-001842": the name people know, then the HMS number. */
export function assetLabel(asset: { assetNumber: string; assetName?: string | null }): string {
  const name = asset.assetName?.trim();
  return name && name !== asset.assetNumber ? `${name} — ${asset.assetNumber}` : asset.assetNumber;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

/** The server no longer holds the chosen time (expired, taken, or the booking changed). */
function isStale(error: unknown): boolean {
  return error instanceof HmsApiError && [404, 409, 410, 422].includes(error.status);
}

type Availability =
  | { key: string; state: "idle" }
  | { key: string; state: "loading" }
  | { key: string; state: "error"; message: string }
  | { key: string; state: "ready"; slots: InspectionAvailabilitySlot[] };

interface Notice {
  kind: "success" | "error" | "info";
  message: string;
}

const IDLE: Availability = { key: "", state: "idle" };

export function CustomerBookings({
  assets,
  bookings,
  customer,
  onChanged
}: {
  assets: AssetRecord[];
  bookings: InspectionBookingRecord[];
  customer: CustomerRecord;
  onChanged: () => Promise<void>;
}) {
  const [locationId, setLocationId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [localDate, setLocalDate] = useState("");
  const [availability, setAvailability] = useState<Availability>(IDLE);
  const [quoteId, setQuoteId] = useState("");
  const [notes, setNotes] = useState("");
  const [reschedule, setReschedule] = useState<InspectionBookingRecord | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState<string | null>(null);
  const lock = useRef(false);
  const request = useRef(0);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const formHeading = useRef<HTMLHeadingElement>(null);

  const locationAssets = assets.filter((asset) => asset.location?.id === locationId);
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  // A booking only carries the asset number; the loaded asset records know the name.
  const bookedAssetLabel = (booked: { id: string; assetNumber: string }) => {
    const known = assetsById.get(booked.id);
    return known ? assetLabel(known) : booked.assetNumber;
  };
  const location = customer.locations.find((item) => item.id === locationId) ?? null;
  const zone = siteZone(location?.schedulingTimezone);
  const key = locationId && localDate ? `${locationId}|${localDate}` : "";
  // Slots are only trusted while the location and date they were priced for still match.
  const slots = availability.state === "ready" && availability.key === key ? availability.slots : [];
  const chosen = slots.find((slot) => slot.quoteId === quoteId) ?? null;
  const canSearch = Boolean(locationId && localDate && (reschedule || assetId));

  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  // Quotes are only good until they expire: drop the whole set at the earliest expiry, chosen or
  // not, and say so, rather than leave dead times on screen to fail at submit.
  const earliestExpiry = slots.length ? Math.min(...slots.map((slot) => new Date(slot.expiresAt).getTime())) : null;
  useEffect(() => {
    if (earliestExpiry === null) return;
    const wait = earliestExpiry - Date.now();
    const expire = () => {
      setAvailability(IDLE);
      setQuoteId("");
      setNotice({ kind: "info", message: "The times you were looking at have expired. Check availability again to see current times." });
    };
    if (wait <= 0) {
      expire();
      return;
    }
    const timer = window.setTimeout(expire, Math.min(wait, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [earliestExpiry]);

  function clearQuote() {
    request.current += 1;
    setAvailability(IDLE);
    setQuoteId("");
  }

  async function exclusive(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function findAvailability() {
    if (!canSearch) return;
    const ticket = ++request.current;
    setNotice(null);
    setQuoteId("");
    setAvailability({ key, state: "loading" });
    try {
      const found = await createHmsClient().listInspectionAvailability({ customerId: customer.id, locationId, localDate });
      if (ticket !== request.current) return;
      setAvailability({ key, state: "ready", slots: found });
    } catch (error) {
      if (ticket !== request.current) return;
      setAvailability({ key, state: "error", message: errorMessage(error) });
    }
  }

  function resetForm() {
    setAssetId("");
    setLocalDate("");
    setNotes("");
    setReschedule(null);
    clearQuote();
  }

  function submit() {
    if (!chosen || !locationId || (!reschedule && !assetId)) return;
    void exclusive(async () => {
      try {
        if (reschedule) {
          await createHmsClient().requestInspectionBookingReschedule(reschedule.id, {
            availabilityQuoteId: chosen.quoteId,
            reason: notes.trim() || null,
            inspectorUserId: null
          });
        } else {
          await createHmsClient().createInspectionBooking({
            customerId: customer.id,
            locationId,
            assetIds: [assetId],
            availabilityQuoteId: chosen.quoteId,
            additionalInformation: notes.trim() || null
          });
        }
        const message = reschedule
          ? "Your reschedule request was sent for review. Your current appointment stays in place until it is approved."
          : "Your inspection request was submitted for approval.";
        resetForm();
        setNotice({ kind: "success", message });
        await onChanged();
      } catch (error) {
        if (isStale(error)) {
          // Keep the location, asset and date; only the time is gone, so a fresh search is required.
          clearQuote();
          setNotice({
            kind: "error",
            message: `That time is no longer available (${errorMessage(error)}). Your details are kept: check availability again and choose a new time.`
          });
        } else {
          setNotice({ kind: "error", message: errorMessage(error) });
        }
      }
    });
  }

  function startReschedule(booking: InspectionBookingRecord) {
    setReschedule(booking);
    setLocationId(booking.location.id);
    setAssetId(booking.assets[0]?.id ?? "");
    setLocalDate("");
    setNotes("");
    setNotice(null);
    clearQuote();
    window.setTimeout(() => formHeading.current?.focus(), 0);
  }

  function cancelBooking(booking: InspectionBookingRecord) {
    void exclusive(async () => {
      setNotice(null);
      try {
        await createHmsClient().cancelInspectionBooking(booking.id, "Cancelled by customer");
        setConfirmingCancel(null);
        setNotice({ kind: "success", message: "The booking was cancelled and the time was released." });
        await onChanged();
      } catch (error) {
        setConfirmingCancel(null);
        if (isStale(error)) {
          setNotice({ kind: "error", message: "This booking has changed since you opened it, so nothing was cancelled. The list has been refreshed." });
          await onChanged();
        } else {
          setNotice({ kind: "error", message: errorMessage(error) });
        }
      }
    });
  }

  function confirmProposal(proposal: InspectionBookingChangeRequest) {
    void exclusive(async () => {
      setNotice(null);
      try {
        await createHmsClient().confirmInspectionBookingReschedule(proposal.id);
        setNotice({ kind: "success", message: "The new time is confirmed." });
        await onChanged();
      } catch (error) {
        if (isStale(error)) {
          setNotice({ kind: "error", message: "This proposal is no longer open, so nothing was changed. The list has been refreshed." });
          await onChanged();
        } else {
          setNotice({ kind: "error", message: errorMessage(error) });
        }
      }
    });
  }

  const firstSlot = slots[0];
  const hasLocations = customer.locations.length > 0;

  return (
    <>
      <section aria-labelledby="booking-form-title" className="portal-panel portal-booking">
        <h2 id="booking-form-title" ref={formHeading} tabIndex={-1}>
          {reschedule ? "Request a new appointment time" : "Request an inspection"}
        </h2>
        <p>
          {reschedule
            ? "The approved location and assets are fixed. Choose a new date, then a time."
            : "Choose a location and asset, then a date. Times are shown in the site's own time zone."}
        </p>

        {!hasLocations ? (
          <p className="portal-empty">No approved locations are available for this organisation, so inspections cannot be requested yet.</p>
        ) : (
          <>
            <div className="portal-form-grid">
              <label>
                <span>Location <span aria-hidden="true" className="portal-required">*</span></span>
                <select
                  aria-label="Booking location"
                  aria-required="true"
                  disabled={Boolean(reschedule)}
                  required
                  value={locationId}
                  onChange={(event) => {
                    setLocationId(event.target.value);
                    setAssetId("");
                    clearQuote();
                  }}
                >
                  <option value="">Select a location</option>
                  {customer.locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <label>
                <span>Asset <span aria-hidden="true" className="portal-required">*</span></span>
                <select
                  aria-label="Booking asset"
                  aria-required="true"
                  disabled={Boolean(reschedule) || !locationId}
                  required
                  value={assetId}
                  onChange={(event) => {
                    setAssetId(event.target.value);
                    clearQuote();
                  }}
                >
                  <option value="">Select an asset</option>
                  {locationAssets.map((asset) => <option key={asset.id} value={asset.id}>{assetLabel(asset)}</option>)}
                </select>
              </label>
              <label>
                <span>Preferred date <span aria-hidden="true" className="portal-required">*</span></span>
                <input
                  aria-label="Preferred date"
                  aria-required="true"
                  required
                  type="date"
                  value={localDate}
                  onChange={(event) => {
                    setLocalDate(event.target.value);
                    clearQuote();
                  }}
                />
              </label>
              <label>
                {reschedule ? "Reason for rescheduling (optional)" : "Notes (optional)"}
                <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
              </label>
            </div>
            <p className="portal-required-note"><span aria-hidden="true" className="portal-required">*</span> Required fields</p>
            {locationId && !reschedule && locationAssets.length === 0 ? (
              <p className="portal-empty">No assets are assigned to this location, so there is nothing to inspect there. Choose another location.</p>
            ) : null}
            {location && !location.schedulingTimezone ? (
              <p className="portal-empty">This location has no time zone configured, so times are shown in UTC.</p>
            ) : null}

            <div className="portal-actions">
              <button className="secondary-button" disabled={busy || !canSearch || availability.state === "loading"} type="button" onClick={() => void findAvailability()}>
                Find availability
              </button>
              {reschedule ? (
                <button
                  className="secondary-button"
                  disabled={busy}
                  type="button"
                  onClick={() => {
                    setReschedule(null);
                    setLocationId("");
                    setAssetId("");
                    setLocalDate("");
                    clearQuote();
                  }}
                >
                  Cancel reschedule
                </button>
              ) : null}
            </div>

            <div aria-live="polite" className="portal-availability">
              {availability.state === "loading" ? <p role="status">Checking availability…</p> : null}
              {availability.state === "error" && availability.key === key ? (
                <p className="portal-error" role="alert">
                  Availability could not be loaded: {availability.message}{" "}
                  <button className="secondary-button" type="button" onClick={() => void findAvailability()}>Try again</button>
                </p>
              ) : null}
              {availability.state === "ready" && availability.key === key && slots.length === 0 ? (
                <p className="portal-empty" role="status">
                  No times are available on {longDay(new Date(`${localDate}T12:00:00Z`), "UTC")} at {location?.name}. Try another date.
                </p>
              ) : null}
            </div>

            {firstSlot ? (
              <fieldset className="portal-slots">
                <legend>
                  Available times on {longDay(new Date(firstSlot.startsAt), zone)}
                  <span className="portal-zone"> · {zoneWithName(new Date(firstSlot.startsAt), zone)}</span>
                </legend>
                {slots.map((slot) => (
                  <label className="portal-slot" key={slot.quoteId}>
                    <input
                      checked={quoteId === slot.quoteId}
                      name="slot"
                      type="radio"
                      value={slot.quoteId}
                      onChange={() => setQuoteId(slot.quoteId)}
                    />
                    <span>{slotRange(slot, zone)}</span>
                  </label>
                ))}
              </fieldset>
            ) : null}

            {chosen ? (
              <p className="portal-summary" role="status">
                You are requesting {reschedule ? "to move " : ""}
                <strong>{location?.name}</strong>
                {reschedule ? null : <> for <strong>{(() => { const picked = locationAssets.find((asset) => asset.id === assetId); return picked ? assetLabel(picked) : ""; })()}</strong></>} on{" "}
                <strong>{longDay(new Date(chosen.startsAt), zone)}, {slotRange(chosen, zone)}</strong>{" "}
                ({zoneWithName(new Date(chosen.startsAt), zone)}).
              </p>
            ) : null}

            <div className="portal-actions">
              <button className="primary-button" disabled={busy || !chosen} type="button" onClick={submit}>
                {busy ? "Sending…" : reschedule ? "Request reschedule" : "Submit booking request"}
              </button>
            </div>
          </>
        )}
        {notice ? (
          <p className={`portal-notice is-${notice.kind}`} ref={noticeRef} role={notice.kind === "error" ? "alert" : "status"} tabIndex={-1}>
            {notice.message}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="booking-list-title" className="portal-panel">
        <h2 id="booking-list-title">Bookings</h2>
        {bookings.length === 0 ? (
          <p>No booking requests for this organisation yet. Requests you make will appear here.</p>
        ) : (
          <ul className="portal-list portal-bookings">
            {bookings.map((booking) => {
              const view = bookingStatusView(booking);
              const zoneId = siteZone(booking.location.schedulingTimezone);
              const proposal = booking.changeRequests.find((item) => item.status === "PENDING_CUSTOMER_CONFIRMATION") ?? null;
              const waitingOnUs = booking.changeRequests.some((item) => item.status === "PENDING_ADMIN_APPROVAL");
              const appointmentStatus = booking.appointment?.status;
              const open =
                booking.status === "PENDING_APPROVAL" ||
                (booking.status === "APPROVED" && appointmentStatus !== "CANCELLED" && appointmentStatus !== "COMPLETED" && appointmentStatus !== "NO_SHOW");
              return (
                <li className={`portal-booking-card is-${view.tone}`} key={booking.id}>
                  <div className="portal-booking-head">
                    <strong>{booking.location.name}</strong>
                    <span className="portal-status" title={view.hint}>{view.label}</span>
                  </div>
                  <span>{booking.appointment ? recordedAppointment(booking.appointment) : dayAndTime(booking.scheduledAt, zoneId)}</span>
                  <span>Assets: {booking.assets.map(bookedAssetLabel).join(", ")}</span>
                  <span className="portal-hint">{view.hint}</span>
                  {booking.rejectionReason ? <span>Reason: {booking.rejectionReason}</span> : null}
                  {proposal ? (
                    <span className="portal-proposal">
                      Proposed new time: <strong>{dayAndTime(proposal.startsAt, zoneId)}</strong>. Your current appointment stays until you confirm.
                    </span>
                  ) : null}
                  {waitingOnUs ? <span className="portal-hint">A reschedule request is waiting for approval.</span> : null}
                  {open || proposal ? (
                    <span className="portal-actions">
                      {proposal ? (
                        <button className="primary-button" disabled={busy} type="button" onClick={() => confirmProposal(proposal)}>
                          Confirm new time
                        </button>
                      ) : null}
                      {booking.status === "APPROVED" && appointmentStatus === "CONFIRMED" && !proposal && !waitingOnUs ? (
                        <button className="secondary-button" disabled={busy} type="button" onClick={() => startReschedule(booking)}>
                          Request reschedule
                        </button>
                      ) : null}
                      {open && confirmingCancel === booking.id ? (
                        <>
                          <button className="danger-button" disabled={busy} type="button" onClick={() => cancelBooking(booking)}>
                            Yes, cancel this booking
                          </button>
                          <button className="secondary-button" disabled={busy} type="button" onClick={() => setConfirmingCancel(null)}>
                            Keep booking
                          </button>
                        </>
                      ) : open ? (
                        <button className="secondary-button" disabled={busy} type="button" onClick={() => setConfirmingCancel(booking.id)}>
                          Cancel booking
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
