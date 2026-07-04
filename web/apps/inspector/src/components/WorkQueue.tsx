import { Search, SlidersHorizontal } from "lucide-react";
import type { OutboxOperation, WorkItem } from "../domain/types";
import { StatusPill } from "./StatusPill";

interface WorkQueueProps {
  workItems: WorkItem[];
  outbox: OutboxOperation[];
  onOpenWorkItem: (item: WorkItem) => void;
}

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

export function WorkQueue({ workItems, outbox, onOpenWorkItem }: WorkQueueProps) {
  const pendingCount = outbox.filter(
    (operation) => operation.status !== "applied"
  ).length;

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
        <input placeholder="Search asset or customer" />
        <SlidersHorizontal aria-hidden="true" size={18} />
      </label>

      <div className="filter-row" aria-label="Work filters">
        <button className="filter-chip filter-chip--active" type="button">
          All
        </button>
        <button className="filter-chip" type="button">
          Overdue
        </button>
        <button className="filter-chip" type="button">
          Due today
        </button>
        <button className="filter-chip" type="button">
          Drafts
        </button>
      </div>

      <div className="work-list">
        {workItems.map((item) => {
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
        })}
      </div>
    </section>
  );
}
