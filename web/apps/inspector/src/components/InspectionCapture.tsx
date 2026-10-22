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

interface InspectionCaptureProps {
  workItem: WorkItem | null;
  /** What to show for this assignment: an unsent local edit, else what the server holds. */
  draftFor: (workItem: WorkItem) => SavedInspectionForm | null;
  onBack: () => void;
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

export function InspectionCapture({
  workItem,
  draftFor,
  onBack,
  onQueueAssetUpdate,
  onQueuePressureTest,
  onSaveDraft,
  onSubmit
}: InspectionCaptureProps) {
  const [form, setForm] = useState<InspectionFormState>(() => blankFormState(null));
  const [customerSerialNo, setCustomerSerialNo] = useState("");
  const [tag, setTag] = useState("");
  const workItemKey = workItem?.workContext?.assignment_id ?? workItem?.id ?? null;

  useEffect(() => {
    setCustomerSerialNo(workItem?.customerSerialNo ?? "");
    setTag(workItem?.tag ?? "");
    // Reload the saved form for the assignment, or start blank with the product rating.
    setForm(workItem ? stateFromSaved(draftFor(workItem), workItem.pressureRating) : blankFormState(null));
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

  return (
    <section className="screen-stack" aria-label="Inspection capture">
      <button className="text-action" onClick={onBack} type="button">
        <ArrowLeft aria-hidden="true" size={17} />
        Work queue
      </button>

      <article className="asset-context">
        <p>Service inspection</p>
        <h2>{workItem.assetNumber}</h2>
        <span>{workItem.customerName}</span>
        <small>{workItem.productName}</small>
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
          onClick={() =>
            onQueueAssetUpdate({ workItem, customerSerialNo, tag })
          }
          type="button"
        >
          Queue Asset Details
        </button>
      </article>

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

      <div className="action-row" hidden={workItem.inspectionLocked}>
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
          onClick={() =>
            built && onSaveDraft({ workItem, result: built.result, pressureTest: built.pressureTest })
          }
          type="button"
        >
          Save Draft
        </button>
        <button
          className="primary-action"
          disabled={!built || submitMissing.length > 0}
          onClick={() =>
            built && onSubmit({ workItem, result: built.result, pressureTest: built.pressureTest })
          }
          type="button"
        >
          Submit
        </button>
      </div>
    </section>
  );
}
