import { Download, Filter, Plus, Search } from "lucide-react";
import { useState } from "react";

import { WorkspaceState } from "./WorkspaceState";
import type { CustomerRecord } from "../domain/types";

interface CustomerTableProps {
  customers: CustomerRecord[];
  totalCount: number;
  selectedId: string | null;
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
  customers,
  totalCount,
  selectedId,
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
    <section className="table-panel" aria-label="Customer workspace">
      <div className="toolbar">
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
          <span>Risk Level</span>
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
        <label className="field select-field">
          <span>Inspection Due</span>
          <select defaultValue="All">
            <option>All</option>
            <option>Overdue</option>
            <option>Due Soon</option>
            <option>Current</option>
          </select>
        </label>
        <label className="field select-field">
          <span>Certificate Status</span>
          <select defaultValue="All">
            <option>All</option>
            <option>Valid</option>
            <option>Review</option>
          </select>
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
      </div>

      {filtersOpen ? (
        <div className="filter-summary" role="status" aria-label="Customer filter summary">
          <strong>Active view</strong>
          <span>Status: {statusFilter}</span>
          <span>Risk: {riskFilter}</span>
          <span>Search: {query.trim() || "All customers"}</span>
        </div>
      ) : null}

      <div className="table-actions">
        <span>{totalCount} customers</span>
        <div>
          <button className="primary-button" type="button" onClick={onAddCustomer}>
            <Plus aria-hidden="true" size={17} />
            Add Customer
          </button>
          <button
            className="icon-button light"
            aria-label="Download customer list"
            onClick={() => downloadCsv("customers.csv", exportRows)}
            type="button"
          >
            <Download size={17} />
          </button>
        </div>
      </div>

      <div className="table-frame">
        <table aria-label="Customer records">
          <thead>
            <tr>
              <th aria-label="Select row" />
              <th>Customer Name</th>
              <th>Location</th>
              <th>Assets</th>
              <th>Inspection Due</th>
              <th>Certificate Status</th>
              <th>Risk Level</th>
              <th>Last Activity</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((customer) => (
              <tr
                className={customer.id === selectedId ? "is-selected" : ""}
                key={customer.id}
                tabIndex={0}
                onClick={() => onSelectCustomer(customer.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    onSelectCustomer(customer.id);
                  }
                }}
              >
                <td>
                  <span className="row-check" aria-hidden="true" />
                </td>
                <td>
                  <strong>{customer.name}</strong>
                </td>
                <td>{locationLabel(customer)}</td>
                <td>{customer.metrics.assetCount}</td>
                <td className={inspectionClass(customer.metrics.inspectionDueLabel)}>
                  {customer.metrics.inspectionDueLabel}
                </td>
                <td className="success-text">{customer.metrics.certificateStatusLabel}</td>
                <td>
                  <span className={riskClass(customer.riskLevel)}>{customer.riskLevel}</span>
                </td>
                <td>{customer.lastActivity}</td>
              </tr>
            ))}
            {customers.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <WorkspaceState title="No customers found">
                    Adjust the search text or filters to expand the current view.
                  </WorkspaceState>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="pagination">
        <span>Rows per page</span>
        <button type="button">10</button>
        <nav aria-label="Customer pages">
          <button className="is-active" type="button">1</button>
          <button type="button">2</button>
          <button type="button">3</button>
          <button type="button">4</button>
          <button type="button">5</button>
        </nav>
        <span>1-10 of {totalCount}</span>
      </div>
    </section>
  );
}
