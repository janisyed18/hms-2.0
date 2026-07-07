import { FormEvent, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

import type { CertificateIssueValues, InspectionRecord } from "../domain/types";

interface CertificateFormProps {
  inspectionOptions: InspectionRecord[];
  open: boolean;
  onClose: () => void;
  onSubmit: (values: CertificateIssueValues) => Promise<void>;
}

function defaultCertificateNumber(inspection: InspectionRecord | undefined) {
  if (!inspection) {
    return "";
  }
  return `CERT-${inspection.asset.assetNumber}-1`;
}

function defaultValidUntil() {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 1);
  return date.toISOString().slice(0, 10);
}

export function CertificateForm({
  inspectionOptions,
  open,
  onClose,
  onSubmit
}: CertificateFormProps) {
  const [inspectionId, setInspectionId] = useState("");
  const [number, setNumber] = useState("");
  const [validUntil, setValidUntil] = useState(defaultValidUntil);
  const [isSubmitting, setSubmitting] = useState(false);

  const selectedInspection = useMemo(
    () => inspectionOptions.find((inspection) => inspection.id === inspectionId),
    [inspectionId, inspectionOptions]
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const firstInspection = inspectionOptions[0];
    setInspectionId(firstInspection?.id ?? "");
    setNumber(defaultCertificateNumber(firstInspection));
    setValidUntil(defaultValidUntil());
  }, [inspectionOptions, open]);

  useEffect(() => {
    if (!selectedInspection) {
      return;
    }
    setNumber(defaultCertificateNumber(selectedInspection));
  }, [selectedInspection]);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    await onSubmit({
      inspectionId,
      number: number.trim(),
      validUntil: validUntil || null
    });
    setSubmitting(false);
  }

  return (
    <div className="drawer-backdrop">
      <form className="customer-drawer" onSubmit={handleSubmit}>
        <div className="drawer-header">
          <div>
            <h2>Issue Certificate</h2>
            <p>Create a versioned certificate from an approved inspection.</p>
          </div>
          <button
            aria-label="Close certificate form"
            className="icon-button light"
            onClick={onClose}
            type="button"
          >
            <X size={18} />
          </button>
        </div>
        <label>
          <span>Approved inspection</span>
          <select
            aria-label="Approved inspection"
            disabled={inspectionOptions.length === 0}
            required
            value={inspectionId}
            onChange={(event) => setInspectionId(event.target.value)}
          >
            {inspectionOptions.map((inspection) => (
              <option key={inspection.id} value={inspection.id}>
                {inspection.asset.assetNumber} - {inspection.customer.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Certificate number</span>
          <input
            aria-label="Certificate number"
            disabled={inspectionOptions.length === 0}
            required
            value={number}
            onChange={(event) => setNumber(event.target.value)}
          />
        </label>
        <label>
          <span>Valid until</span>
          <input
            aria-label="Valid until"
            disabled={inspectionOptions.length === 0}
            type="date"
            value={validUntil}
            onChange={(event) => setValidUntil(event.target.value)}
          />
        </label>
        <div className="drawer-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={isSubmitting || inspectionOptions.length === 0}
            type="submit"
          >
            {isSubmitting ? "Issuing..." : "Issue certificate"}
          </button>
        </div>
      </form>
    </div>
  );
}
