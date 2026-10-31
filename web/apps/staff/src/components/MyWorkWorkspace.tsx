import { AlertTriangle, ArrowRight, BriefcaseBusiness, RefreshCcw } from "lucide-react";

import type { MyWorkItem } from "../domain/types";
import { useMyWork } from "../hooks/useMyWork";
import { AssetIdentity } from "./AssetIdentity";
import { WorkspaceState } from "./WorkspaceState";
import { formatWithZone, viewerZone } from "../scheduling/zonedTime";

export function MyWorkWorkspace({
  onOpen,
  pollMs
}: {
  onOpen: (item: MyWorkItem) => void;
  pollMs?: number;
}) {
  const { error, loading, refresh, work } = useMyWork({ pollMs });

  if (loading && work === null) {
    return <WorkspaceState title="Loading My Work" tone="loading">Checking your current workflow actions.</WorkspaceState>;
  }
  if (work === null) {
    return (
      <WorkspaceState
        action={<button className="secondary-button" onClick={refresh} type="button">Retry</button>}
        title="My Work unavailable"
        tone="error"
      >
        {error ?? "My Work could not be loaded."}
      </WorkspaceState>
    );
  }
  if (work.items.length === 0) {
    if (work.sourceLimited) {
      return (
        <WorkspaceState
          action={<button className="secondary-button" onClick={refresh} type="button">Retry</button>}
          title="Partial My Work results"
          tone="empty"
        >
          No actions were found in the first {work.sourceLimit} visible assets. Additional assets were not scanned.
        </WorkspaceState>
      );
    }
    return <WorkspaceState title="You're caught up" tone="empty">There are no actions waiting for you.</WorkspaceState>;
  }

  return (
    <section className="my-work-page" aria-labelledby="my-work-heading">
      <header className="my-work-header">
        <div>
          <span className="my-work-eyebrow"><BriefcaseBusiness aria-hidden="true" size={15} /> Action queue</span>
          <h1 id="my-work-heading">My Work</h1>
          <p>Actions available to you across current HMS workflows.</p>
        </div>
        <button aria-label="Refresh My Work" className="icon-button" onClick={refresh} type="button">
          <RefreshCcw aria-hidden="true" size={18} />
        </button>
      </header>
      {error ? <p className="my-work-refresh-warning" role="status">{error}</p> : null}
      <div aria-label="My Work summary" className="my-work-summary">
        <Summary label="Needs attention" value={work.summary.urgent} tone="urgent" />
        <Summary label="Due soon" value={work.summary.dueSoon} tone="due" />
        <Summary label="In queue" value={work.summary.normal} tone="normal" />
        <Summary label="Total actions" value={work.summary.total} tone="total" />
      </div>
      <ol className="my-work-list">
        {work.items.map((item) => (
          <li className="my-work-card" key={item.id}>
            <div className="my-work-card-main">
              <span className={`my-work-priority priority-${item.priority.toLowerCase()}`}>{item.priority.replace("_", " ")}</span>
              <h2>{item.title}</h2>
              <p>{item.summary}</p>
              <dl>
                <div><dt>Customer</dt><dd>{item.customerName}</dd></div>
                <div><dt>Asset</dt><dd><AssetIdentity asset={item} /></dd></div>
                <div><dt>State</dt><dd>{item.state.replaceAll("_", " ")}</dd></div>
                <div>
                  <dt>{item.dueAt ? "Due" : "Updated"}</dt>
                  <dd><time dateTime={item.dueAt ?? item.updatedAt}>{formatWorkTime(item.dueAt ?? item.updatedAt)}</time></dd>
                </div>
              </dl>
            </div>
            <button className="primary-button" onClick={() => onOpen(item)} type="button">
              {item.nextAction.label}<ArrowRight aria-hidden="true" size={16} />
            </button>
          </li>
        ))}
      </ol>
      {work.sourceLimited ? <p className="my-work-limit"><AlertTriangle aria-hidden="true" size={16} /> Showing actions found in the first {work.sourceLimit} visible assets.</p> : null}
    </section>
  );
}

function Summary({ label, tone, value }: { label: string; tone: string; value: number }) {
  return <div className={`my-work-summary-card summary-${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

/** A task has no site of its own, so its time is shown in the zone this device is set to, and says which. */
function formatWorkTime(value: string): string {
  return formatWithZone(value, viewerZone());
}
