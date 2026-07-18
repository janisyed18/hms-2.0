import { CheckCircle2, ChevronDown, Download, Filter, Plus, Search } from "lucide-react";
import { useState } from "react";

import { PresencePanel } from "../motion/MotionPrimitives";
import { PaginationControls, usePagination } from "./Pagination";
import { WorkspaceState } from "./WorkspaceState";
import type { CustomerRecord } from "../domain/types";

interface CustomerTableProps {
  canWrite: boolean;
  customers: CustomerRecord[];
  totalCount: number;
  selectedId: string | null;
  selectedCustomerName: string | null;
  query: string;
  riskFilter: string;
  statusFilter: string;
  onQueryChange: (value: string) => void;
  onRiskFilterChange: (value: string) => void;
  onStatusFilterChange: (value: string) => void;
  onSelectCustomer: (id: string) => void;
  onAddCustomer: () => void;
}

function locationLabel(customer: CustomerRecord) {
  const primary = customer.locations[0];
  if (!primary) {
    return "No location";
  }
  return [primary.city, primary.country].filter(Boolean).join(", ");
}

function riskClass(risk: string) {
  return `status-pill risk-${risk.toLowerCase()}`;
}

function inspectionClass(label: string) {
  if (label.includes("Overdue")) {
    return "danger-text";
  }
  if (label.includes("Due Soon")) {
    return "warning-text";
  }
  return "success-text";
}

function inspectionShortLabel(label: string) {
  if (label.includes("Overdue")) {
    return "Overdue";
  }
  if (label.includes("Due")) {
    return "Due";
  }
  return "Current";
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function CustomerTable({
  canWrite,
  customers,
  totalCount,
  selectedId,
  selectedCustomerName,
  query,
  riskFilter,
  statusFilter,
  onQueryChange,
  onRiskFilterChange,
  onStatusFilterChange,
  onSelectCustomer,
  onAddCustomer
}: CustomerTableProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const pagination = usePagination(customers);
  const exportRows = [
    [
      "Customer Name",
      "Location",
      "Assets",
      "Inspection Due",
      "Certificate Status",
      "Risk Level",
      "Last Activity"
    ],
    ...customers.map((customer) => [
      customer.name,
      locationLabel(customer),
      String(customer.metrics.assetCount),
      customer.metrics.inspectionDueLabel,
      customer.metrics.certificateStatusLabel,
      customer.riskLevel,
      customer.lastActivity
    ])
  ];

  return (
    <section className="customer-console" aria-label="Customer workspace">
      <div className="customer-console-toolbar">
        <label className="field search-field">
          <Search aria-hidden="true" size={17} />
          <span className="sr-only">Search customers</span>
          <input
            aria-label="Search customers"
            placeholder="Search customers..."
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>
        <button
          aria-expanded={filtersOpen}
          className="secondary-button"
          onClick={() => setFiltersOpen((current) => !current)}
          type="button"
        >
          <Filter aria-hidden="true" size={16} />
          More Filters
        </button>
        <button
          className="icon-button light"
          aria-label="Download customer list"
          onClick={() => downloadCsv("customers.csv", exportRows)}
          type="button"
        >
          <Download size={17} />
        </button>
        {canWrite ? (
          <button className="primary-button" type="button" onClick={onAddCustomer}>
            <Plus aria-hidden="true" size={17} />
            Add Customer
          </button>
        ) : null}
      </div>

      {filtersOpen ? (
        <div className="filter-summary customer-filter-summary" role="status" aria-label="Customer filter summary">
          <strong>Active view</strong>
          <label className="field select-field">
            <span>Status</span>
            <select
              value={statusFilter}
              onChange={(event) => onStatusFilterChange(event.target.value)}
            >
              <option>All</option>
              <option>Active</option>
              <option>Review</option>
              <option>Paused</option>
            </select>
          </label>
          <label className="field select-field">
            <span>Risk</span>
            <select
              value={riskFilter}
              onChange={(event) => onRiskFilterChange(event.target.value)}
            >
              <option>All</option>
              <option>High</option>
              <option>Medium</option>
              <option>Low</option>
            </select>
          </label>
          <span>Search: {query.trim() || "All customers"}</span>
        </div>
      ) : null}

      <div className="customer-count-row">
        <span>{totalCount} customers</span>
      </div>

      <div className="customer-card-grid">
        {pagination.items.map((customer) => (
          <button
            aria-label={`Select customer ${customer.name}`}
            aria-pressed={customer.id === selectedId}
            className={`customer-card${customer.id === selectedId ? " is-selected" : ""}`}
            key={customer.id}
            onClick={() => onSelectCustomer(customer.id)}
            type="button"
          >
            <span className="customer-card-top">
              <span className="customer-avatar">{customer.code.slice(0, 2)}</span>
              <span className={`status-pill status-${customer.status.toLowerCase()}`}>
                {customer.status}
              </span>
            </span>
            <span className="customer-name">{customer.name}</span>
            <span className="customer-code">{customer.code}</span>
            <span className="customer-location">{locationLabel(customer)}</span>
            <span className="customer-metrics">
              <span>
                <strong>{customer.metrics.assetCount}</strong>
                <small>Assets</small>
              </span>
              <span>
                <strong className={inspectionClass(customer.metrics.inspectionDueLabel)}>
                  {customer.metrics.inspectionDueCount}
                </strong>
                <small>{inspectionShortLabel(customer.metrics.inspectionDueLabel)}</small>
              </span>
              <span>
                <strong>{customer.locations.length}</strong>
                <small>{customer.locations.length === 1 ? "Site" : "Sites"}</small>
              </span>
            </span>
            <span className={riskClass(customer.riskLevel)}>{customer.riskLevel} Risk</span>
          </button>
        ))}
      </div>
      <PaginationControls
        label="Customer records"
        onPageChange={pagination.setPage}
        onPageSizeChange={pagination.setPageSize}
        page={pagination.page}
        pageCount={pagination.pageCount}
        pageSize={pagination.pageSize}
        start={pagination.start}
        total={pagination.total}
      />
      {selectedId && selectedCustomerName ? (
        <div
          aria-label="Customer selection"
          className="customer-selection-status"
          role="status"
        >
          <PresencePanel
            className="customer-selection-banner"
            presenceKey={selectedId}
          >
            <span className="customer-selection-icon">
              <CheckCircle2 aria-hidden="true" size={18} />
            </span>
            <span className="customer-selection-copy">
              <strong>Customer selected</strong>
              <span>{selectedCustomerName} details are shown below.</span>
            </span>
            <ChevronDown aria-hidden="true" className="customer-selection-arrow" size={18} />
          </PresencePanel>
        </div>
      ) : null}
      {customers.length === 0 ? (
        <WorkspaceState title="No customers found">
          Adjust the search text or filters to expand the current view.
        </WorkspaceState>
      ) : null}
    </section>
  );
}
