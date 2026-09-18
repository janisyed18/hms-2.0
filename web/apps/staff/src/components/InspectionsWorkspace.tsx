import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Clock3
} from "lucide-react";
import { useState } from "react";

import { InspectionDetail } from "./InspectionDetail";
import { InspectionBookingForm } from "./InspectionBookingForm";
import { InspectionForm } from "./InspectionForm";
import { ModuleTable, type ModuleColumn } from "./ModuleTable";
import {
  type InspectionStatusFilter,
  useInspectionsWorkspace
} from "../hooks/useInspectionsWorkspace";
import type { InspectionRecord } from "../domain/types";
import { StaggerGroup, StaggerItem } from "../motion/MotionPrimitives";

const statusFilters: Array<{ label: string; value: InspectionStatusFilter }> = [
  { label: "All", value: "ALL" },
  { label: "Submitted", value: "SUBMITTED" },
  { label: "Approved", value: "APPROVED" },
  { label: "Rejected", value: "REJECTED" },
  { label: "Draft", value: "DRAFT" }
];

function statusClass(status: string) {
  if (status === "DRAFT") {
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

export function InspectionsWorkspace({
  canApprove,
  canApproveBookings,
  canBook,
  canWrite,
  initialInspectionId,
  onInitialInspectionOpened
}: {
  canApprove: boolean;
  canApproveBookings: boolean;
  canBook: boolean;
  canWrite: boolean;
  initialInspectionId?: string | null;
  onInitialInspectionOpened?: () => void;
}) {
  const workspace = useInspectionsWorkspace(canApproveBookings, initialInspectionId, onInitialInspectionOpened);
  const [inspectorByBooking, setInspectorByBooking] = useState<Record<string, string>>({});
  const draftCount = countByStatus(workspace.inspections, "DRAFT");
  const submittedCount = countByStatus(workspace.inspections, "SUBMITTED");
  const approvedCount = countByStatus(workspace.inspections, "APPROVED");
  const attentionCount = workspace.inspections.filter((inspection) =>
    ["DRAFT", "REJECTED"].includes(inspection.status)
  ).length;

  const columns: ModuleColumn<InspectionRecord>[] = [
    {
      header: "Asset",
      render: (inspection) => <strong>{inspection.asset.assetNumber}</strong>
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
          {inspection.status}
        </span>
      )
    },
    {
      header: "Actions",
      render: (inspection) => (
        <span className="row-actions">
          <button
            aria-label={`Open inspection ${inspection.asset.assetNumber}`}
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
          <div className="inspection-command-context" aria-label="Current inspection scope">
            <ClipboardCheck aria-hidden="true" size={23} />
            <span>
              <strong>{workspace.inspections.length} inspection{workspace.inspections.length === 1 ? "" : "s"}</strong>
              <small>{workspace.visibleInspections.length} matching the current view</small>
            </span>
          </div>
        </header>
        <section aria-label="Inspection overview">
          <StaggerGroup className="inspection-metrics inspection-command-metrics">
            <InspectionMetric icon={ClipboardCheck} label="Draft" value={draftCount} detail="Awaiting completion" tone="blue" />
            <InspectionMetric icon={Clock3} label="Submitted" value={submittedCount} detail="Pending review" tone="amber" />
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
            {canBook ? (
              <button className="primary-button inspection-book-button" onClick={workspace.openBooking} type="button">
                <CalendarDays aria-hidden="true" size={17} />
                Book inspection
              </button>
            ) : null}
          </header>
          {workspace.bookings.length ? (
            <div className="inspection-booking-list" aria-label="Inspection bookings">
              {workspace.bookings.slice(0, 4).map((booking) => (
                <article className="inspection-booking-card" key={booking.id}>
                  <div>
                    <strong>{booking.location.name}</strong>
                    <span>{booking.customer.name}</span>
                  </div>
                  <div>
                    <span>{booking.assets.map((asset) => asset.assetNumber).join(", ")}</span>
                    <time dateTime={booking.scheduledAt}>
                      {new Date(booking.scheduledAt).toLocaleString()}
                    </time>
                  </div>
                  <span className={statusClass(booking.status)}>
                    {booking.status.replace("_", " ")}
                  </span>
                  {canApproveBookings && booking.status === "PENDING_APPROVAL" ? (
                    <span className="row-actions">
                      <select
                        aria-label={`Assign inspector for ${booking.location.name}`}
                        value={inspectorByBooking[booking.id] ?? ""}
                        onChange={(event) => setInspectorByBooking((current) => ({ ...current, [booking.id]: event.target.value }))}
                      >
                        <option value="">Assign inspector</option>
                        {workspace.inspectors.map((inspector) => (
                          <option key={inspector.id} value={inspector.id}>{inspector.displayName}</option>
                        ))}
                      </select>
                      <button
                        disabled={!inspectorByBooking[booking.id]}
                        onClick={() => void workspace.approveInspectionBooking(booking.id, inspectorByBooking[booking.id])}
                        type="button"
                      >
                        Assign & approve
                      </button>
                      <button onClick={() => void workspace.rejectInspectionBooking(booking.id)} type="button">
                        Decline
                      </button>
                    </span>
                  ) : null}
                </article>
              ))}
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
        {workspace.selectedInspection ? (
          <InspectionDetail
            canApprove={canApprove}
            canWrite={canWrite}
            inspection={workspace.selectedInspection}
            onApprove={workspace.approveInspection}
            onClose={workspace.closeDetail}
            onSaveDraft={workspace.saveInspectionUpdate}
            onSubmit={workspace.submitInspection}
          />
        ) : (
          <div className="inspection-table-wrap">
            <ModuleTable
              actionLabel={canWrite ? "Add Inspection" : undefined}
              actionsInToolbar
              className="inspection-register-table"
              columns={columns}
              countLabel={
                workspace.isLoading
                  ? "Loading inspections"
                  : `${workspace.visibleInspections.length} inspections`
              }
              emptyLabel="No inspections match the current filters."
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
              searchPlaceholder="Search inspections..."
              tableLabel="Inspection records"
              error={workspace.error}
            />
          </div>
        )}
      </div>

      {canWrite ? (
        <InspectionForm
          assetOptions={workspace.assetOptions}
          open={workspace.isFormOpen}
          onClose={() => workspace.setFormOpen(false)}
          onSubmit={workspace.saveInspection}
        />
      ) : null}
      {canBook ? (
        <InspectionBookingForm
          assetOptions={workspace.assetOptions}
          inspectors={workspace.inspectors}
          requiresInspector={canApproveBookings}
          open={workspace.isBookingFormOpen}
          onClose={() => workspace.setBookingFormOpen(false)}
          onSubmit={workspace.saveInspectionBooking}
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
