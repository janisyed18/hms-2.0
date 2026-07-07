import { ArrowLeft, ClipboardCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkItem } from "../domain/types";

interface InspectionCaptureProps {
  workItem: WorkItem | null;
  onBack: () => void;
  onQueueAssetUpdate: (values: {
    workItem: WorkItem;
    customerSerialNo: string;
    tag: string;
  }) => void;
  onQueuePressureTest: (values: {
    workItem: WorkItem;
    appliedPressureMpa: number;
    requiredPressureMpa: number;
    holdTimeSeconds: number;
    passed: boolean;
  }) => void;
  onSaveDraft: (values: {
    workItem: WorkItem;
    appliedPressureMpa: number;
    requiredPressureMpa: number;
    holdTimeSeconds: number;
    passed: boolean;
    notes: string;
  }) => void;
  onSubmit: (values: {
    workItem: WorkItem;
    appliedPressureMpa: number;
    requiredPressureMpa: number;
    holdTimeSeconds: number;
    passed: boolean;
    notes: string;
  }) => void;
}

export function InspectionCapture({
  workItem,
  onBack,
  onQueueAssetUpdate,
  onQueuePressureTest,
  onSaveDraft,
  onSubmit
}: InspectionCaptureProps) {
  const [appliedPressureMpa, setAppliedPressureMpa] = useState("30.2");
  const [requiredPressureMpa, setRequiredPressureMpa] = useState("20");
  const [holdTimeSeconds, setHoldTimeSeconds] = useState("300");
  const [passed, setPassed] = useState(true);
  const [notes, setNotes] = useState("");
  const [customerSerialNo, setCustomerSerialNo] = useState("");
  const [tag, setTag] = useState("");

  useEffect(() => {
    setCustomerSerialNo(workItem?.customerSerialNo ?? "");
    setTag(workItem?.tag ?? "");
  }, [workItem]);

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

  const values = {
    workItem,
    appliedPressureMpa: Number(appliedPressureMpa) || 0,
    requiredPressureMpa: Number(requiredPressureMpa) || 0,
      holdTimeSeconds: Number(holdTimeSeconds) || 0,
      passed,
      notes
  };
  const pressureValues = {
    workItem,
    appliedPressureMpa: values.appliedPressureMpa,
    requiredPressureMpa: values.requiredPressureMpa,
    holdTimeSeconds: values.holdTimeSeconds,
    passed: values.passed
  };

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

      <form className="capture-form">
        <label>
          <span>Applied pressure</span>
          <input
            aria-label="Applied pressure"
            inputMode="decimal"
            onChange={(event) => setAppliedPressureMpa(event.target.value)}
            value={appliedPressureMpa}
          />
          <small>MPa</small>
        </label>

        <label>
          <span>Required pressure</span>
          <input
            aria-label="Required pressure"
            inputMode="decimal"
            onChange={(event) => setRequiredPressureMpa(event.target.value)}
            value={requiredPressureMpa}
          />
          <small>MPa</small>
        </label>

        <label>
          <span>Hold time</span>
          <input
            aria-label="Hold time"
            inputMode="numeric"
            onChange={(event) => setHoldTimeSeconds(event.target.value)}
            value={holdTimeSeconds}
          />
          <small>seconds</small>
        </label>

        <div className="result-toggle">
          <button
            className={passed ? "segment segment--active" : "segment"}
            onClick={() => setPassed(true)}
            type="button"
          >
            Pass
          </button>
          <button
            className={!passed ? "segment segment--danger" : "segment"}
            onClick={() => setPassed(false)}
            type="button"
          >
            Fail
          </button>
        </div>

        <label className="notes-field">
          <span>Notes</span>
          <textarea
            aria-label="Notes"
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Inspection observations"
            value={notes}
          />
        </label>
      </form>

      <div className="action-row">
        <button
          className="secondary-action"
          onClick={() => onQueuePressureTest(pressureValues)}
          type="button"
        >
          Queue Test Result
        </button>
        <button
          className="secondary-action"
          onClick={() => onSaveDraft(values)}
          type="button"
        >
          Save Draft
        </button>
        <button
          className="primary-action"
          onClick={() => onSubmit(values)}
          type="button"
        >
          Submit
        </button>
      </div>
    </section>
  );
}
