import { FormEvent, useState } from "react";
import { X } from "lucide-react";

import type { CustomerFormValues } from "../domain/types";

interface CustomerFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (values: CustomerFormValues) => Promise<void>;
}

export function CustomerForm({ open, onClose, onSubmit }: CustomerFormProps) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [notes, setNotes] = useState("");
  const [retestEnabled, setRetestEnabled] = useState(true);
  const [defaultRetestMonths, setDefaultRetestMonths] = useState(12);
  const [isSubmitting, setSubmitting] = useState(false);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    await onSubmit({
      name,
      code,
      notes: notes.trim() || null,
      retestEnabled,
      defaultRetestMonths
    });
    setName("");
    setCode("");
    setNotes("");
    setRetestEnabled(true);
    setDefaultRetestMonths(12);
    setSubmitting(false);
  }

  return (
    <div className="drawer-backdrop">
      <form className="customer-drawer" onSubmit={handleSubmit}>
        <div className="drawer-header">
          <div>
            <h2>Add Customer</h2>
            <p>Create a development customer record for workflow testing.</p>
          </div>
          <button className="icon-button light" type="button" aria-label="Close form" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label>
          <span>Customer name</span>
          <input
            aria-label="Customer name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          <span>Customer code</span>
          <input
            aria-label="Customer code"
            required
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
          />
        </label>
        <label>
          <span>Default retest interval</span>
          <select
            value={defaultRetestMonths}
            onChange={(event) => setDefaultRetestMonths(Number(event.target.value))}
          >
            <option value={6}>6 months</option>
            <option value={12}>12 months</option>
            <option value={24}>24 months</option>
          </select>
        </label>
        <label>
          <span>Customer notes</span>
          <textarea
            aria-label="Customer notes"
            rows={4}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={retestEnabled}
            onChange={(event) => setRetestEnabled(event.target.checked)}
          />
          <span>Enable retest scheduling</span>
        </label>
        <div className="drawer-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : "Save customer"}
          </button>
        </div>
      </form>
    </div>
  );
}
