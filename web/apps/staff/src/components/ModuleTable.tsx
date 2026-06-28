import { Download, Filter, Plus, Search } from "lucide-react";
import type { ReactNode } from "react";

export interface ModuleColumn<TItem> {
  header: string;
  render: (item: TItem) => ReactNode;
}

interface ModuleTableProps<TItem> {
  actionLabel: string;
  columns: ModuleColumn<TItem>[];
  countLabel: string;
  emptyLabel: string;
  getRowKey: (item: TItem) => string;
  items: TItem[];
  onAction: () => void;
  onQueryChange: (value: string) => void;
  query: string;
  searchLabel: string;
  searchPlaceholder: string;
  source: "api" | "mock";
  tableLabel: string;
}

export function ModuleTable<TItem>({
  actionLabel,
  columns,
  countLabel,
  emptyLabel,
  getRowKey,
  items,
  onAction,
  onQueryChange,
  query,
  searchLabel,
  searchPlaceholder,
  source,
  tableLabel
}: ModuleTableProps<TItem>) {
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
        <button className="secondary-button" type="button">
          <Filter aria-hidden="true" size={16} />
          Filters
        </button>
      </div>

      <div className="table-actions">
        <span>{countLabel}</span>
        <div>
          <button className="primary-button" type="button" onClick={onAction}>
            <Plus aria-hidden="true" size={17} />
            {actionLabel}
          </button>
          <button className="icon-button light" aria-label={`Download ${tableLabel}`} type="button">
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
            {items.map((item) => (
              <tr key={getRowKey(item)}>
                {columns.map((column) => (
                  <td key={column.header}>{column.render(item)}</td>
                ))}
              </tr>
            ))}
            {items.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>{emptyLabel}</td>
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
