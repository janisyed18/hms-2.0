import { CloudUpload, RefreshCw } from "lucide-react";
import type { OutboxOperation } from "../domain/types";
import { StatusPill } from "./StatusPill";

interface SyncQueueProps {
  outbox: OutboxOperation[];
  isOnline: boolean;
  onPush: () => void;
  onPull: () => void;
  onResolveConflict: (
    opId: string,
    resolution: "keep-local" | "accept-server"
  ) => void;
}

function statusTone(status: OutboxOperation["status"]) {
  switch (status) {
    case "applied":
      return "success" as const;
    case "pending":
    case "pushing":
      return "warning" as const;
    case "conflict":
    case "rejected":
      return "danger" as const;
  }
}

function statusLabel(status: OutboxOperation["status"]) {
  switch (status) {
    case "applied":
      return "Applied";
    case "pending":
      return "Pending";
    case "pushing":
      return "Pushing";
    case "conflict":
      return "Conflict";
    case "rejected":
      return "Rejected";
  }
}

export function SyncQueue({
  outbox,
  isOnline,
  onPush,
  onPull,
  onResolveConflict
}: SyncQueueProps) {
  const visibleOperations = outbox;
  const pendingCount = outbox.filter((operation) => operation.status !== "applied")
    .length;
  const pushableCount = outbox.filter(
    (operation) =>
      operation.status === "pending" || operation.status === "rejected"
  ).length;

  return (
    <section className="screen-stack" aria-label="Sync queue">
      <div className="queue-summary">
        <div>
          <p>Sync Queue</p>
          <h2>{pendingCount} pending</h2>
        </div>
        <StatusPill tone={isOnline ? "success" : "muted"}>
          {isOnline ? "Ready to push" : "Offline"}
        </StatusPill>
      </div>

      <div className="action-row">
        <button
          className="primary-action"
          disabled={!isOnline || pushableCount === 0}
          onClick={onPush}
          type="button"
        >
          <CloudUpload aria-hidden="true" size={17} />
          Push Changes
        </button>
        <button
          className="secondary-action"
          disabled={!isOnline}
          onClick={onPull}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={17} />
          Pull Updates
        </button>
      </div>

      <div className="queue-list">
        {visibleOperations.length === 0 ? (
          <article className="empty-state">
            <CloudUpload aria-hidden="true" size={28} />
            <h2>No queued work</h2>
            <p>Saved inspections will appear here before sync.</p>
          </article>
        ) : (
          visibleOperations.map((operation) => (
            <article className="queue-card" key={operation.opId}>
              <div className="work-card__top">
                <div>
                  <h2>{operation.assetNumber}</h2>
                  <p>{operation.customerName}</p>
                </div>
                <StatusPill tone={statusTone(operation.status)}>
                  {statusLabel(operation.status)}
                </StatusPill>
              </div>
              <p className="queue-meta">
                {operation.entity} · {operation.op} · {operation.entityId}
              </p>
              {operation.currentVersion ? (
                <p className="queue-meta">Server version {operation.currentVersion}</p>
              ) : null}
              {operation.lastError ? (
                <p className="error-text">{operation.lastError}</p>
              ) : null}
              {operation.status === "conflict" ? (
                <div className="action-row">
                  <button
                    className="secondary-action"
                    onClick={() =>
                      onResolveConflict(operation.opId, "keep-local")
                    }
                    type="button"
                  >
                    Keep Local Draft
                  </button>
                  <button
                    className="secondary-action"
                    onClick={() =>
                      onResolveConflict(operation.opId, "accept-server")
                    }
                    type="button"
                  >
                    Accept Server State
                  </button>
                </div>
              ) : null}
            </article>
          ))
        )}
      </div>
    </section>
  );
}
