import { Boxes, CheckCircle2, Download, Filter, History, MapPin, Plus, Search, UsersRound, X } from "lucide-react";
import { useState } from "react";
import { m, useReducedMotion } from "motion/react";

import { motionTokens } from "../motion/motionTokens";
import { PaginationControls } from "./Pagination";
import { WorkspaceState } from "./WorkspaceState";
import { ManagementHeader, ManagementMetric, ManagementMetricStrip } from "./ManagementPrimitives";
import type { CustomerRecord, CustomerSummary } from "../domain/types";
import type { CustomerLifecycleFilter } from "../hooks/useCustomerWorkspace";
import { initialsOf } from "../utils/identity";
import { ActionButton } from "./interaction/ActionButton";
import { FilterChips, activeFilterList, resultSummary } from "./ModuleTable";

interface CustomerTableProps {
  canWrite: boolean;
  /** The current page, already searched and filtered by the server. */
  customers: CustomerRecord[];
  /** How many customers match the search and filter across every page. */
  totalCount: number;
  /** System-wide totals, independent of the search, filter and page. */
  summary: CustomerSummary | null;
  selectedId: string | null;
  query: string;
  lifecycle: CustomerLifecycleFilter;
  page: number;
  pageSize: number;
  isLoading: boolean;
  onQueryChange: (value: string) => void;
  onLifecycleChange: (value: CustomerLifecycleFilter) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onSelectCustomer: (id: string) => void;
  onAddCustomer: () => void;
  /** Only offered to Super Admins: opens Deleted Customers (History). */
  onOpenHistory?: () => void;
}

function locationLabel(customer: CustomerRecord) {
  const primary = customer.locations[0];
  if (!primary) {
    return "No location";
  }
  return [primary.city, primary.country].filter(Boolean).join(", ");
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

const LIFECYCLE_LABELS: Record<CustomerLifecycleFilter, string> = { active: "Active", archived: "Archived", all: "All customers" };

export function CustomerTable({
  canWrite,
  customers,
  totalCount,
  summary,
  selectedId,
  query,
  lifecycle,
  page,
  pageSize,
  isLoading,
  onQueryChange,
  onLifecycleChange,
  onPageChange,
  onPageSizeChange,
  onSelectCustomer,
  onAddCustomer,
  onOpenHistory
}: CustomerTableProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const narrowed = query.trim().length > 0 || lifecycle !== "active";
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const exportRows = [
    ["Customer Name", "Code", "Location", "Sites", "Assets", "In service", "Status"],
    ...customers.map((customer) => [
      customer.name,
      customer.code,
      locationLabel(customer),
      String(customer.locations.length),
      String(customer.metrics.assetCount),
      String(customer.metrics.inServiceCount),
      customer.status
    ])
  ];

  return (
    <section className="customer-console management-workspace" aria-label="Customer workspace">
      <ManagementHeader
        eyebrow="Customer management"
        title="Customers"
        description="Manage customer accounts, locations, and fleet health at a glance."
        context={<><Boxes aria-hidden="true" size={20} /><span><strong>{summary ? summary.assets : "…"} total assets</strong><small>Across customer fleets</small></span></>}
      />
      <ManagementMetricStrip>
        <ManagementMetric icon={CheckCircle2} label="Active Customers" value={summary ? summary.activeCustomers : "…"} detail="Across the whole system" tone="green" />
        <ManagementMetric icon={UsersRound} label="Archived Customers" value={summary ? summary.archivedCustomers : "…"} detail="Kept with their history" />
        <ManagementMetric icon={MapPin} label="Total Sites" value={summary ? summary.locations : "…"} detail="Across all customers" tone="violet" />
        <ManagementMetric icon={Boxes} label="Total Assets" value={summary ? summary.assets : "…"} detail="In customer fleets" tone="amber" />
      </ManagementMetricStrip>
      <div className="customer-console-toolbar">
        <label className="field search-field">
          <Search aria-hidden="true" size={17} />
          <span className="sr-only">Search customers</span>
          <input
            aria-label="Search customers"
            placeholder="Search customers by name, code or city"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          {query ? (
            <button aria-label="Clear search" className="search-clear" onClick={() => onQueryChange("")} type="button">
              <X aria-hidden="true" size={15} />
            </button>
          ) : null}
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
          aria-label="Download this page of customers"
          onClick={() => downloadCsv("customers.csv", exportRows)}
          type="button"
        >
          <Download size={17} />
        </button>
        {onOpenHistory ? (
          <button className="secondary-button" onClick={onOpenHistory} type="button">
            <History aria-hidden="true" size={16} />
            Deleted customers
          </button>
        ) : null}
        {canWrite ? (
          <button className="primary-button" type="button" onClick={onAddCustomer}>
            <Plus aria-hidden="true" size={17} />
            Add customer
          </button>
        ) : null}
      </div>

      {filtersOpen ? (
        <div className="filter-summary customer-filter-summary" role="status" aria-label="Customer filter summary">
          <strong>Active view</strong>
          <label className="field select-field">
            <span>Show</span>
            <select
              aria-label="Customer status filter"
              value={lifecycle}
              onChange={(event) => onLifecycleChange(event.target.value as CustomerLifecycleFilter)}
            >
              {(Object.keys(LIFECYCLE_LABELS) as CustomerLifecycleFilter[]).map((value) => (
                <option key={value} value={value}>{LIFECYCLE_LABELS[value]}</option>
              ))}
            </select>
          </label>
          <span>Search: {query.trim() || "All customers"}</span>
        </div>
      ) : null}

      <FilterChips
        chips={activeFilterList([
          { id: "status", label: "Show", value: lifecycle !== "active" && LIFECYCLE_LABELS[lifecycle], onRemove: () => onLifecycleChange("active") }
        ])}
        onClearAll={() => onLifecycleChange("active")}
      />

      <div className="customer-count-row">
        <span aria-live="polite">{resultSummary({ fallback: `${totalCount} customers`, loadedCount: totalCount, narrowed, noun: "customers", shown: totalCount, totalCount })}</span>
      </div>

      <div aria-busy={isLoading} className="customer-card-grid">
        {customers.map((customer) => {
          const isSelected = customer.id === selectedId;

          return (
            <m.button
              aria-label={`Select customer ${customer.name}`}
              aria-pressed={isSelected}
              animate={
                reducedMotion
                  ? undefined
                  : { scale: isSelected ? 1.008 : 1, y: isSelected ? -3 : 0 }
              }
              className={`customer-card${isSelected ? " is-selected" : ""}`}
              key={customer.id}
              onClick={() => onSelectCustomer(customer.id)}
              type="button"
              transition={motionTokens.spring.gentle}
              whileHover={reducedMotion ? undefined : { y: isSelected ? -3 : -2 }}
              whileTap={reducedMotion ? undefined : { scale: 0.985 }}
            >
              <span className="customer-card-top">
                <span aria-hidden="true" className="customer-avatar">{initialsOf(customer.name) || customer.code.slice(0, 2)}</span>
                <span className="customer-card-state">
                  {isSelected ? (
                    <m.span
                      aria-hidden="true"
                      className="customer-selected-indicator"
                      initial={reducedMotion ? false : { opacity: 0, scale: 0.7 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={motionTokens.spring.snappy}
                    >
                      <CheckCircle2 size={16} />
                    </m.span>
                  ) : null}
                  <span className={`status-pill status-${customer.status.toLowerCase()}`}>
                    {customer.status}
                  </span>
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
                  <strong>{customer.metrics.inServiceCount}</strong>
                  <small>In service</small>
                </span>
                <span>
                  <strong>{customer.locations.length}</strong>
                  <small>{customer.locations.length === 1 ? "Site" : "Sites"}</small>
                </span>
              </span>
            </m.button>
          );
        })}
      </div>
      <PaginationControls
        label="Customer records"
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
        page={Math.min(page, pageCount)}
        pageCount={pageCount}
        pageSize={pageSize}
        start={(page - 1) * pageSize}
        total={totalCount}
      />
      {customers.length === 0 && !isLoading ? (
        narrowed ? (
          <WorkspaceState
            action={<ActionButton onClick={() => { onQueryChange(""); onLifecycleChange("active"); }} variant="secondary">Clear filters</ActionButton>}
            title="No matching customers"
          >
            {lifecycle !== "active" ? "Try changing your search or showing active customers." : "Try a different search."}
          </WorkspaceState>
        ) : (
          <WorkspaceState title="No customers yet">
            Customers appear here once they are added.{canWrite ? ' Use "Add customer" above to add the first.' : ""}
          </WorkspaceState>
        )
      ) : null}
    </section>
  );
}
