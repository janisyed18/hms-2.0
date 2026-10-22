import { FormEvent, useEffect, useState } from "react";
import { CheckCircle2, Save, Send, X } from "lucide-react";

import {
  blankFormState,
  buildValues,
  draftGaps,
  stateFromInspection,
  submitGaps
} from "../domain/inspectionForm";
import type { InspectionFormState, PressureRating } from "../domain/inspectionForm";
import type { InspectionRecord, InspectionUpdateValues } from "../domain/types";
import { InspectionFormFields } from "./InspectionFormFields";

interface InspectionDetailProps {
  canApprove: boolean;
  canWrite: boolean;
  inspection: InspectionRecord | null;
  /** The product rating for an asset, for inspections saved before ratings were recorded. */
  ratingFor?: (assetId: string) => PressureRating | null;
  onApprove: () => Promise<void>;
  onClose: () => void;
  onSaveDraft: (values: InspectionUpdateValues) => Promise<void>;
  onSubmit: (values: InspectionUpdateValues) => Promise<void>;
}

function statusClass(status: string) {
  if (status === "DRAFT") {
    return "mini-status due-soon";
  }
  if (status === "SUBMITTED") {
    return "mini-status status-review";
  }
  if (status === "REJECTED") {
    return "mini-status overdue";
  }
  return "mini-status current";
}

export function InspectionDetail({
  canApprove,
  canWrite,
  inspection,
  ratingFor,
  onApprove,
  onClose,
  onSaveDraft,
  onSubmit
}: InspectionDetailProps) {
  const [form, setForm] = useState<InspectionFormState>(() => blankFormState(null));
  const [isSaving, setSaving] = useState(false);
  const [isSubmitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inspection) {
      return;
    }
    // Shows exactly what was saved, so a reload or a reviewer sees the same form.
    setForm(stateFromInspection(inspection, ratingFor?.(inspection.assetId) ?? null));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspection]);

  if (!inspection) {
    return (
      <aside className="inspection-detail-panel" aria-label="Inspection detail">
        <div className="empty-detail">
          <strong>Select an inspection</strong>
          <span>Open a row to review pressure data and status actions.</span>
        </div>
      </aside>
    );
  }

  const editable = canWrite && inspection.status === "DRAFT";
  const built = buildValues(form);
  const draftMissing = draftGaps(form);
  const submitMissing = submitGaps(form);

  function draftValues(): InspectionUpdateValues | null {
    return built ? { result: built.result, pressureTest: built.pressureTest } : null;
  }

  async function run(
    action: (values: InspectionUpdateValues) => Promise<void>,
    setBusy: (busy: boolean) => void
  ) {
    const values = draftValues();
    if (!values) return;
    setBusy(true);
    setError(null);
    try {
      await action(values);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "The inspection could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(onSaveDraft, setSaving);
  }

  async function handleSubmitInspection() {
    await run(onSubmit, setSubmitting);
  }

  return (
    <aside className="inspection-detail-panel" aria-label="Inspection detail">
      <div className="inspection-detail-header">
        <div>
          <h2>Inspection {inspection.asset.assetNumber}</h2>
          <p>{inspection.customer.name} / {inspection.product.name}</p>
        </div>
        <button
          aria-label="Close inspection detail"
          className="icon-button light"
          onClick={onClose}
          type="button"
        >
          <X size={18} />
        </button>
      </div>

      <div className="inspection-detail-strip">
        <span className={statusClass(inspection.status)}>{inspection.status}</span>
        <span>{inspection.inspectionType.replace("_", " ")}</span>
        <span>Result {inspection.result ?? "Pending"}</span>
      </div>

      <div className="inspection-facts">
        <div>
          <span>Inspector</span>
          <strong>{inspection.inspectorUserId}</strong>
        </div>
        <div>
          <span>Reviewer</span>
          <strong>{inspection.reviewerUserId ?? "Not reviewed"}</strong>
        </div>
        <div>
          <span>Submitted</span>
          <strong>{inspection.submittedAt ?? "Not submitted"}</strong>
        </div>
        <div>
          <span>Approved</span>
          <strong>{inspection.approvedAt ?? "Not approved"}</strong>
        </div>
      </div>

      <form className="inspection-detail-form" onSubmit={handleSave}>
        <InspectionFormFields
          disabled={!editable}
          idPrefix={`inspection-${inspection.id}`}
          onChange={setForm}
          state={form}
        />
        {editable && draftMissing.length > 0 ? (
          <p className="field-hint" role="status">
            To save, still needed: {draftMissing.join(", ")}.
          </p>
        ) : null}
        {editable && draftMissing.length === 0 && submitMissing.length > 0 ? (
          <p className="field-hint" role="status">
            To submit, still needed: {submitMissing.join(", ")}.
          </p>
        ) : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}

        <div className="inspection-action-row">
          {canWrite && inspection.status === "DRAFT" ? (
            <>
              <button className="secondary-button" disabled={isSaving || !built} type="submit">
                <Save aria-hidden="true" size={16} />
                {isSaving ? "Saving..." : "Save draft"}
              </button>
              <button
                className="primary-button"
                disabled={isSubmitting || submitMissing.length > 0}
                onClick={handleSubmitInspection}
                type="button"
              >
                <Send aria-hidden="true" size={16} />
                {isSubmitting ? "Submitting..." : "Submit inspection"}
              </button>
            </>
          ) : null}
          {canApprove && inspection.status === "SUBMITTED" ? (
            <button
              className="primary-button"
              onClick={onApprove}
              type="button"
            >
              <CheckCircle2 aria-hidden="true" size={16} />
              Approve inspection
            </button>
          ) : null}
        </div>
      </form>
    </aside>
  );
}
