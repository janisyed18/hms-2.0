import { CloudUpload, RefreshCw } from "lucide-react";
import type { OutboxOperation } from "../domain/types";
import { StatusPill } from "./StatusPill";

interface SyncQueueProps {
  hasPreservedDrafts: boolean;
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

const GROUPS: Array<{ status: OutboxOperation["status"]; title: string }> = [
  { status: "conflict", title: "Conflicts" },
  { status: "rejected", title: "Rejected by the server" },
  { status: "pushing", title: "Sending now" },
  { status: "pending", title: "Waiting to send" },
  { status: "applied", title: "Already applied" }
];

const SUBJECTS: Record<OutboxOperation["entity"], string> = {
  Inspection: "Inspection",
  PressureTestResult: "Pressure test result",
  Asset: "Asset details"
};

export function SyncQueue({
  hasPreservedDrafts,
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
        {hasPreservedDrafts ? (
          <p role="status">A draft was preserved but cannot be submitted. Reconnect or contact scheduling.</p>
        ) : null}
        {visibleOperations.length === 0 ? (
          <article className="empty-state">
            <CloudUpload aria-hidden="true" size={28} />
            <h2>No queued work</h2>
            <p>Saved inspections will appear here before sync.</p>
          </article>
        ) : (
          GROUPS.map((group) => {
            const operations = visibleOperations.filter((operation) => operation.status === group.status);
            if (operations.length === 0) return null;
            return (
              <section aria-label={`${group.title} operations`} className="queue-group" key={group.status}>
                <h3 className="queue-group__title">
                  {group.title} <span>{operations.length}</span>
                </h3>
                <div className="queue-grid">
                  {operations.map((operation) => (
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
                      <p className="queue-subject">{SUBJECTS[operation.entity]}</p>
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
                        <div className="queue-conflict">
                          <p className="queue-meta">
                            The server changed this record after your draft. Keep your draft to send it again over the
                            server's version, or accept the server's state and drop your change.
                          </p>
                          <div className="action-row">
                            <button
                              className="secondary-action"
                              onClick={() => onResolveConflict(operation.opId, "keep-local")}
                              type="button"
                            >
                              Keep Local Draft
                            </button>
                            <button
                              className="secondary-action"
                              onClick={() => onResolveConflict(operation.opId, "accept-server")}
                              type="button"
                            >
                              Accept Server State
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
    </section>
  );
}
