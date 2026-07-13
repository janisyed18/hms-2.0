import { useEffect, useRef, useState } from "react";
import { Copy, ShieldAlert, X } from "lucide-react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";

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
  const doneRef = useRef<HTMLButtonElement>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (credential) {
      setCopied(false);
      doneRef.current?.focus();
    }
  }, [credential]);

  function copy() {
    if (credential && navigator.clipboard) {
      void navigator.clipboard.writeText(credential.value);
      setCopied(true);
    }
  }

  return (
    <AnimatePresence initial={false}>
      {credential ? (
        <m.div
          animate={{ opacity: 1 }}
          aria-label={credential.title}
          aria-modal="true"
          className="modal-backdrop"
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          key={credential.value}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
          role="dialog"
          transition={{ duration: reducedMotion ? 0 : 0.16 }}
        >
          <m.div
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
            className="modal-card one-time-credential"
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
            transition={{ duration: reducedMotion ? 0 : 0.16 }}
          >
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
        <button className="primary-button" onClick={onClose} ref={doneRef} type="button">
          Done
        </button>
          </m.div>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
