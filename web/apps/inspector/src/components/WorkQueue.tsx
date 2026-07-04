import { Search, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import type { OutboxOperation, WorkItem } from "../domain/types";
import { StatusPill } from "./StatusPill";

interface WorkQueueProps {
  workItems: WorkItem[];
  outbox: OutboxOperation[];
  onOpenWorkItem: (item: WorkItem) => void;
}

type WorkFilter = "all" | "overdue" | "due-today" | "draft";

function urgencyLabel(item: WorkItem) {
  switch (item.urgency) {
    case "overdue":
      return { tone: "danger" as const, label: "Overdue retest" };
    case "due-today":
      return { tone: "warning" as const, label: "Due today" };
    case "draft":
      return { tone: "info" as const, label: "Draft saved" };
    case "synced":
      return { tone: "success" as const, label: "Synced" };
  }
}

function matchesFilter(item: WorkItem, filter: WorkFilter) {
  if (filter === "all") {
    return true;
  }

  if (filter === "draft") {
    return item.urgency === "draft" || item.inspectionStatus === "DRAFT";
  }

  return item.urgency === filter;
}

function matchesQuery(item: WorkItem, query: string) {
  if (!query.trim()) {
    return true;
  }

  const normalizedQuery = query.trim().toLowerCase();
  return [
    item.assetNumber,
    item.customerName,
    item.productName,
    item.locationName ?? ""
  ].some((value) => value.toLowerCase().includes(normalizedQuery));
}

export function WorkQueue({ workItems, outbox, onOpenWorkItem }: WorkQueueProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<WorkFilter>("all");
  const pendingCount = outbox.filter(
    (operation) => operation.status !== "applied"
  ).length;
  const visibleItems = useMemo(
    () =>
      workItems.filter(
        (item) => matchesFilter(item, filter) && matchesQuery(item, query)
      ),
    [filter, query, workItems]
  );

  const filters: Array<{ id: WorkFilter; label: string }> = [
    { id: "all", label: "All" },
    { id: "overdue", label: "Overdue" },
    { id: "due-today", label: "Due today" },
    { id: "draft", label: "Drafts" }
  ];

  return (
    <section className="screen-stack" aria-label="Work queue">
      <div className="metrics-grid">
        <article className="metric-card">
          <span>Assigned</span>
          <strong>{workItems.length}</strong>
        </article>
        <article className="metric-card">
          <span>Queued</span>
          <strong>{pendingCount}</strong>
        </article>
      </div>

      <label className="search-field">
        <Search aria-hidden="true" size={18} />
        <span className="sr-only">Search work</span>
        <input
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search asset or customer"
          value={query}
        />
        <SlidersHorizontal aria-hidden="true" size={18} />
      </label>

      <div className="filter-row" aria-label="Work filters">
        {filters.map((item) => (
          <button
            aria-pressed={filter === item.id}
            className={
              filter === item.id ? "filter-chip filter-chip--active" : "filter-chip"
            }
            key={item.id}
            onClick={() => setFilter(item.id)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="work-list">
        {visibleItems.length === 0 ? (
          <article className="empty-state">
            <Search aria-hidden="true" size={28} />
            <h2>No matching work</h2>
            <p>Adjust search or filters to return assigned inspections.</p>
          </article>
        ) : (
          visibleItems.map((item) => {
            const status = urgencyLabel(item);
            return (
              <article className="work-card" key={item.assetId}>
                <div className="work-card__top">
                  <div>
                    <h2>{item.assetNumber}</h2>
                    <p>{item.customerName}</p>
                  </div>
                  <StatusPill tone={status.tone}>{status.label}</StatusPill>
                </div>
                <dl className="work-meta">
                  <div>
                    <dt>Product</dt>
                    <dd>{item.productName}</dd>
                  </div>
                  <div>
                    <dt>Location</dt>
                    <dd>{item.locationName ?? "Unassigned"}</dd>
                  </div>
                </dl>
                <button
                  aria-label={`Open ${item.assetNumber}`}
                  className="primary-action"
                  onClick={() => onOpenWorkItem(item)}
                  type="button"
                >
                  Open inspection
                </button>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
