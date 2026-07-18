import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const pageSizes = [5, 10, 25, 50];

export function usePagination<TItem>(items: TItem[]) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(pageSizes[0]);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * pageSize;

  useEffect(() => setPage(1), [items]);

  return {
    items: useMemo(() => items.slice(start, start + pageSize), [items, pageSize, start]),
    page: currentPage,
    pageCount,
    pageSize,
    setPage,
    setPageSize: (size: number) => {
      setPageSize(size);
      setPage(1);
    },
    start,
    total: items.length
  };
}

export function PaginationControls({
  label,
  onPageChange,
  onPageSizeChange,
  page,
  pageCount,
  pageSize,
  start,
  total
}: {
  label: string;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  page: number;
  pageCount: number;
  pageSize: number;
  start: number;
  total: number;
}) {
  if (total <= pageSizes[0]) {
    return null;
  }

  const firstVisiblePage = Math.min(Math.max(page - 2, 1), Math.max(pageCount - 4, 1));
  const pages = Array.from(
    { length: Math.min(pageCount, 5) },
    (_, index) => firstVisiblePage + index
  );
  const end = Math.min(start + pageSize, total);

  return (
    <div className="dashboard-pagination data-pagination">
      <label className="dashboard-page-size">
        <span>Rows per page</span>
        <select aria-label={`${label} rows per page`} onChange={(event) => onPageSizeChange(Number(event.target.value))} value={pageSize}>
          {pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
      </label>
      <span className="dashboard-page-status">Page {page} of {pageCount}</span>
      <nav aria-label={`${label} pages`} className="dashboard-page-controls">
        <button aria-label={`Previous ${label} page`} disabled={page === 1 || total === 0} onClick={() => onPageChange(page - 1)} type="button">
          <ChevronLeft aria-hidden="true" size={16} />
        </button>
        {pages.map((number) => (
          <button
            aria-current={number === page ? "page" : undefined}
            aria-label={`${label} page ${number}`}
            className={number === page ? "is-active" : undefined}
            key={number}
            onClick={() => onPageChange(number)}
            type="button"
          >
            {number}
          </button>
        ))}
        <button aria-label={`Next ${label} page`} disabled={page === pageCount || total === 0} onClick={() => onPageChange(page + 1)} type="button">
          <ChevronRight aria-hidden="true" size={16} />
        </button>
      </nav>
      <span className="dashboard-page-summary">{total ? `${start + 1}-${end} of ${total}` : "No records"}</span>
    </div>
  );
}
