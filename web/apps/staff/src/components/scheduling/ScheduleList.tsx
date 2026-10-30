import { useMemo, useState } from "react";

import {
  STATUS_META,
  durationMinutes,
  formatDuration,
  type ScheduleEntry
} from "../../scheduling/scheduleModel";
import { formatDateTime } from "../../scheduling/zonedTime";
import { PaginationControls, usePagination } from "../Pagination";

export function ScheduleList({
  entries,
  onSelect
}: {
  entries: ScheduleEntry[];
  onSelect: (entry: ScheduleEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) =>
      [
        entry.customerName,
        entry.locationName,
        entry.inspectorName,
        STATUS_META[entry.status].label,
        ...entry.booking.assets.flatMap((asset) => [asset.assetNumber, asset.assetName ?? ""])
      ].some((value) => value.toLowerCase().includes(needle))
    );
  }, [entries, query]);
  const pagination = usePagination(matching);

  return (
    <div className="schedule-list">
      <label className="schedule-search">
        <span>Search visits</span>
        <input
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Customer, location, inspector or asset"
          type="search"
          value={query}
        />
      </label>
      {matching.length === 0 ? (
        <p className="schedule-empty schedule-empty--inline" role="status">
          <strong>{entries.length === 0 ? "No inspections in this period" : "No visits match your search"}</strong>
        </p>
      ) : (
        <div className="schedule-list__table">
          <table aria-label="Scheduled inspections">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Customer</th>
                <th scope="col">Location</th>
                <th scope="col">Inspector</th>
                <th scope="col">Assets</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {pagination.items.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <time dateTime={entry.booking.scheduledAt}>
                      {formatDateTime(entry.start, entry.timeZone)}
                    </time>
                    <small>{formatDuration(durationMinutes(entry))}</small>
                  </td>
                  <td>{entry.customerName}</td>
                  <td>{entry.locationName}</td>
                  <td>{entry.inspectorName}</td>
                  <td>{entry.assetCount}</td>
                  <td>
                    <span className={`schedule-status status-${entry.status}`}>
                      {STATUS_META[entry.status].label}
                    </span>
                  </td>
                  <td>
                    <button
                      aria-label={`Open ${entry.customerName} at ${entry.locationName}, ${formatDateTime(entry.start, entry.timeZone)}`}
                      onClick={() => onSelect(entry)}
                      type="button"
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {matching.length > 0 ? (
        <PaginationControls
          label="Scheduled inspections"
          onPageChange={pagination.setPage}
          onPageSizeChange={pagination.setPageSize}
          page={pagination.page}
          pageCount={pagination.pageCount}
          pageSize={pagination.pageSize}
          start={pagination.start}
          total={pagination.total}
        />
      ) : null}
    </div>
  );
}
