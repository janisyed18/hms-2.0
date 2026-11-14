import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Clock3
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { InspectionDetail } from "./InspectionDetail";
import { InspectionBookingCard } from "./InspectionBookingCard";
import { InspectionBookingForm } from "./InspectionBookingForm";
import { ActionNotice } from "./interaction/ActionNotice";
import { ChangeInspectorDialog } from "./interaction/ChangeInspectorDialog";
import { ConfirmDialog } from "./interaction/ConfirmDialog";
import { InspectionForm } from "./InspectionForm";
import { ModuleTable, activeFilterList, type ModuleColumn } from "./ModuleTable";
import {
  type InspectionStatusFilter,
  useInspectionsWorkspace
} from "../hooks/useInspectionsWorkspace";
import { createHmsClient } from "../api/hmsClient";
import type { AssetRecord, InspectionRecord } from "../domain/types";
import { friendlyApiError } from "./interaction/friendlyApiError";
import { StaggerGroup, StaggerItem } from "../motion/MotionPrimitives";
import { assetLabel } from "../utils/identity";
import { inspectionStatusLabel } from "../utils/inspectionStatus";
import { formatWithZone } from "../scheduling/zonedTime";

const statusFilters: Array<{ label: string; value: InspectionStatusFilter }> = [
  { label: "All", value: "ALL" },
  { label: "Awaiting review", value: "SUBMITTED" },
  { label: "Approved", value: "APPROVED" },
  { label: "Changes required", value: "REJECTED" },
  { label: "In progress", value: "IN_PROGRESS" },
  { label: "Draft", value: "DRAFT" }
];

function statusClass(status: string) {
  if (status === "DRAFT" || status === "IN_PROGRESS") {
    return "mini-status due-soon";
  }
  if (status === "SUBMITTED" || status === "PENDING_APPROVAL") {
    return "mini-status status-review";
  }
  if (status === "REJECTED") {
    return "mini-status overdue";
  }
  return "mini-status current";
}

function pressureLabel(inspection: InspectionRecord) {
  if (!inspection.pressureTest) {
    return "No pressure test";
  }
  return `${inspection.pressureTest.appliedPressureKpa} kPa / ${
    inspection.pressureTest.passed ? "Pass" : "Fail"
  }`;
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
  const [showAllBookings, setShowAllBookings] = useState(false);
  // Bookings and inspection records are distinct objects. Show one management view at a time
  // rather than duplicate full-height sections; retain the inspector/reviewer records workflow.
  const [managementView, setManagementView] = useState<"bookings" | "records">(
    canBook || canApproveBookings ? "bookings" : "records"
  );
  const [bookingStatusFilter, setBookingStatusFilter] = useState("ALL");
  const [bookingCustomerFilter, setBookingCustomerFilter] = useState("ALL");
  const [bookingAssetFilter, setBookingAssetFilter] = useState("ALL");
  const [bookingLocationFilter, setBookingLocationFilter] = useState("ALL");
  const [bookingSearch, setBookingSearch] = useState("");
  // The assigned inspector's name needs the inspector list, so it is loaded once a confirmed booking is on screen.
  const hasConfirmedBooking = workspace.bookings.some((booking) => booking.status === "APPROVED" && booking.appointment?.status === "CONFIRMED");
  const { loadInspectors } = workspace;
  useEffect(() => {
    if (canApproveBookings && hasConfirmedBooking) void loadInspectors();
    // loadInspectors is recreated each render; the list is loaded once, and only when needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canApproveBookings, hasConfirmedBooking]);
  const changingBooking = workspace.bookings.find((booking) => booking.id === changingInspector) ?? null;
  const hasReschedule = (booking: (typeof workspace.bookings)[number]) =>
    booking.changeRequests.some((change) =>
      change.status === "PENDING_ADMIN_APPROVAL" || change.status === "PENDING_CUSTOMER_CONFIRMATION"
    );
  const requestedCount = workspace.bookings.filter((booking) => booking.status === "PENDING_APPROVAL").length;
  const rescheduleCount = workspace.bookings.filter(hasReschedule).length;
  const approvedBookingCount = workspace.bookings.filter((booking) => booking.status === "APPROVED" && !hasReschedule(booking)).length;
  const rejectedBookingCount = workspace.bookings.filter((booking) => booking.status === "REJECTED").length;
  const choices = <T extends { id: string; name: string }>(values: T[]) =>
    Array.from(new Map(values.map((value) => [value.id, value])).values()).sort((x, y) => x.name.localeCompare(y.name));
  const customers = choices(workspace.bookings.map((booking) => booking.customer));
  const locations = choices(workspace.bookings.map((booking) => booking.location));
  const assets = Array.from(new Map(workspace.bookings.flatMap((booking) =>
    booking.assets.map((asset) => [asset.id, { id: asset.id, name: assetLabel(asset) }] as const)
  )).values()).sort((x, y) => x.name.localeCompare(y.name));
  const filteredBookings = workspace.bookings.filter((booking) => {
    const currentStatus = hasReschedule(booking) ? "RESCHEDULE_REQUESTED" : booking.status;
    if (bookingStatusFilter !== "ALL" && bookingStatusFilter !== currentStatus) return false;
    if (bookingCustomerFilter !== "ALL" && booking.customer.id !== bookingCustomerFilter) return false;
    if (bookingLocationFilter !== "ALL" && booking.location.id !== bookingLocationFilter) return false;
    if (bookingAssetFilter !== "ALL" && !booking.assets.some((asset) => asset.id === bookingAssetFilter)) return false;
    const text = bookingSearch.trim().toLowerCase();
    return !text || [booking.location.name, booking.customer.name, booking.customer.code,
      ...booking.assets.map(assetLabel), booking.id].some((field) => field.toLowerCase().includes(text));
  });
  const hasBookingFilters = bookingStatusFilter !== "ALL" || bookingCustomerFilter !== "ALL" ||
    bookingAssetFilter !== "ALL" || bookingLocationFilter !== "ALL" || Boolean(bookingSearch.trim());
  function clearBookingFilters() {
    setBookingStatusFilter("ALL");
    setBookingCustomerFilter("ALL");
    setBookingAssetFilter("ALL");
    setBookingLocationFilter("ALL");
    setBookingSearch("");
    setShowAllBookings(false);
  }

  const columns: ModuleColumn<InspectionRecord>[] = [
    {
      header: "Asset",
      render: (inspection) => <strong>{assetLabel(inspection.asset)}</strong>
    },
    {
      header: "Customer",
      render: (inspection) => inspection.customer.name
    },
    {
      header: "Type",
      render: (inspection) => inspection.inspectionType.replace("_", " ")
    },
    {
      header: "Result",
      render: (inspection) => inspection.result ?? "Pending"
    },
    {
      header: "Pressure Test",
      render: pressureLabel
    },
    {
      header: "Status",
      render: (inspection) => (
        <span className={statusClass(inspection.status)}>
          {inspectionStatusLabel(inspection.status)}
        </span>
      )
    },
    {
      header: "Actions",
      render: (inspection) => (
        <span className="row-actions">
          <button
            aria-label={`Open inspection ${assetLabel(inspection.asset)}`}
            onClick={() => workspace.openDetail(inspection)}
            type="button"
          >
            Open
          </button>
        </span>
      )
    }
  ];

  return (
    <section className="inspection-workspace" aria-labelledby="inspection-workspace-heading">
      <div className="inspection-dashboard">
        <header className="inspection-command-header">
          <div>
            <span className="inspection-command-eyebrow">Inspection management</span>
            <h2 id="inspection-workspace-heading">Inspection operations</h2>
            <p>Review inspection work, pressure tests, and approval readiness.</p>
          </div>
          <div className="inspection-command-side">
            <div className="inspection-command-context" aria-label="Current inspection scope">
              <ClipboardCheck aria-hidden="true" size={23} />
              <span>
                <strong>{workspace.bookingTotal} booking{workspace.bookingTotal === 1 ? "" : "s"}</strong>
                <small>{workspace.bookings.length} loaded for management</small>
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
            <InspectionMetric icon={ClipboardCheck} label="Requested" value={requestedCount} detail="Awaiting assignment and approval · loaded" tone="blue" />
            <InspectionMetric icon={Clock3} label="Reschedule requested" value={rescheduleCount} detail="Pending a decision · loaded" tone="amber" />
            <InspectionMetric icon={CheckCircle2} label="Approved" value={approvedBookingCount} detail="Confirmed bookings · loaded" tone="green" />
            <InspectionMetric icon={AlertTriangle} label="Rejected" value={rejectedBookingCount} detail="Declined requests · loaded" tone="red" />
          </StaggerGroup>
        </section>
        <div className="inspection-management-switch" role="group" aria-label="Inspection management view">
          {(canBook || canApproveBookings) ? (
            <button aria-pressed={managementView === "bookings"} className={managementView === "bookings" ? "is-active" : ""} onClick={() => setManagementView("bookings")} type="button">Booking requests</button>
          ) : null}
          <button aria-pressed={managementView === "records"} className={managementView === "records" ? "is-active" : ""} onClick={() => setManagementView("records")} type="button">Inspection records</button>
        </div>
        {managementView === "bookings" ? (
        <section className="inspection-bookings-panel" aria-labelledby="inspection-bookings-heading">
          <header className="inspection-bookings-heading">
            <div className="inspection-bookings-title">
              <span className="inspection-bookings-icon"><CalendarDays aria-hidden="true" size={20} /></span>
              <div>
                <h3 id="inspection-bookings-heading">Inspection bookings</h3>
                <p>Manage booking requests, assignments and reschedules. Availability checks are unchanged.</p>
              </div>
            </div>
          </header>
          <div className="inspection-booking-filters" aria-label="Filter inspection bookings">
            <label><span>Status</span><select aria-label="Booking status filter" value={bookingStatusFilter} onChange={(event) => { setBookingStatusFilter(event.target.value); setShowAllBookings(false); }}>
              <option value="ALL">All statuses</option><option value="PENDING_APPROVAL">Requested</option><option value="RESCHEDULE_REQUESTED">Reschedule requested</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option><option value="CANCELLED">Cancelled</option>
            </select></label>
            <label><span>Customer</span><select aria-label="Booking customer filter" value={bookingCustomerFilter} onChange={(event) => { setBookingCustomerFilter(event.target.value); setShowAllBookings(false); }}><option value="ALL">All customers</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>Customer · {customer.name}</option>)}</select></label>
            <label><span>Asset</span><select aria-label="Booking asset filter" value={bookingAssetFilter} onChange={(event) => { setBookingAssetFilter(event.target.value); setShowAllBookings(false); }}><option value="ALL">All assets</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>Asset · {asset.name}</option>)}</select></label>
            <label><span>Location</span><select aria-label="Booking location filter" value={bookingLocationFilter} onChange={(event) => { setBookingLocationFilter(event.target.value); setShowAllBookings(false); }}><option value="ALL">All locations</option>{locations.map((location) => <option key={location.id} value={location.id}>Location · {location.name}</option>)}</select></label>
            <label className="inspection-booking-search"><span>Search</span><input aria-label="Search booking requests" placeholder="Customer, asset or reference…" value={bookingSearch} onChange={(event) => { setBookingSearch(event.target.value); setShowAllBookings(false); }}/></label>
            <button className="secondary-button inspection-clear-filters" disabled={!hasBookingFilters} onClick={clearBookingFilters} type="button">Clear filters</button>
          </div>
          <p className="inspection-booking-count" role="status">{filteredBookings.length} matching of {workspace.bookings.length} loaded bookings{workspace.bookingTotal > workspace.bookings.length ? ` · ${workspace.bookingTotal} total; load more to search additional records` : ""}</p>
          {filteredBookings.length ? (
            <div className="inspection-booking-list" aria-label="Inspection bookings">
              {(showAllBookings ? filteredBookings : filteredBookings.slice(0, 4)).map((booking) => (
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
              {!showAllBookings && filteredBookings.length > 4 ? (
                <button className="secondary-button compact-action" onClick={() => setShowAllBookings(true)} type="button">
                  {hasBookingFilters ? `Show all ${filteredBookings.length} matching loaded bookings` : `Show all ${filteredBookings.length} loaded bookings`}
                </button>
              ) : null}
              {workspace.bookingTotal > workspace.bookings.length ? (
                <button className="secondary-button compact-action" onClick={() => void workspace.loadMoreBookings()} type="button">
                  Load more bookings
                </button>
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
              <span><strong>{hasBookingFilters ? "No loaded bookings match those filters." : "No inspection bookings are scheduled."}</strong> {hasBookingFilters ? "Clear filters or load more records to broaden the search." : "Book a site visit to coordinate inspection work."}</span>
            </p>
          )}
        </section>
        ) : null}
        {managementView === "records" ? (
        <div className="inspection-filter-tabs" role="tablist" aria-label="Inspection status filters">
          {statusFilters.map((filter) => (
            <button
              aria-selected={workspace.statusFilter === filter.value}
              className={workspace.statusFilter === filter.value ? "is-active" : ""}
              key={filter.value}
              onClick={() => workspace.setStatusFilter(filter.value)}
              role="tab"
              type="button"
            >
              {filter.label}
            </button>
          ))}
        </div>
        ) : null}
      </div>

      {managementView === "records" ? (
      <div className={`inspection-layout${workspace.selectedInspection ? " detail-open" : " detail-closed"}`}>
        {workspace.selectedInspection && workspace.ratingReady ? (
          <InspectionDetail
            canApprove={canApprove}
            canWrite={canWrite}
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
        ) : (
          <div className="inspection-table-wrap">
            <ModuleTable
              actionLabel={canWrite ? "Create inspection" : undefined}
              actionVariant="secondary"
              actionsInToolbar
              className="inspection-register-table"
              columns={columns}
              countLabel={
                workspace.isLoading
                  ? "Loading inspections"
                  : `${workspace.visibleInspections.length} inspections`
              }
              activeFilters={activeFilterList([
                { id: "type", label: "Type", value: workspace.typeFilter !== "ALL" && workspace.typeFilter.replaceAll("_", " ").toLowerCase(), onRemove: () => workspace.setTypeFilter("ALL") },
                { id: "result", label: "Result", value: workspace.resultFilter !== "ALL" && workspace.resultFilter.replaceAll("_", " ").toLowerCase(), onRemove: () => workspace.setResultFilter("ALL") }
              ])}
              emptyHint="Inspections appear here once one is created or an inspector starts a booked visit."
              emptyLabel="No inspections match the current filters."
              loadedCount={workspace.inspections.length}
              noun="inspections"
              onClearFilters={workspace.clearInspectionFilters}
              totalCount={workspace.serverTotal}
              exportRows={(inspection) => [
                inspection.status,
                inspection.asset.assetNumber,
                inspection.customer.name,
                inspection.inspectionType,
                inspection.result ?? "",
                pressureLabel(inspection),
                ""
              ]}
              activeFilterCount={workspace.activeFilterCount}
              filterControls={
                <>
                  <label className="filter-field">
                    <span>Type</span>
                    <select
                      aria-label="Inspection type filter"
                      value={workspace.typeFilter}
                      onChange={(event) => workspace.setTypeFilter(event.target.value as typeof workspace.typeFilter)}
                    >
                      <option value="ALL">All types</option>
                      <option value="NEW_ASSET">New asset</option>
                      <option value="SERVICE">Service</option>
                    </select>
                  </label>
                  <label className="filter-field">
                    <span>Result</span>
                    <select
                      aria-label="Inspection result filter"
                      value={workspace.resultFilter}
                      onChange={(event) => workspace.setResultFilter(event.target.value)}
                    >
                      <option value="ALL">All results</option>
                      {workspace.resultOptions.map((result) => (
                        <option key={result} value={result}>
                          {result === "PENDING" ? "Pending" : result}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="secondary-button filter-clear" type="button" onClick={workspace.clearInspectionFilters}>
                    Clear inspection filters
                  </button>
                </>
              }
              getRowKey={(inspection) => inspection.id}
              items={workspace.visibleInspections}
              loading={workspace.isLoading}
              onAction={canWrite ? workspace.openCreate : undefined}
              onQueryChange={workspace.setQuery}
              onRowSelect={workspace.openDetail}
              query={workspace.query}
              searchLabel="Search inspections"
              searchPlaceholder="Search inspections by asset, customer or product"
              tableLabel="Inspection records"
              error={workspace.error}
            />
          </div>
        )}
      </div>
      ) : null}

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
      {canWrite ? (
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
