import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Clock3
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { InspectionDetail } from "./InspectionDetail";
import { InspectionBookingsTable } from "./InspectionBookingsTable";
import { InspectionBookingForm } from "./InspectionBookingForm";
import { ActionNotice } from "./interaction/ActionNotice";
import { ChangeInspectorDialog } from "./interaction/ChangeInspectorDialog";
import { ConfirmDialog } from "./interaction/ConfirmDialog";
import { InspectionForm } from "./InspectionForm";
import { ModuleTable, activeFilterList, type ModuleColumn } from "./ModuleTable";
import {
  BOOKING_PAGE_SIZES,
  type InspectionStatusFilter,
  useInspectionsWorkspace
} from "../hooks/useInspectionsWorkspace";
import { createHmsClient } from "../api/hmsClient";
import type { AssetRecord, InspectionBookingRecord, InspectionRecord } from "../domain/types";
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
  /** What the open inspector dialog is for: a first assignment, a change, or approving
      a reschedule. All three pick one inspector and verify them the same way. */
  type InspectorTask =
    | { kind: "assign"; booking: InspectionBookingRecord }
    | { kind: "change"; booking: InspectionBookingRecord }
    | { kind: "approve-change"; booking: InspectionBookingRecord; changeId: string };
  const [inspectorTask, setInspectorTask] = useState<InspectorTask | null>(null);
  // Bookings and inspection records are distinct objects. Show one management view at a time
  // rather than duplicate full-height sections; retain the inspector/reviewer records workflow.
  const [managementView, setManagementView] = useState<"bookings" | "records">(
    routeInspectionId ? "records" : canBook || canApproveBookings ? "bookings" : "records"
  );
  // A direct inspection link must open the record even for admins whose default view is bookings.
  useEffect(() => { if (routeInspectionId) setManagementView("records"); }, [routeInspectionId]);
  // The inspector list is what names an assigned inspector and what an assignment or a
  // reschedule decision is picked from, so it is loaded once a booking on screen needs it.
  const needsInspectors = workspace.bookings.some((booking) =>
    (booking.status === "APPROVED" && booking.appointment?.status === "CONFIRMED") ||
    booking.status === "PENDING_APPROVAL" ||
    booking.changeRequests.some((change) => change.status === "PENDING_ADMIN_APPROVAL"));
  const { loadInspectors } = workspace;
  useEffect(() => {
    if (canApproveBookings && needsInspectors) void loadInspectors();
    // loadInspectors is recreated each render; the list is loaded once, and only when needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canApproveBookings, needsInspectors]);
  // Every number on this screen is the server's count for the whole filtered set, so the
  // tiles, the tabs and the range under the table all agree with each other.
  const counts = workspace.bookingStatusCounts;
  const { bookingFacets, bookingFilters, hasBookingFilters, setBookingFilter } = workspace;
  const statusTabs = [
    { value: "ALL" as const, label: "All", count: counts.all },
    { value: "PENDING_APPROVAL" as const, label: "Requested", count: counts.pendingApproval },
    { value: "RESCHEDULE_REQUESTED" as const, label: "Reschedule requested", count: counts.rescheduleRequested },
    { value: "APPROVED" as const, label: "Approved", count: counts.approved },
    { value: "REJECTED" as const, label: "Rejected", count: counts.rejected }
  ];
  function changeBookingFilter<K extends keyof typeof bookingFilters>(key: K, value: (typeof bookingFilters)[K]) {
    setBookingFilter(key, value);
  }
  function clearBookingFilters() { workspace.clearBookingFilters(); }
  const pageCount = Math.max(1, Math.ceil(workspace.bookingTotal / workspace.bookingPageSize));
  const pageNumbers = Array.from({ length: pageCount }, (_, index) => index);
  const firstOnPage = workspace.bookingTotal === 0 ? 0 : workspace.bookingPage * workspace.bookingPageSize + 1;
  const lastOnPage = Math.min(workspace.bookingTotal, firstOnPage + workspace.bookings.length - 1);
  const bookingCountLabel = workspace.bookingsLoading
    ? "Loading bookings"
    : workspace.bookingTotal === 0
      ? "No bookings"
      : `${firstOnPage} – ${lastOnPage} of ${workspace.bookingTotal} booking${workspace.bookingTotal === 1 ? "" : "s"}`;

  /** The one place a chosen inspector is applied, whichever task opened the dialog. */
  async function saveInspectorTask(inspectorId: string): Promise<string | null> {
    if (!inspectorTask) return "This booking is no longer available.";
    const result = inspectorTask.kind === "change"
      ? await workspace.reassignInspectionBookingInspector(inspectorTask.booking.id, inspectorId)
      : inspectorTask.kind === "assign"
        ? await workspace.approveInspectionBooking(inspectorTask.booking.id, inspectorId)
        : await workspace.approveInspectionBookingReschedule(inspectorTask.changeId, inspectorId);
    if (result && !result.ok) return result.error.message;
    setInspectorTask(null);
    return null;
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
            <p>Manage inspection requests, approvals, reschedules and inspector assignments.</p>
          </div>
          <div className="inspection-command-side">
            <div className="inspection-command-context" aria-label="Current inspection scope">
              <ClipboardCheck aria-hidden="true" size={23} />
              <span>
                <strong>{workspace.bookingTotal} booking{workspace.bookingTotal === 1 ? "" : "s"}</strong>
                <small>{hasBookingFilters ? "Matching the current filters" : "Across all statuses"}</small>
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
            <InspectionMetric icon={ClipboardCheck} label="New requests" value={counts.pendingApproval} detail="Awaiting assignment or review" tone="blue" />
            <InspectionMetric icon={Clock3} label="Reschedule requested" value={counts.rescheduleRequested} detail="Pending approval" tone="amber" />
            <InspectionMetric icon={CheckCircle2} label="Approved" value={counts.approved} detail="Scheduled and confirmed" tone="green" />
            <InspectionMetric icon={AlertTriangle} label="Rejected" value={counts.rejected} detail="Not approved" tone="red" />
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
          <h3 className="sr-only" id="inspection-bookings-heading">Inspection bookings</h3>
          <div className="inspection-booking-filters" role="group" aria-label="Filter inspection bookings">
            <label>
              <span>Status</span>
              <select aria-label="Filter by booking status" value={bookingFilters.status} onChange={(event) => changeBookingFilter("status", event.target.value as typeof bookingFilters.status)}>
                <option value="ALL">All statuses</option>
                <option value="PENDING_APPROVAL">Requested</option>
                <option value="RESCHEDULE_REQUESTED">Reschedule requested</option>
                <option value="APPROVED">Approved</option>
                <option value="REJECTED">Rejected</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </label>
            <label>
              <span>Customer</span>
              <select aria-label="Filter by customer" value={bookingFilters.customerId} onChange={(event) => changeBookingFilter("customerId", event.target.value)}>
                <option value="ALL">All customers</option>
                {bookingFacets.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
              </select>
            </label>
            <label>
              <span>Asset</span>
              <select aria-label="Filter by asset" value={bookingFilters.assetId} onChange={(event) => changeBookingFilter("assetId", event.target.value)}>
                <option value="ALL">All assets</option>
                {bookingFacets.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
              </select>
            </label>
            <label>
              <span>Location</span>
              <select aria-label="Filter by location" value={bookingFilters.locationId} onChange={(event) => changeBookingFilter("locationId", event.target.value)}>
                <option value="ALL">All locations</option>
                {bookingFacets.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
              </select>
            </label>
            <label className="inspection-booking-search">
              <span>Search</span>
              <input aria-label="Search bookings" placeholder="Search by customer, asset, reference…" value={bookingFilters.search} onChange={(event) => changeBookingFilter("search", event.target.value)} type="search" />
            </label>
            <button className="secondary-button inspection-clear-filters" disabled={!hasBookingFilters} onClick={clearBookingFilters} type="button">
              Clear filters
            </button>
          </div>

          {/* The counts come from the server for the whole filtered set, so a tab says
              what is behind it rather than what this page happens to hold. */}
          <div className="inspection-status-tabs" role="tablist" aria-label="Booking status">
            {statusTabs.map((tab) => (
              <button
                aria-selected={bookingFilters.status === tab.value}
                className={bookingFilters.status === tab.value ? "is-active" : ""}
                key={tab.value}
                onClick={() => changeBookingFilter("status", tab.value)}
                role="tab"
                type="button"
              >
                {tab.label} <span className="inspection-status-tabs__count">({tab.count})</span>
              </button>
            ))}
          </div>

          <InspectionBookingsTable
            bookings={workspace.bookings}
            canApproveBookings={canApproveBookings}
            canBook={canBook}
            filtered={hasBookingFilters}
            inspectors={workspace.inspectors}
            loading={workspace.bookingsLoading}
            onApproveReschedule={(booking, changeId) => void workspace.loadInspectors().then((loaded) => { if (loaded) setInspectorTask({ kind: "approve-change", booking, changeId }); })}
            onAssign={(booking) => void workspace.loadInspectors().then((loaded) => { if (loaded) setInspectorTask({ kind: "assign", booking }); })}
            onCancel={(target) => workspace.bookingDecision.request({ action: "cancel", booking: target })}
            onChangeInspector={(booking) => void workspace.loadInspectors().then((loaded) => { if (loaded) setInspectorTask({ kind: "change", booking }); })}
            onConfirmReschedule={(changeId) => void workspace.confirmInspectionBookingReschedule(changeId)}
            onDecline={(target) => workspace.bookingDecision.request({ action: "reject", booking: target })}
            onRequestReschedule={workspace.openReschedule}
            pendingAction={workspace.pendingAction}
          />

          <div className="inspection-booking-pagination">
            <label className="inspection-booking-pagesize">
              <span>Rows per page</span>
              <select
                aria-label="Bookings per page"
                onChange={(event) => workspace.setBookingPageSize(Number(event.target.value))}
                value={workspace.bookingPageSize}
              >
                {BOOKING_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            <p className="inspection-booking-count" role="status">{bookingCountLabel}</p>
            <div className="inspection-booking-pages" role="group" aria-label="Booking pages">
              <button aria-label="Previous page" disabled={workspace.bookingPage === 0} onClick={() => workspace.setBookingPage(workspace.bookingPage - 1)} type="button">‹</button>
              {pageNumbers.map((page) => (
                <button
                  aria-current={page === workspace.bookingPage ? "page" : undefined}
                  aria-label={`Page ${page + 1}`}
                  className={page === workspace.bookingPage ? "is-active" : ""}
                  key={page}
                  onClick={() => workspace.setBookingPage(page)}
                  type="button"
                >
                  {page + 1}
                </button>
              ))}
              <button aria-label="Next page" disabled={workspace.bookingPage >= pageCount - 1} onClick={() => workspace.setBookingPage(workspace.bookingPage + 1)} type="button">›</button>
            </div>
          </div>

          <ChangeInspectorDialog
            checkAvailability={(inspectorId) => workspace.checkInspectorAvailability(inspectorTask?.booking.id ?? "", inspectorId)}
            currentInspectorId={inspectorTask?.kind === "change" ? inspectorTask.booking.inspectorUserId : null}
            currentInspectorName={workspace.inspectors.find((inspector) => inspector.id === inspectorTask?.booking.inspectorUserId)?.displayName ?? "Not assigned"}
            inspectors={workspace.inspectors.map((inspector) => ({ id: inspector.id, name: inspector.displayName }))}
            onClose={() => setInspectorTask(null)}
            onSave={saveInspectorTask}
            open={inspectorTask !== null}
            saveLabel={inspectorTask?.kind === "change" ? "Save change" : "Assign inspector"}
            siteName={inspectorTask?.booking.location.name ?? ""}
            title={inspectorTask?.kind === "change" ? "Change inspector" : "Assign inspector"}
            verifyAvailability={inspectorTask?.kind === "change"}
            whenLabel={inspectorTask ? formatLocationDateTime(inspectorTask.booking.scheduledAt, inspectorTask.booking.location.schedulingTimezone) : undefined}
          />
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
