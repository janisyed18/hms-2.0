import { useState } from "react";
import { Copy, ShieldAlert, X } from "lucide-react";

export interface OneTimeCredential {
  title: string;
  label: string;
  value: string;
  note?: string;
}

interface OneTimeCredentialDialogProps {
  credential: OneTimeCredential | null;
  onClose: () => void;
}

/**
 * Shows a one-time secret (temporary password) exactly once. The value lives only
 * in the parent's transient state; closing calls onClose so the parent can drop
 * it, and the dialog cannot be reopened to reveal it again.
 */
export function OneTimeCredentialDialog({
  credential,
  onClose
}: OneTimeCredentialDialogProps) {
  const [copied, setCopied] = useState(false);
  if (!credential) {
    return null;
  }

  function copy() {
    if (credential && navigator.clipboard) {
      void navigator.clipboard.writeText(credential.value);
      setCopied(true);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-label={credential.title}>
      <div className="modal-card one-time-credential">
        <div className="modal-header">
          <h2>
            <ShieldAlert aria-hidden="true" size={18} /> {credential.title}
          </h2>
          <button
            aria-label="Close"
            className="icon-button light"
            onClick={onClose}
            type="button"
          >
            <X size={16} />
          </button>
        </div>
        <p className="modal-note">
          {credential.note ??
            "Copy this now — it is shown only once and cannot be retrieved later."}
        </p>
        <div className="credential-value">
          <span className="credential-label">{credential.label}</span>
          <code data-testid="credential-value">{credential.value}</code>
          <button className="secondary-button" onClick={copy} type="button">
            <Copy aria-hidden="true" size={15} />
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <button className="primary-button" onClick={onClose} type="button">
          Done
        </button>
      </div>
    </div>
  );
}
