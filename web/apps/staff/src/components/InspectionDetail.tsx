import { FormEvent, useEffect, useState } from "react";
import { CheckCircle2, Save, Send, X } from "lucide-react";

import type {
  InspectionRecord,
  InspectionUpdateValues,
  PressureTestValues
} from "../domain/types";

interface InspectionDetailProps {
  canApprove: boolean;
  canWrite: boolean;
  inspection: InspectionRecord | null;
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

function noteFromMeasurements(measurements: Record<string, unknown> | null) {
  if (!measurements) {
    return "";
  }
  const [firstKey, firstValue] = Object.entries(measurements)[0] ?? [];
  if (!firstKey) {
    return "";
  }
  return `${firstKey}=${String(firstValue)}`;
}

function measurementsFromNote(note: string): Record<string, unknown> | null {
  const trimmed = note.trim();
  if (!trimmed) {
    return null;
  }
  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex > 0) {
    return {
      [trimmed.slice(0, separatorIndex).trim()]: trimmed
        .slice(separatorIndex + 1)
        .trim()
    };
  }
  return { note: trimmed };
}

export function InspectionDetail({
  canApprove,
  canWrite,
  inspection,
  onApprove,
  onClose,
  onSaveDraft,
  onSubmit
}: InspectionDetailProps) {
  const [result, setResult] = useState("REVIEW");
  const [appliedPressureKpa, setAppliedPressureKpa] = useState("0");
  const [holdTimeSeconds, setHoldTimeSeconds] = useState("0");
  const [passed, setPassed] = useState(true);
  const [measurementNote, setMeasurementNote] = useState("");
  const [isSaving, setSaving] = useState(false);
  const [isSubmitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!inspection) {
      return;
    }
    setResult(inspection.result ?? "REVIEW");
    setAppliedPressureKpa(
      String(inspection.pressureTest?.appliedPressureKpa ?? 0)
    );
    setHoldTimeSeconds(String(inspection.pressureTest?.holdTimeSeconds ?? 0));
    setPassed(inspection.pressureTest?.passed ?? true);
    setMeasurementNote(noteFromMeasurements(inspection.pressureTest?.measurements ?? null));
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

  function draftValues(): InspectionUpdateValues {
    const pressureTest: PressureTestValues = {
      appliedPressureKpa: Number(appliedPressureKpa),
      holdTimeSeconds: Number(holdTimeSeconds),
      passed,
      measurements: measurementsFromNote(measurementNote)
    };
    return {
      result: result || null,
      pressureTest
    };
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSaveDraft(draftValues());
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmitInspection() {
    setSubmitting(true);
    try {
      await onSubmit(draftValues());
    } finally {
      setSubmitting(false);
    }
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
        <label>
          <span>Result</span>
          <select
            aria-label="Detail inspection result"
            disabled={!canWrite || inspection.status !== "DRAFT"}
            value={result}
            onChange={(event) => setResult(event.target.value)}
          >
            <option value="REVIEW">Review</option>
            <option value="PASS">Pass</option>
            <option value="FAIL">Fail</option>
          </select>
        </label>
        <label>
          <span>Applied pressure kPa</span>
          <input
            aria-label="Detail applied pressure kPa"
            disabled={!canWrite || inspection.status !== "DRAFT"}
            inputMode="numeric"
            min="0"
            type="number"
            value={appliedPressureKpa}
            onChange={(event) => setAppliedPressureKpa(event.target.value)}
          />
        </label>
        <label>
          <span>Hold time seconds</span>
          <input
            aria-label="Detail hold time seconds"
            disabled={!canWrite || inspection.status !== "DRAFT"}
            inputMode="numeric"
            min="0"
            type="number"
            value={holdTimeSeconds}
            onChange={(event) => setHoldTimeSeconds(event.target.value)}
          />
        </label>
        <label className="checkbox-field">
          <input
            aria-label="Detail pressure test passed"
            checked={passed}
            disabled={!canWrite || inspection.status !== "DRAFT"}
            type="checkbox"
            onChange={(event) => setPassed(event.target.checked)}
          />
          <span>Pressure test passed</span>
        </label>
        <label>
          <span>Measurement notes</span>
          <input
            aria-label="Detail measurement notes"
            disabled={!canWrite || inspection.status !== "DRAFT"}
            value={measurementNote}
            onChange={(event) => setMeasurementNote(event.target.value)}
          />
        </label>

        <div className="inspection-action-row">
          {canWrite && inspection.status === "DRAFT" ? (
            <>
              <button className="secondary-button" disabled={isSaving} type="submit">
                <Save aria-hidden="true" size={16} />
                {isSaving ? "Saving..." : "Save draft"}
              </button>
              <button
                className="primary-button"
                disabled={isSubmitting}
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
