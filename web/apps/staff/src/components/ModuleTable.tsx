import { Download, Filter, Plus, Search } from "lucide-react";
import {
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from "react";

import { WorkspaceState } from "./WorkspaceState";

export interface ModuleColumn<TItem> {
  header: string;
  render: (item: TItem) => ReactNode;
}

interface ModuleTableProps<TItem> {
  actionLabel: string;
  columns: ModuleColumn<TItem>[];
  countLabel: string;
  emptyLabel: string;
  exportRows: (item: TItem) => string[];
  filterControls?: ReactNode;
  activeFilterCount?: number;
  getRowKey: (item: TItem) => string;
  items: TItem[];
  onAction: () => void;
  onRowSelect?: (item: TItem) => void;
  onQueryChange: (value: string) => void;
  query: string;
  searchLabel: string;
  searchPlaceholder: string;
  selectedRowKey?: string | null;
  source: "api" | "mock";
  tableLabel: string;
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

function isInteractiveTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    Boolean(
      target.closest(
        "a, button, input, select, textarea, label, summary, [role='button']"
      )
    )
  );
}

export function ModuleTable<TItem>({
  actionLabel,
  columns,
  countLabel,
  emptyLabel,
  exportRows,
  filterControls,
  activeFilterCount = 0,
  getRowKey,
  items,
  onAction,
  onRowSelect,
  onQueryChange,
  query,
  searchLabel,
  searchPlaceholder,
  selectedRowKey = null,
  source,
  tableLabel
}: ModuleTableProps<TItem>) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const exportData = [columns.map((column) => column.header), ...items.map(exportRows)];

  function handleRowClick(event: MouseEvent<HTMLTableRowElement>, item: TItem) {
    if (!onRowSelect || isInteractiveTarget(event.target)) {
      return;
    }
    onRowSelect(item);
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, item: TItem) {
    if (!onRowSelect || isInteractiveTarget(event.target)) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onRowSelect(item);
    }
  }

  return (
    <section className="table-panel module-panel" aria-label={tableLabel}>
      <div className="toolbar module-toolbar">
        <label className="field search-field">
          <Search aria-hidden="true" size={17} />
          <span className="sr-only">{searchLabel}</span>
          <input
            aria-label={searchLabel}
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>
        <label className="field select-field">
          <span>Source</span>
          <select value={source} onChange={() => undefined} aria-label={`${tableLabel} source`}>
            <option value="api">Backend</option>
            <option value="mock">Mock data</option>
          </select>
        </label>
        <button
          aria-expanded={filtersOpen}
          className="secondary-button"
          onClick={() => setFiltersOpen((current) => !current)}
          type="button"
        >
          <Filter aria-hidden="true" size={16} />
          Filters
          {activeFilterCount > 0 ? <span className="button-count">{activeFilterCount}</span> : null}
        </button>
      </div>

      {filtersOpen ? (
        <div className="filter-panel" aria-label={`${tableLabel} filters`}>
          <div className="filter-summary" role="status" aria-label={`${tableLabel} filter summary`}>
            <strong>Active view</strong>
            <span>Source: {source === "api" ? "Backend" : "Mock data"}</span>
            <span>Search: {query.trim() || "All records"}</span>
            <span>{activeFilterCount} active filters</span>
          </div>
          {filterControls ? <div className="filter-grid">{filterControls}</div> : null}
        </div>
      ) : null}

      <div className="table-actions">
        <span>{countLabel}</span>
        <div>
          <button className="primary-button" type="button" onClick={onAction}>
            <Plus aria-hidden="true" size={17} />
            {actionLabel}
          </button>
          <button
            className="icon-button light"
            aria-label={`Download ${tableLabel}`}
            onClick={() =>
              downloadCsv(
                `${tableLabel.toLowerCase().replaceAll(" ", "-")}.csv`,
                exportData
              )
            }
            type="button"
          >
            <Download size={17} />
          </button>
        </div>
      </div>

      <div className="table-frame">
        <table className="module-table" aria-label={tableLabel}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.header}>{column.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const rowKey = getRowKey(item);
              const isSelected = selectedRowKey === rowKey;
              return (
                <tr
                  aria-selected={isSelected || undefined}
                  className={`${onRowSelect ? "is-clickable" : ""}${isSelected ? " is-selected" : ""}`}
                  key={rowKey}
                  onClick={(event) => handleRowClick(event, item)}
                  onKeyDown={(event) => handleRowKeyDown(event, item)}
                  tabIndex={onRowSelect ? 0 : undefined}
                >
                  {columns.map((column) => (
                    <td key={column.header}>{column.render(item)}</td>
                  ))}
                </tr>
              );
            })}
            {items.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>
                  <WorkspaceState title="No records found">{emptyLabel}</WorkspaceState>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="pagination">
        <span>Rows per page</span>
        <button type="button">25</button>
        <span>1-{Math.max(items.length, 1)} of {items.length}</span>
      </div>
    </section>
  );
}
