import { Download, Filter, Plus, Search, X } from "lucide-react";
import {
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from "react";

import { WorkspaceState } from "./WorkspaceState";
import { PresencePanel } from "../motion/MotionPrimitives";
import { PaginationControls, usePagination } from "./Pagination";
import { ActionButton } from "./interaction/ActionButton";

/** One filter that is narrowing the list right now, and how to take it off. */
export interface ActiveFilter {
  id: string;
  label: string;
  value: string;
  onRemove: () => void;
}

export interface ModuleColumn<TItem> {
  header: string;
  render: (item: TItem) => ReactNode;
}

interface ModuleTableProps<TItem> {
  actionLabel?: string;
  /** "secondary" where the page has another, more important action (Inspections: booking is the main one). */
  actionVariant?: "primary" | "secondary";
  actionsInToolbar?: boolean;
  className?: string;
  columns: ModuleColumn<TItem>[];
  countLabel: string;
  emptyLabel: string;
  exportRows: (item: TItem) => string[];
  filterControls?: ReactNode;
  activeFilterCount?: number;
  /** The filters narrowing the list (label and value), each removable. Takes the place of a bare count. */
  activeFilters?: ActiveFilter[];
  /** Removes every filter (not the search text). */
  onClearFilters?: () => void;
  /** What the records are called, plural and lower-case ("assets"): used in counts and empty states. */
  noun?: string;
  /** How many records exist on the server, when the API said, and how many of them this list holds: together they let the count be honest about a partial list. */
  totalCount?: number;
  loadedCount?: number;
  /** What an empty list means, and what to do (shown when nothing has been added yet). */
  emptyHint?: string;
  error?: string | null;
  filtersInitiallyOpen?: boolean;
  getRowKey: (item: TItem) => string;
  items: TItem[];
  loading?: boolean;
  onAction?: () => void;
  onRowSelect?: (item: TItem) => void;
  onQueryChange: (value: string) => void;
  query: string;
  searchLabel: string;
  searchPlaceholder: string;
  selectedRowKey?: string | null;
  tableLabel: string;
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function downloadCsv(filename: string, rows: string[][]) {
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
  actionVariant = "primary",
  actionsInToolbar = false,
  className,
  columns,
  countLabel,
  emptyLabel,
  exportRows,
  filterControls,
  activeFilterCount = 0,
  activeFilters,
  onClearFilters,
  noun,
  totalCount,
  loadedCount,
  emptyHint,
  error = null,
  filtersInitiallyOpen = false,
  getRowKey,
  items,
  loading = false,
  onAction,
  onRowSelect,
  onQueryChange,
  query,
  searchLabel,
  searchPlaceholder,
  selectedRowKey = null,
  tableLabel
}: ModuleTableProps<TItem>) {
  const [filtersOpen, setFiltersOpen] = useState(filtersInitiallyOpen);
  const searchInput = useRef<HTMLInputElement>(null);
  const pagination = usePagination(items);
  const exportData = [columns.map((column) => column.header), ...items.map(exportRows)];
  const chips = activeFilters ?? [];
  const narrowed = query.trim().length > 0 || chips.length > 0 || activeFilterCount > 0;
  const summary = noun ? resultSummary({ narrowed, noun, shown: items.length, totalCount, loadedCount, fallback: countLabel }) : countLabel;
  function clearView() {
    onQueryChange("");
    onClearFilters?.();
  }
  const tableActions = (
    <>
      {actionLabel && onAction ? (
        <button className={actionVariant === "secondary" ? "secondary-button" : "primary-button"} type="button" onClick={onAction}>
          <Plus aria-hidden="true" size={17} />
          {actionLabel}
        </button>
      ) : null}
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
    </>
  );

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
    <section className={`table-panel module-panel${className ? ` ${className}` : ""}`} aria-label={tableLabel}>
      <div className={`toolbar module-toolbar${actionsInToolbar ? " module-toolbar--inline-actions" : ""}`}>
        <label className="field search-field">
          <Search aria-hidden="true" size={17} />
          <span className="sr-only">{searchLabel}</span>
          <input
            aria-label={searchLabel}
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            ref={searchInput}
          />
          {query ? (
            <button
              aria-label="Clear search"
              className="search-clear"
              onClick={() => { onQueryChange(""); searchInput.current?.focus(); }}
              type="button"
            >
              <X aria-hidden="true" size={15} />
            </button>
          ) : null}
        </label>
        <div className="module-toolbar-actions">
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
          {actionsInToolbar ? tableActions : null}
        </div>
      </div>

      {filtersOpen ? (
        <PresencePanel presenceKey="filters">
          <div className="filter-panel" aria-label={`${tableLabel} filters`}>
            <div className="filter-summary" role="status" aria-label={`${tableLabel} filter summary`}>
              <strong>Active view</strong>
              <span>Search: {query.trim() || "All records"}</span>
              <span>{activeFilterCount} active filters</span>
            </div>
            {filterControls ? <div className="filter-grid">{filterControls}</div> : null}
          </div>
        </PresencePanel>
      ) : null}

      <FilterChips chips={chips} onClearAll={onClearFilters} />

      <div className="table-actions">
        <span aria-live="polite">{summary}</span>
        {!actionsInToolbar ? <div>{tableActions}</div> : null}
      </div>

      <div className="table-frame">
        {loading ? (
          <WorkspaceState title="Loading records" tone="loading">
            Fetching the latest {tableLabel.toLowerCase()}.
          </WorkspaceState>
        ) : error ? (
          <WorkspaceState title="Records unavailable" tone="error">
            {error}
          </WorkspaceState>
        ) : (
          <table className="module-table" aria-label={tableLabel}>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.header}>{column.header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pagination.items.map((item) => {
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
                    {noun ? (
                      narrowed ? (
                        <WorkspaceState
                          action={<ActionButton onClick={clearView} variant="secondary">Clear filters</ActionButton>}
                          title={`No matching ${noun}`}
                        >
                          {chips.length > 0 || activeFilterCount > 0
                            ? "Try changing your search or clearing one of the active filters."
                            : "Try a different search."}
                        </WorkspaceState>
                      ) : (
                        <WorkspaceState title={`No ${noun} yet`}>
                          {/* The add action is already the button above; the message points at it rather than repeating it. */}
                          {emptyHint ?? emptyLabel}
                          {actionLabel && onAction ? ` Use "${actionLabel}" above to add the first.` : ""}
                        </WorkspaceState>
                      )
                    ) : (
                      <WorkspaceState title="No records found">{emptyLabel}</WorkspaceState>
                    )}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
      </div>
      <PaginationControls
        label={tableLabel}
        onPageChange={pagination.setPage}
        onPageSizeChange={pagination.setPageSize}
        page={pagination.page}
        pageCount={pagination.pageCount}
        pageSize={pagination.pageSize}
        start={pagination.start}
        total={pagination.total}
      />
    </section>
  );
}

/** "8 matching assets", "50 of 130 assets loaded": never a total the page does not hold. */
export function resultSummary({
  fallback,
  loadedCount,
  narrowed,
  noun,
  shown,
  totalCount
}: {
  fallback: string;
  loadedCount?: number;
  narrowed: boolean;
  noun: string;
  shown: number;
  totalCount?: number;
}): string {
  const partial = totalCount !== undefined && loadedCount !== undefined && totalCount > loadedCount;
  if (narrowed) return partial ? `${shown} matching ${noun} (searching the ${loadedCount} of ${totalCount} loaded)` : `${shown} matching ${noun}`;
  if (partial) return `${loadedCount} of ${totalCount} ${noun} loaded`;
  return fallback;
}

/** The filters that are on: entries with no value are off and are left out. */
export function activeFilterList(
  entries: Array<{ id: string; label: string; value: string | null | false | undefined; onRemove: () => void }>
): ActiveFilter[] {
  return entries.flatMap((entry) => (entry.value ? [{ id: entry.id, label: entry.label, value: entry.value, onRemove: entry.onRemove }] : []));
}

/** The filters that are narrowing a list, each removable, with how many and a way to clear them all. */
export function FilterChips({ chips, onClearAll }: { chips: ActiveFilter[]; onClearAll?: () => void }) {
  if (chips.length === 0) return null;
  return (
    <div aria-label="Active filters" className="filter-chips" role="group">
      {chips.map((chip) => (
        <span className="filter-chip" key={chip.id}>
          <span>{chip.label}: <strong>{chip.value}</strong></span>
          <button aria-label={`Remove filter ${chip.label}: ${chip.value}`} onClick={chip.onRemove} type="button">
            <X aria-hidden="true" size={13} />
          </button>
        </span>
      ))}
      <span className="filter-chips__count">{chips.length} {chips.length === 1 ? "filter" : "filters"} active</span>
      {onClearAll ? <button className="filter-chips__clear" onClick={onClearAll} type="button">Clear all</button> : null}
    </div>
  );
}
