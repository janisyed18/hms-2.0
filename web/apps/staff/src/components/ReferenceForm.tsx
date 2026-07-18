import { FormEvent, useEffect, useState } from "react";
import { X } from "lucide-react";

import type {
  ReferenceCatalogFormValues,
  ReferenceCatalogRecord
} from "../domain/types";

interface ReferenceFormProps {
  open: boolean;
  standard: ReferenceCatalogRecord | null;
  onClose: () => void;
  onSubmit: (values: ReferenceCatalogFormValues) => Promise<void>;
  entityLabel?: string;
}

export function ReferenceForm({
  open,
  standard,
  onClose,
  onSubmit,
  entityLabel = "Standard"
}: ReferenceFormProps) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [isSubmitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setCode(standard?.code ?? "");
    setName(standard?.name ?? "");
    setSubmitError(null);
  }, [open, standard]);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setSubmitting(true);
      setSubmitError(null);
      await onSubmit({ code, name });
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : "Unable to save this record.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="drawer-backdrop">
      <form className="customer-drawer" onSubmit={handleSubmit}>
        <div className="drawer-header">
          <div>
            <h2>{standard ? `Edit ${entityLabel}` : `Add ${entityLabel}`}</h2>
            <p>Controlled catalog data is available immediately to asset configuration.</p>
          </div>
          <button className="icon-button light" type="button" aria-label="Close form" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label>
          <span>{entityLabel} code</span>
          <input
            aria-label={`${entityLabel} code`}
            required
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
          />
        </label>
        <label>
          <span>{entityLabel} name</span>
          <input
            aria-label={`${entityLabel} name`}
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {submitError ? <p className="form-error" role="alert">{submitError}</p> : null}
        <div className="drawer-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : `Save ${entityLabel.toLowerCase()}`}
          </button>
        </div>
      </form>
    </div>
  );
}
