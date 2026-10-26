import { ArrowRight, RotateCcw } from "lucide-react";

import type { AssetWorkflowAction } from "../domain/types";
import { useAssetWorkflow } from "../hooks/useAssetWorkflow";
import { formatDateTime } from "../scheduling/zonedTime";

interface AssetWorkflowCardProps {
  assetId: string;
  /** Whether this app can open the action's target: an action with nowhere to go is not offered. */
  canOpen: (action: AssetWorkflowAction) => boolean;
  onAction: (action: AssetWorkflowAction) => void;
}

function formatDay(value: string): string {
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${value}T00:00:00Z`)
  );
}

/** Where the asset is in its service cycle, in the API's words, with the one next step it allows. */
export function AssetWorkflowCard({ assetId, canOpen, onAction }: AssetWorkflowCardProps) {
  const { state, retry } = useAssetWorkflow(assetId);

  return (
    <section aria-label="Workflow" className="asset-workflow" data-state={state.status}>
      <h3>Workflow</h3>
      {state.status === "loading" ? (
        <div aria-label="Loading workflow" className="asset-workflow-skeleton" role="status">
          <i />
          <i />
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className="asset-workflow-error" role="alert">
          <p>Workflow status unavailable. {state.message}</p>
          <button className="secondary-button" onClick={retry} type="button">
            <RotateCcw aria-hidden="true" size={14} />
            Retry
          </button>
        </div>
      ) : null}
      {state.status === "ready" ? (
        <>
          <p className="asset-workflow-status" data-attention={state.workflow.attention}>
            <strong>{state.workflow.label}</strong>
          </p>
          <p>{state.workflow.detail}</p>
          <dl className="asset-workflow-context">
            {state.workflow.context.scheduledAt ? (
              <div>
                <dt>Scheduled</dt>
                <dd>
                  <time dateTime={state.workflow.context.scheduledAt}>
                    {formatDateTime(state.workflow.context.scheduledAt, Intl.DateTimeFormat().resolvedOptions().timeZone)}
                  </time>
                </dd>
              </div>
            ) : null}
            {state.workflow.context.dueAt ? (
              <div>
                <dt>Next retest due</dt>
                <dd>
                  <time dateTime={state.workflow.context.dueAt}>{formatDay(state.workflow.context.dueAt)}</time>
                </dd>
              </div>
            ) : null}
            {state.workflow.context.certificateNumber ? (
              <div>
                <dt>Certificate</dt>
                <dd>{state.workflow.context.certificateNumber}</dd>
              </div>
            ) : null}
          </dl>
          {state.workflow.nextAction && canOpen(state.workflow.nextAction) ? (
            <div className="asset-workflow-next">
              <span>Next action</span>
              <button className="primary-button" onClick={() => onAction(state.workflow.nextAction as AssetWorkflowAction)} type="button">
                {state.workflow.nextAction.label}
                <ArrowRight aria-hidden="true" size={15} />
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
