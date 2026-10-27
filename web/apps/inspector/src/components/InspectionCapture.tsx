import { ArrowLeft, ClipboardCheck } from "lucide-react";
import { useEffect, useState } from "react";
import {
  blankFormState,
  buildValues,
  draftGaps,
  stateFromSaved,
  submitGaps
} from "../domain/inspectionForm";
import type { InspectionFormState, SavedInspectionForm } from "../domain/inspectionForm";
import type { PressureTestDraft, WorkItem } from "../domain/types";
import { InspectionFields } from "./InspectionFields";
import { StatusPill } from "./StatusPill";
import { urgencyLabel } from "./workStatus";

interface InspectionCaptureProps {
  workItem: WorkItem | null;
  /** What to show for this assignment: an unsent local edit, else what the server holds. */
  draftFor: (workItem: WorkItem) => SavedInspectionForm | null;
  onBack: () => void;
  /** Whether the screen holds edits that have not reached the outbox. */
  onDirtyChange?: (dirty: boolean) => void;
  onQueueAssetUpdate: (values: {
    workItem: WorkItem;
    customerSerialNo: string;
    tag: string;
  }) => void;
  onQueuePressureTest: (values: { workItem: WorkItem; pressureTest: PressureTestDraft }) => void;
  onSaveDraft: (values: {
    workItem: WorkItem;
    result: string | null;
    pressureTest: PressureTestDraft;
  }) => void;
  onSubmit: (values: {
    workItem: WorkItem;
    result: string | null;
    pressureTest: PressureTestDraft;
  }) => void;
}

const formSnapshot = (state: InspectionFormState) => JSON.stringify(state);
const assetSnapshot = (customerSerialNo: string, tag: string) => JSON.stringify([customerSerialNo, tag]);

export function InspectionCapture({
  workItem,
  draftFor,
  onBack,
  onDirtyChange,
  onQueueAssetUpdate,
  onQueuePressureTest,
  onSaveDraft,
  onSubmit
}: InspectionCaptureProps) {
  const [form, setForm] = useState<InspectionFormState>(() => blankFormState(null));
  const [customerSerialNo, setCustomerSerialNo] = useState("");
  const [tag, setTag] = useState("");
  // What the outbox already holds for this assignment, as a comparable string per part. The inspection
  // form is saved by Save Draft / Submit; the asset details by Queue Asset Details.
  const [savedForm, setSavedForm] = useState(() => formSnapshot(blankFormState(null)));
  const [savedAsset, setSavedAsset] = useState(() => assetSnapshot("", ""));
  const workItemKey = workItem?.workContext?.assignment_id ?? workItem?.id ?? null;
  // A submitted inspection's form is read-only, but its asset details can still be edited and queued.
  const dirty =
    Boolean(workItem) &&
    ((!workItem?.inspectionLocked && formSnapshot(form) !== savedForm) ||
      assetSnapshot(customerSerialNo, tag) !== savedAsset);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  // Leaving the screen, or losing the assignment, leaves nothing unsaved behind.
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useEffect(() => {
    // Reload the saved form for the assignment, or start blank with the product rating.
    const nextForm = workItem ? stateFromSaved(draftFor(workItem), workItem.pressureRating) : blankFormState(null);
    setCustomerSerialNo(workItem?.customerSerialNo ?? "");
    setTag(workItem?.tag ?? "");
    setForm(nextForm);
    setSavedForm(formSnapshot(nextForm));
    setSavedAsset(assetSnapshot(workItem?.customerSerialNo ?? "", workItem?.tag ?? ""));
    // Only when a different assignment is opened, not on every queue change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workItemKey]);

  if (!workItem) {
    return (
      <section className="empty-state">
        <ClipboardCheck aria-hidden="true" size={28} />
        <h2>No inspection selected</h2>
        <p>Select a work item to begin capture.</p>
        <button className="secondary-action" onClick={onBack} type="button">
          Back to work
        </button>
      </section>
    );
  }

  const built = buildValues(form);
  const draftMissing = draftGaps(form);
  const submitMissing = submitGaps(form);

  const status = urgencyLabel(workItem);

  return (
    <section className="capture-screen" aria-label="Inspection capture">
      <button className="text-action" onClick={onBack} type="button">
        <ArrowLeft aria-hidden="true" size={17} />
        Work queue
      </button>

      <div className="capture-layout">
        <aside className="capture-context" aria-label="Asset context">
          <article className="asset-context">
            <p>Service inspection</p>
            <h2>{workItem.assetNumber}</h2>
            <span>{workItem.customerName}</span>
            <small>{workItem.productName}</small>
            {workItem.locationName ? <small>{workItem.locationName}</small> : null}
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
          </article>

          <article className="capture-panel">
            <div className="panel-heading">
              <p>Asset details</p>
              <span>Sync-safe fields</span>
            </div>
            <div className="capture-form capture-form--compact">
              <label>
                <span>Customer serial number</span>
                <input
                  aria-label="Customer serial number"
                  onChange={(event) => setCustomerSerialNo(event.target.value)}
                  value={customerSerialNo}
                />
              </label>
              <label>
                <span>Asset tag</span>
                <input
                  aria-label="Asset tag"
                  onChange={(event) => setTag(event.target.value)}
                  value={tag}
                />
              </label>
            </div>
            <button
              className="secondary-action secondary-action--full"
              onClick={() => {
                onQueueAssetUpdate({ workItem, customerSerialNo, tag });
                setSavedAsset(assetSnapshot(customerSerialNo, tag));
              }}
              type="button"
            >
              Queue Asset Details
            </button>
          </article>
        </aside>

        <div className="capture-main">
          <div className="segmented-control" aria-label="Inspection type">
            <button className="segment segment--active" type="button">
              Service
            </button>
            <button className="segment" type="button">
              New asset
            </button>
          </div>

          {workItem.inspectionLocked ? (
            <p className="capture-hint" role="status">
              This inspection has been submitted for review and can no longer be edited here.
            </p>
          ) : null}
          <InspectionFields disabled={workItem.inspectionLocked} onChange={setForm} state={form} />

          {workItem.inspectionLocked ? null : draftMissing.length > 0 ? (
            <p className="capture-hint" role="status">
              To save, still needed: {draftMissing.join(", ")}.
            </p>
          ) : submitMissing.length > 0 ? (
            <p className="capture-hint" role="status">
              To submit, still needed: {submitMissing.join(", ")}.
            </p>
          ) : null}
        </div>
      </div>

      <div className="capture-actions action-row" hidden={workItem.inspectionLocked}>
        <span aria-live="polite" className="capture-actions__status">{dirty ? "Unsaved changes" : ""}</span>
        <button
          className="secondary-action"
          disabled={!built}
          onClick={() => built && onQueuePressureTest({ workItem, pressureTest: built.pressureTest })}
          type="button"
        >
          Queue Test Result
        </button>
        <button
          className="secondary-action"
          disabled={!built}
          onClick={() => {
            if (!built) return;
            onSaveDraft({ workItem, result: built.result, pressureTest: built.pressureTest });
            setSavedForm(formSnapshot(form));
          }}
          type="button"
        >
          Save Draft
        </button>
        <button
          className="primary-action"
          disabled={!built || submitMissing.length > 0}
          onClick={() => {
            if (!built) return;
            onSubmit({ workItem, result: built.result, pressureTest: built.pressureTest });
            setSavedForm(formSnapshot(form));
          }}
          type="button"
        >
          Submit
        </button>
      </div>
    </section>
  );
}
