import { FormEvent, useEffect, useRef, useState } from "react";
import { CheckCircle2, Play, RotateCcw, Save, Send, Undo2, X } from "lucide-react";

import {
  blankFormState,
  buildValues,
  draftGaps,
  stateFromInspection,
  submitGaps
} from "../domain/inspectionForm";
import type { InspectionFormState, PressureRating } from "../domain/inspectionForm";
import type { InspectionRecord, InspectionUpdateValues } from "../domain/types";
import { ActionButton } from "./interaction/ActionButton";
import { ActionNotice } from "./interaction/ActionNotice";
import { friendlyApiError } from "./interaction/friendlyApiError";
import { InspectionFormFields } from "./InspectionFormFields";
import { assetLabel } from "../utils/identity";
import { inspectionStatusLabel } from "../utils/inspectionStatus";
import { Field } from "./interaction/FormPrimitives";

interface InspectionDetailProps {
  canApprove: boolean;
  canWrite: boolean;
  inspection: InspectionRecord | null;
  /** The product rating for an asset, for inspections saved before ratings were recorded. */
  ratingFor?: (assetId: string) => PressureRating | null;
  onApprove: () => Promise<void>;
  /** REJECTED back to IN_PROGRESS: the explicit step that makes the form editable again. */
  onBeginRework: () => Promise<void>;
  onClose: () => void;
  /** Reload the inspection lists after a conflict showed the screen was out of date. */
  onRefresh?: () => void;
  /** Send a submitted inspection back, with the reason the inspector will see. */
  onReject: (reason: string) => Promise<void>;
  onSaveDraft: (values: InspectionUpdateValues) => Promise<void>;
  /** DRAFT to IN_PROGRESS. */
  onStart: () => Promise<void>;
  onSubmit: (values: InspectionUpdateValues) => Promise<void>;
}

function statusClass(status: string) {
  if (status === "DRAFT" || status === "IN_PROGRESS") {
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
  onBeginRework,
  onClose,
  onRefresh,
  onReject,
  onSaveDraft,
  onStart,
  onSubmit
}: InspectionDetailProps) {
  const [form, setForm] = useState<InspectionFormState>(() => blankFormState(null));
  const [isSaving, setSaving] = useState(false);
  const [isSubmitting, setSubmitting] = useState(false);
  const [isApproving, setApproving] = useState(false);
  const [isStarting, setStarting] = useState(false);
  const [isReworking, setReworking] = useState(false);
  const [isRejecting, setRejecting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inspection) {
      return;
    }
    // Shows exactly what was saved, so a reload or a reviewer sees the same form.
    setForm(stateFromInspection(inspection, ratingFor?.(inspection.assetId) ?? null));
    setError(null);
    setAsking(false);
    setReason("");
    setReasonError(null);
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

  // The form can change only while work is in progress; every other state is read-only.
  const editable = canWrite && inspection.status === "IN_PROGRESS";
  const busy = isSaving || isSubmitting || isApproving || isStarting || isReworking || isRejecting;
  const built = buildValues(form);
  const draftMissing = draftGaps(form);
  const submitMissing = submitGaps(form);

  function draftValues(): InspectionUpdateValues | null {
    return built ? { result: built.result, pressureTest: built.pressureTest } : null;
  }

  /** Run one action once at a time; a failure is shown here and leaves the form as typed. */
  async function guarded(action: () => Promise<void>, setBusy: (busy: boolean) => void, fallback: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason: unknown) {
      const friendly = friendlyApiError(reason, { fallback });
      setError(friendly.message);
      // The record may have moved on (already approved, wrong state): reload what is shown.
      if (friendly.kind === "conflict" || friendly.kind === "missing") onRefresh?.();
      window.setTimeout(() => document.querySelector<HTMLElement>(".inspection-detail-form .action-notice")?.focus(), 0);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function run(
    action: (values: InspectionUpdateValues) => Promise<void>,
    setBusy: (busy: boolean) => void,
    missing: string[],
    fallback: string
  ) {
    const values = draftValues();
    if (!values || missing.length > 0) {
      // Say what is still needed instead of leaving a dead button.
      setError(`Still needed: ${missing.join(", ")}.`);
      window.setTimeout(() => document.querySelector<HTMLElement>(".inspection-detail-form .action-notice")?.focus(), 0);
      return;
    }
    await guarded(() => action(values), setBusy, fallback);
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(onSaveDraft, setSaving, draftMissing, "The inspection draft could not be saved. Try again.");
  }

  async function handleSubmitInspection() {
    await run(onSubmit, setSubmitting, [...draftMissing, ...submitMissing], "The inspection could not be submitted. Try again.");
  }

  async function handleApprove() {
    await guarded(onApprove, setApproving, "The inspection could not be approved. Try again.");
  }

  async function handleStart() {
    await guarded(onStart, setStarting, "The inspection could not be started. Try again.");
  }

  async function handleRework() {
    await guarded(onBeginRework, setReworking, "Rework could not be started. Try again.");
  }

  async function handleReject() {
    if (!reason.trim()) {
      setReasonError("Say what needs to change, so the inspector knows what to fix.");
      window.setTimeout(() => document.getElementById(`inspection-${inspection!.id}-reject-reason`)?.focus(), 0);
      return;
    }
    setReasonError(null);
    await guarded(() => onReject(reason.trim()), setRejecting, "The inspection could not be sent back. Try again.");
  }

  return (
    <aside className="inspection-detail-panel" aria-label="Inspection detail">
      <div className="inspection-detail-header">
        <div>
          <h2>Inspection {assetLabel(inspection.asset)}</h2>
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
        <span className={statusClass(inspection.status)}>{inspectionStatusLabel(inspection.status)}</span>
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
          <span>Started</span>
          <strong>{inspection.startedAt ?? "Not started"}</strong>
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

      {inspection.status === "REJECTED" ? (
        <div className="inspection-changes-required" role="status">
          <strong>Changes required</strong>
          <p>{inspection.rejectionReason ?? "The reviewer did not leave a reason."}</p>
        </div>
      ) : null}

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
        {error ? <ActionNotice kind="error" title="Inspection not saved">{error}</ActionNotice> : null}

        <div className="inspection-action-row">
          {canWrite && inspection.status === "DRAFT" ? (
            <ActionButton disabled={busy} onClick={handleStart} pending={isStarting} pendingLabel="Starting…" variant="primary">
              <Play aria-hidden="true" size={16} />
              Start inspection
            </ActionButton>
          ) : null}
          {editable ? (
            <>
              <ActionButton disabled={busy && !isSaving} pending={isSaving} pendingLabel="Saving…" type="submit" variant="secondary">
                <Save aria-hidden="true" size={16} />
                Save progress
              </ActionButton>
              <ActionButton disabled={busy && !isSubmitting} onClick={handleSubmitInspection} pending={isSubmitting} pendingLabel="Submitting…" variant="primary">
                <Send aria-hidden="true" size={16} />
                Submit inspection
              </ActionButton>
            </>
          ) : null}
          {canWrite && inspection.status === "REJECTED" ? (
            <ActionButton disabled={busy} onClick={handleRework} pending={isReworking} pendingLabel="Starting rework…" variant="primary">
              <RotateCcw aria-hidden="true" size={16} />
              Begin rework
            </ActionButton>
          ) : null}
          {canApprove && inspection.status === "SUBMITTED" ? (
            <>
              <ActionButton disabled={busy && !isApproving} onClick={handleApprove} pending={isApproving} pendingLabel="Approving…" variant="primary">
                <CheckCircle2 aria-hidden="true" size={16} />
                Approve inspection
              </ActionButton>
              <ActionButton disabled={busy} onClick={() => setAsking((open) => !open)} variant="secondary">
                <Undo2 aria-hidden="true" size={16} />
                Request changes
              </ActionButton>
            </>
          ) : null}
        </div>
        {canApprove && inspection.status === "SUBMITTED" && asking ? (
          <div className="inspection-reject">
            <Field error={reasonError ?? undefined} label="What needs to change" name={`inspection-${inspection.id}-reject-reason`} required>
              {(props) => (
                <textarea
                  {...props}
                  aria-label="What needs to change"
                  onChange={(event) => { setReason(event.target.value); setReasonError(null); }}
                  rows={3}
                  value={reason}
                />
              )}
            </Field>
            <ActionButton disabled={busy && !isRejecting} onClick={handleReject} pending={isRejecting} pendingLabel="Sending back…" variant="danger">
              Send back for changes
            </ActionButton>
          </div>
        ) : null}
      </form>
    </aside>
  );
}
