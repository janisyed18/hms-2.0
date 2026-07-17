import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock3
} from "lucide-react";

import { InspectionDetail } from "./InspectionDetail";
import { InspectionForm } from "./InspectionForm";
import { ModuleTable, type ModuleColumn } from "./ModuleTable";
import {
  type InspectionStatusFilter,
  useInspectionsWorkspace
} from "../hooks/useInspectionsWorkspace";
import type { InspectionRecord } from "../domain/types";

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
  if (status === "SUBMITTED") {
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
  canWrite,
  initialInspectionId,
  onInitialInspectionOpened
}: {
  canApprove: boolean;
  canWrite: boolean;
  initialInspectionId?: string | null;
  onInitialInspectionOpened?: () => void;
}) {
  const workspace = useInspectionsWorkspace(initialInspectionId, onInitialInspectionOpened);
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
    <section className="inspection-workspace" aria-label="Inspection workspace">
      <div className="inspection-dashboard">
        <div className="inspection-dashboard-heading">
          <div>
            <h2>Inspection Queue</h2>
            <p>Review draft inspections, pressure tests, and approval readiness.</p>
          </div>
        </div>
        <div className="inspection-metrics" aria-label="Inspection metrics">
          <div>
            <ClipboardCheck aria-hidden="true" size={18} />
            <span>Draft</span>
            <strong>{draftCount}</strong>
          </div>
          <div>
            <Clock3 aria-hidden="true" size={18} />
            <span>Submitted</span>
            <strong>{submittedCount}</strong>
          </div>
          <div>
            <CheckCircle2 aria-hidden="true" size={18} />
            <span>Approved</span>
            <strong>{approvedCount}</strong>
          </div>
          <div>
            <AlertTriangle aria-hidden="true" size={18} />
            <span>Attention</span>
            <strong>{attentionCount}</strong>
          </div>
        </div>
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
              source={workspace.source}
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
    </section>
  );
}
