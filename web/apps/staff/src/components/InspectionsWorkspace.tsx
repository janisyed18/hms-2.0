import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Search
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { InspectionDetail } from "./InspectionDetail";
import { InspectionBookingCard } from "./InspectionBookingCard";
import { InspectionBookingForm } from "./InspectionBookingForm";
import { ActionNotice } from "./interaction/ActionNotice";
import { ChangeInspectorDialog } from "./interaction/ChangeInspectorDialog";
import { ConfirmDialog } from "./interaction/ConfirmDialog";
import { InspectionForm } from "./InspectionForm";
import { useInspectionsWorkspace } from "../hooks/useInspectionsWorkspace";
import { createHmsClient } from "../api/hmsClient";
import type { AssetRecord, InspectionBookingRecord } from "../domain/types";
import { friendlyApiError } from "./interaction/friendlyApiError";
import { StaggerGroup, StaggerItem } from "../motion/MotionPrimitives";
import { assetLabel } from "../utils/identity";
import { formatWithZone } from "../scheduling/zonedTime";

type BookingViewStatus = "ALL" | "REQUESTED" | "RESCHEDULE" | "APPROVED" | "REJECTED";
const bookingStatusOptions: Array<{ value: BookingViewStatus; label: string }> = [
  { value: "ALL", label: "All statuses" },
  { value: "REQUESTED", label: "Requested" },
  { value: "RESCHEDULE", label: "Reschedule requested" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" }
];
const openChangeStatuses = new Set(["PENDING_ADMIN_APPROVAL", "PENDING_CUSTOMER_CONFIRMATION"]);
function bookingViewStatus(booking: InspectionBookingRecord): BookingViewStatus | "CANCELLED" {
  if (booking.changeRequests.some((change) => openChangeStatuses.has(change.status))) return "RESCHEDULE";
  if (booking.status === "PENDING_APPROVAL") return "REQUESTED";
  if (booking.status === "APPROVED" || booking.status === "REJECTED") return booking.status;
  return "CANCELLED";
}

function formatLocationDateTime(value: string, timezone: string | null | undefined) {
  return formatWithZone(value, timezone);
}

export function InspectionsWorkspace({
  canApprove,
  canApproveBookings,
  canBook,
  canWrite,
  routeInspectionId,
  onInspectionRouteChange,
  bookAssetId = null,
  onBookAssetHandled
}: {
  canApprove: boolean;
  canApproveBookings: boolean;
  canBook: boolean;
  canWrite: boolean;
  routeInspectionId?: string | null;
  onInspectionRouteChange?: (inspectionId: string | null, options?: { replace?: boolean }) => void;
  /** An asset to start a booking from (from the address bar); the form opens once, prefilled from it. */
  bookAssetId?: string | null;
  /** Called once the asset-started booking has been opened, closed or has failed, so the address can drop it. */
  onBookAssetHandled?: () => void;
}) {
  const workspace = useInspectionsWorkspace(canApproveBookings, routeInspectionId, onInspectionRouteChange);
  const [bookingAsset, setBookingAsset] = useState<{ asset: AssetRecord | null; opened: boolean } | null>(null);
  const [bookingAssetError, setBookingAssetError] = useState<string | null>(null);
  const handled = useRef(onBookAssetHandled);
  const openBookingRef = useRef(workspace.openBooking);
  // These are recreated on every render; the asset-started booking below must call the latest of each.
  useEffect(() => {
    handled.current = onBookAssetHandled;
    openBookingRef.current = workspace.openBooking;
  });

  // Asset to booking form: load the asset, then open the one booking form with it. An asset that cannot
  // be loaded (gone, mistyped, or the request failed) leaves the form open and blank, with the reason.
  useEffect(() => {
    if (!bookAssetId || !canBook) {
      if (bookAssetId) handled.current?.();
      return;
    }
    let active = true;
    setBookingAssetError(null);
    void (async () => {
      let asset: AssetRecord | null = null;
      try {
        asset = await createHmsClient().getAsset(bookAssetId);
      } catch (reason) {
        if (!active) return;
        setBookingAssetError(`${friendlyApiError(reason, { fallback: "The asset could not be loaded." }).message} Choose the customer and assets below instead.`);
      }
      if (!active) return;
      setBookingAsset({ asset, opened: false });
      const opened = await openBookingRef.current();
      // Opening waits on the inspector list; by then the address may have moved to another asset, and a
      // late failure for this one must not clear that one's booking context.
      if (!active) return;
      if (!opened) {
        setBookingAsset(null);
        handled.current?.();
      }
    })();
    return () => { active = false; };
  }, [bookAssetId, canBook]);
  // Once the form has been seen open and is then closed (saved or cancelled), the asset context ends.
  useEffect(() => {
    if (!bookingAsset) return;
    if (workspace.isBookingFormOpen && !bookingAsset.opened) setBookingAsset({ ...bookingAsset, opened: true });
    else if (!workspace.isBookingFormOpen && bookingAsset.opened) {
      setBookingAsset(null);
      handled.current?.();
    }
  }, [bookingAsset, workspace.isBookingFormOpen]);
  /** The booking whose inspector the open "Change inspector" dialog is for. */
  const [changingInspector, setChangingInspector] = useState<string | null>(null);
  const [bookingStatus, setBookingStatus] = useState<BookingViewStatus>("ALL");
  const [customerFilter, setCustomerFilter] = useState("ALL");
  const [assetFilter, setAssetFilter] = useState("ALL");
  const [locationFilter, setLocationFilter] = useState("ALL");
  const [bookingSearch, setBookingSearch] = useState("");
  const bookingOptions = useMemo(() => {
    const unique = (values: Array<{ id: string; name: string }>) =>
      Array.from(new Map(values.map((item) => [item.id, item])).values())
        .sort((a, b) => a.name.localeCompare(b.name));
    return {
      customers: unique(workspace.bookings.map((item) => ({ id: item.customer.id, name: item.customer.name }))),
      locations: unique(workspace.bookings.map((item) => ({ id: item.location.id, name: item.location.name }))),
      assets: unique(workspace.bookings.flatMap((item) => item.assets.map((asset) => ({
        id: asset.id, name: assetLabel(asset)
      }))))
    };
  }, [workspace.bookings]);
  const visibleBookings = useMemo(() => workspace.bookings.filter((booking) => {
    const text = bookingSearch.trim().toLowerCase();
    return (bookingStatus === "ALL" || bookingViewStatus(booking) === bookingStatus)
      && (customerFilter === "ALL" || booking.customer.id === customerFilter)
      && (assetFilter === "ALL" || booking.assets.some((asset) => asset.id === assetFilter))
      && (locationFilter === "ALL" || booking.location.id === locationFilter)
      && (!text || [booking.customer.name, booking.location.name, booking.id,
        ...booking.assets.map(assetLabel)].some((value) => value.toLowerCase().includes(text)));
  }), [workspace.bookings, bookingStatus, customerFilter, assetFilter, locationFilter, bookingSearch]);
  const clearBookingFilters = () => {
    setBookingStatus("ALL"); setCustomerFilter("ALL"); setAssetFilter("ALL");
    setLocationFilter("ALL"); setBookingSearch("");
  };
  // The assigned inspector's name needs the inspector list, so it is loaded once a confirmed booking is on screen.
  const hasConfirmedBooking = workspace.bookings.some((booking) => booking.status === "APPROVED" && booking.appointment?.status === "CONFIRMED");
  const { loadInspectors } = workspace;
  useEffect(() => {
    if (canApproveBookings && hasConfirmedBooking) void loadInspectors();
    // loadInspectors is recreated each render; the list is loaded once, and only when needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canApproveBookings, hasConfirmedBooking]);
  const changingBooking = workspace.bookings.find((booking) => booking.id === changingInspector) ?? null;
  const requestedCount = workspace.bookings.filter((booking) => bookingViewStatus(booking) === "REQUESTED").length;
  const rescheduleCount = workspace.bookings.filter((booking) => bookingViewStatus(booking) === "RESCHEDULE").length;
  const approvedCount = workspace.bookings.filter((booking) => bookingViewStatus(booking) === "APPROVED").length;
  const rejectedCount = workspace.bookings.filter((booking) => bookingViewStatus(booking) === "REJECTED").length;

  return (
    <section className="inspection-workspace" aria-labelledby="inspection-workspace-heading">
      <div className="inspection-dashboard">
        <header className="inspection-command-header">
          <div>
            <span className="inspection-command-eyebrow">Inspection management</span>
            <h2 id="inspection-workspace-heading">Inspection operations</h2>
            <p>Manage booking requests, inspector assignments, reschedules and approvals.</p>
          </div>
          <div className="inspection-command-side">
            <div className="inspection-command-context" aria-label="Current inspection scope">
              <ClipboardCheck aria-hidden="true" size={23} />
              <span>
                <strong>{workspace.bookingTotal} booking{workspace.bookingTotal === 1 ? "" : "s"}</strong>
                <small>{visibleBookings.length} matching the loaded bookings</small>
              </span>
            </div>
            {canBook ? (
              <button className="primary-button inspection-book-button" onClick={workspace.openBooking} type="button">
                <CalendarDays aria-hidden="true" size={17} />
                Book inspection
              </button>
            ) : null}
          </div>
        </header>
        {bookingAssetError ? (
          <ActionNotice kind="error" onDismiss={() => setBookingAssetError(null)} title="Asset not loaded">
            {bookingAssetError}
          </ActionNotice>
        ) : null}
        {workspace.notice ? (
          <ActionNotice kind={workspace.notice.kind} onDismiss={workspace.dismissNotice} title={workspace.notice.title}>
            {workspace.notice.message}
          </ActionNotice>
        ) : null}
        <section aria-label="Inspection overview">
          <StaggerGroup className="inspection-metrics inspection-command-metrics">
            <InspectionMetric icon={ClipboardCheck} label="Requested" value={requestedCount} detail="New requests in loaded bookings" tone="blue" />
            <InspectionMetric icon={Clock3} label="Reschedule requested" value={rescheduleCount} detail="Changes awaiting confirmation" tone="amber" />
            <InspectionMetric icon={CheckCircle2} label="Approved" value={approvedCount} detail="Confirmed in loaded bookings" tone="green" />
            <InspectionMetric icon={AlertTriangle} label="Rejected" value={rejectedCount} detail="Not approved" tone="red" />
          </StaggerGroup>
        </section>
        <div className="inspection-booking-filters" role="group" aria-label="Filter inspection bookings">
          <label>Status
            <select aria-label="Booking status" value={bookingStatus} onChange={(event) => setBookingStatus(event.target.value as BookingViewStatus)}>
              {bookingStatusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>Customer
            <select aria-label="Booking customer" value={customerFilter} onChange={(event) => setCustomerFilter(event.target.value)}>
              <option value="ALL">All customers</option>
              {bookingOptions.customers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>Asset
            <select aria-label="Booking asset" value={assetFilter} onChange={(event) => setAssetFilter(event.target.value)}>
              <option value="ALL">All assets</option>
              {bookingOptions.assets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>Location
            <select aria-label="Booking location" value={locationFilter} onChange={(event) => setLocationFilter(event.target.value)}>
              <option value="ALL">All locations</option>
              {bookingOptions.locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="inspection-booking-search"><span>Search</span>
            <span className="inspection-booking-search-field"><Search aria-hidden="true" size={16}/>
              <input aria-label="Search bookings" placeholder="Search bookings..." value={bookingSearch} onChange={(event) => setBookingSearch(event.target.value)}/>
            </span>
          </label>
          <button className="secondary-button" type="button" onClick={clearBookingFilters}>Clear filters</button>
        </div>
        <section className="inspection-bookings-panel" aria-labelledby="inspection-bookings-heading">
          <header className="inspection-bookings-heading">
            <div className="inspection-bookings-title">
              <span className="inspection-bookings-icon"><CalendarDays aria-hidden="true" size={20} /></span>
              <div>
                <h3 id="inspection-bookings-heading">Inspection bookings</h3>
                <p>One place to manage booking requests, assignments and approved work.</p>
              </div>
            </div>
          </header>
          <p className="inspection-booking-filter-count" role="status">Showing {visibleBookings.length} of {workspace.bookings.length} loaded bookings{workspace.bookingTotal > workspace.bookings.length ? ` (${workspace.bookingTotal} total; load more to search older bookings)` : ""}.</p>
          {visibleBookings.length ? (
            <div className="inspection-booking-list" aria-label="Inspection bookings">
              {visibleBookings.map((booking) => (
                <InspectionBookingCard
                  booking={booking}
                  canApproveBookings={canApproveBookings}
                  canBook={canBook}
                  inspectors={workspace.inspectors}
                  key={booking.id}
                  onApprove={(bookingId, inspectorId) => void workspace.approveInspectionBooking(bookingId, inspectorId)}
                  onApproveReschedule={(changeId, inspectorId) => void workspace.approveInspectionBookingReschedule(changeId, inspectorId)}
                  onCancel={(target) => workspace.bookingDecision.request({ action: "cancel", booking: target })}
                  onChangeInspector={(target) => void workspace.loadInspectors().then((loaded) => { if (loaded) setChangingInspector(target.id); })}
                  onConfirmReschedule={(changeId) => void workspace.confirmInspectionBookingReschedule(changeId)}
                  onDecline={(target) => workspace.bookingDecision.request({ action: "reject", booking: target })}
                  onRequestReschedule={workspace.openReschedule}
                  pendingAction={workspace.pendingAction}
                />
              ))}
              {workspace.bookingTotal > workspace.bookings.length ? (
                <button className="secondary-button compact-action" onClick={() => void workspace.loadMoreBookings()} type="button">Load more bookings</button>
              ) : null}
              <ChangeInspectorDialog
                checkAvailability={(inspectorId) => workspace.checkInspectorAvailability(changingBooking?.id ?? "", inspectorId)}
                currentInspectorId={changingBooking?.inspectorUserId ?? null}
                currentInspectorName={workspace.inspectors.find((inspector) => inspector.id === changingBooking?.inspectorUserId)?.displayName ?? "Assigned"}
                inspectors={workspace.inspectors.map((inspector) => ({ id: inspector.id, name: inspector.displayName }))}
                onClose={() => setChangingInspector(null)}
                onSave={async (inspectorId) => {
                  if (!changingBooking) return "This booking is no longer available.";
                  const result = await workspace.reassignInspectionBookingInspector(changingBooking.id, inspectorId);
                  if (!result.ok) return result.error.message;
                  setChangingInspector(null);
                  return null;
                }}
                open={changingBooking !== null}
                siteName={changingBooking?.location.name ?? ""}
                whenLabel={changingBooking ? formatLocationDateTime(changingBooking.scheduledAt, changingBooking.location.schedulingTimezone) : undefined}
              />
            </div>
          ) : (
            <p className="inspection-booking-empty">
              <CalendarDays aria-hidden="true" size={22} />
              <span><strong>No bookings match these filters.</strong> Clear filters or load more bookings to find older records.</span>
            </p>
          )}
        </section>
        {canApprove && workspace.inspections.some((inspection) => inspection.status === "SUBMITTED") ? (
          <div className="inspection-booking-review-links" aria-label="Submitted inspection reports">
            <strong>Inspection reports awaiting review</strong>
            <p>Report approval is separate from booking approval. Open a submitted report to review its findings.</p>
            {workspace.inspections.filter((inspection) => inspection.status === "SUBMITTED").map((inspection) => (
              <button key={inspection.id} className="secondary-button" type="button" onClick={() => workspace.openDetail(inspection)}>
                Review {assetLabel(inspection.asset)} — {inspection.customer.name}
              </button>
            ))}
          </div>
        ) : null}
        {workspace.selectedInspection && workspace.ratingReady ? (
          <InspectionDetail
            canApprove={canApprove}
            canWrite={canWrite && !canApproveBookings}
            inspection={workspace.selectedInspection}
            ratingFor={workspace.ratingFor}
            onApprove={workspace.approveInspection}
            onBeginRework={workspace.beginInspectionRework}
            onClose={workspace.closeDetail}
            onReject={workspace.rejectInspection}
            onStart={workspace.startInspection}
            onRefresh={workspace.refreshBookingsAndInspections}
            onSaveDraft={workspace.saveInspectionUpdate}
            onSubmit={workspace.submitInspection}
          />
        ) : null}
      </div>

      <ConfirmDialog
        confirmLabel={workspace.bookingDecision.target?.action === "reject" ? "Decline booking" : "Cancel booking"}
        error={workspace.bookingDecision.error}
        message={workspace.bookingDecision.target
          ? `${workspace.bookingDecision.target.booking.assets.map(assetLabel).join(", ")} · ${formatWithZone(workspace.bookingDecision.target.booking.scheduledAt, workspace.bookingDecision.target.booking.location.schedulingTimezone)}. ${workspace.bookingDecision.target.action === "reject" ? "The customer is told the request was declined." : "The confirmed time is released for other bookings."}`
          : ""}
        onCancel={workspace.bookingDecision.cancel}
        onConfirm={() => void workspace.bookingDecision.confirm()}
        open={workspace.bookingDecision.target !== null}
        pending={workspace.bookingDecision.pending}
        pendingLabel={workspace.bookingDecision.target?.action === "reject" ? "Declining…" : "Cancelling…"}
        title={workspace.bookingDecision.target
          ? `${workspace.bookingDecision.target.action === "reject" ? "Decline" : "Cancel"} the booking at ${workspace.bookingDecision.target.booking.location.name}?`
          : "Change booking?"}
      />
      {canWrite && !canApproveBookings ? (
        <InspectionForm
          open={workspace.isFormOpen}
          onClose={() => workspace.setFormOpen(false)}
          onSubmit={workspace.saveInspection}
        />
      ) : null}
      {canBook ? (
        <InspectionBookingForm
          open={workspace.isBookingFormOpen}
          rescheduleBooking={workspace.rescheduleBooking}
          initialAsset={bookingAsset?.asset ?? null}
          inspectors={workspace.inspectors}
          requiresInspector={canApproveBookings}
          onClose={() => workspace.setBookingFormOpen(false)}
          onSubmit={workspace.saveInspectionBooking}
          onReschedule={workspace.requestInspectionBookingReschedule}
        />
      ) : null}
    </section>
  );
}

function InspectionMetric({
  detail,
  icon: Icon,
  label,
  tone,
  value
}: {
  detail: string;
  icon: typeof ClipboardCheck;
  label: string;
  tone: "amber" | "blue" | "green" | "red";
  value: number;
}) {
  return (
    <StaggerItem className={`inspection-command-metric tone-${tone}`}>
      <Icon aria-hidden="true" size={21} />
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </span>
    </StaggerItem>
  );
}
