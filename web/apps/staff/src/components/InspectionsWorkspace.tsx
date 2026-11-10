import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Clock3
} from "lucide-react";
import { useEffect, useState } from "react";

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
import type { InspectionRecord } from "../domain/types";
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

function countByStatus(inspections: InspectionRecord[], status: string) {
  return inspections.filter((inspection) => inspection.status === status).length;
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
  onInspectionRouteChange
}: {
  canApprove: boolean;
  canApproveBookings: boolean;
  canBook: boolean;
  canWrite: boolean;
  routeInspectionId?: string | null;
  onInspectionRouteChange?: (inspectionId: string | null, options?: { replace?: boolean }) => void;
}) {
  const workspace = useInspectionsWorkspace(canApproveBookings, routeInspectionId, onInspectionRouteChange);
  /** The booking whose inspector the open "Change inspector" dialog is for. */
  const [changingInspector, setChangingInspector] = useState<string | null>(null);
  const [showAllBookings, setShowAllBookings] = useState(false);
  // The assigned inspector's name needs the inspector list, so it is loaded once a confirmed booking is on screen.
  const hasConfirmedBooking = workspace.bookings.some((booking) => booking.status === "APPROVED" && booking.appointment?.status === "CONFIRMED");
  const { loadInspectors } = workspace;
  useEffect(() => {
    if (canApproveBookings && hasConfirmedBooking) void loadInspectors();
    // loadInspectors is recreated each render; the list is loaded once, and only when needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canApproveBookings, hasConfirmedBooking]);
  const changingBooking = workspace.bookings.find((booking) => booking.id === changingInspector) ?? null;
  const draftCount =
    countByStatus(workspace.inspections, "DRAFT") + countByStatus(workspace.inspections, "IN_PROGRESS");
  const submittedCount = countByStatus(workspace.inspections, "SUBMITTED");
  const approvedCount = countByStatus(workspace.inspections, "APPROVED");
  const attentionCount = workspace.inspections.filter((inspection) =>
    ["DRAFT", "IN_PROGRESS", "REJECTED"].includes(inspection.status)
  ).length;

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
                <strong>{workspace.inspections.length} inspection{workspace.inspections.length === 1 ? "" : "s"}</strong>
                <small>{workspace.visibleInspections.length} matching the current view</small>
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
        {workspace.notice ? (
          <ActionNotice kind={workspace.notice.kind} onDismiss={workspace.dismissNotice} title={workspace.notice.title}>
            {workspace.notice.message}
          </ActionNotice>
        ) : null}
        <section aria-label="Inspection overview">
          <StaggerGroup className="inspection-metrics inspection-command-metrics">
            <InspectionMetric icon={ClipboardCheck} label="Draft" value={draftCount} detail="Awaiting completion" tone="blue" />
            <InspectionMetric icon={Clock3} label="Awaiting review" value={submittedCount} detail="Waiting for a reviewer" tone="amber" />
            <InspectionMetric icon={CheckCircle2} label="Approved" value={approvedCount} detail="Ready for records" tone="green" />
            <InspectionMetric icon={AlertTriangle} label="Attention" value={attentionCount} detail="Draft or rejected work" tone="red" />
          </StaggerGroup>
        </section>
        <section className="inspection-bookings-panel" aria-labelledby="inspection-bookings-heading">
          <header className="inspection-bookings-heading">
            <div className="inspection-bookings-title">
              <span className="inspection-bookings-icon"><CalendarDays aria-hidden="true" size={20} /></span>
              <div>
                <h3 id="inspection-bookings-heading">Inspection bookings</h3>
                <p>Schedule site visits before per-asset inspection work begins.</p>
              </div>
            </div>
          </header>
          {workspace.bookings.length ? (
            <div className="inspection-booking-list" aria-label="Inspection bookings">
              {(showAllBookings ? workspace.bookings : workspace.bookings.slice(0, 4)).map((booking) => (
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
              {!showAllBookings && workspace.bookings.length > 4 ? (
                <button className="secondary-button compact-action" onClick={() => setShowAllBookings(true)} type="button">
                  {`Show all ${workspace.bookings.length} loaded bookings`}
                </button>
              ) : null}
              {showAllBookings && workspace.bookingTotal > workspace.bookings.length ? (
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
              <span><strong>No inspection bookings are scheduled.</strong> Book a site visit to coordinate inspection work.</span>
            </p>
          )}
        </section>
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
      </div>

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
