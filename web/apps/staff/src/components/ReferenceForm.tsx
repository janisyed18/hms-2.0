import { FormEvent, useEffect, useState } from "react";
import { X } from "lucide-react";

import type {
  ReferenceStandardFormValues,
  ReferenceStandardRecord
} from "../domain/types";

interface ReferenceFormProps {
  open: boolean;
  standard: ReferenceStandardRecord | null;
  onClose: () => void;
  onSubmit: (values: ReferenceStandardFormValues) => Promise<void>;
}

export function ReferenceForm({
  open,
  standard,
  onClose,
  onSubmit
}: ReferenceFormProps) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [isSubmitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setCode(standard?.code ?? "");
    setName(standard?.name ?? "");
  }, [open, standard]);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    await onSubmit({ code, name });
    setSubmitting(false);
  }

  return (
    <div className="drawer-backdrop">
      <form className="customer-drawer" onSubmit={handleSubmit}>
        <div className="drawer-header">
          <div>
            <h2>{standard ? "Edit Standard" : "Add Standard"}</h2>
            <p>Maintain controlled pressure and hose standards.</p>
          </div>
          <button className="icon-button light" type="button" aria-label="Close form" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label>
          <span>Standard code</span>
          <input
            aria-label="Standard code"
            required
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
          />
        </label>
        <label>
          <span>Standard name</span>
          <input
            aria-label="Standard name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="drawer-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : "Save standard"}
          </button>
        </div>
      </form>
    </div>
  );
}
