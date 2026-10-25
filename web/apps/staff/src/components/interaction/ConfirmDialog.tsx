import { useEffect, useRef, type ReactNode } from "react";

import { ActionButton } from "./ActionButton";
import { ActionNotice } from "./ActionNotice";

/**
 * A modal confirmation for a destructive action. Focus starts on the safe choice, Tab stays
 * inside, Escape cancels, and focus returns to what opened it. A failed action keeps the
 * dialog open and says why, so nothing looks done when it is not.
 */
export function ConfirmDialog({
  confirmLabel,
  error,
  message,
  onCancel,
  onConfirm,
  open,
  pending = false,
  pendingLabel,
  title
}: {
  confirmLabel: string;
  error?: string | null;
  message: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  pending?: boolean;
  pendingLabel: string;
  title: string;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="confirm-backdrop" role="presentation">
      <div
        aria-describedby="confirm-dialog-message"
        aria-labelledby="confirm-dialog-title"
        aria-modal="true"
        className="confirm-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !pending) {
            event.stopPropagation();
            onCancel();
          }
          if (event.key !== "Tab" || !dialog.current) return;
          const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled)"));
          if (controls.length === 0) return;
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        ref={dialog}
        role="alertdialog"
      >
        <h2 id="confirm-dialog-title">{title}</h2>
        <p id="confirm-dialog-message">{message}</p>
        {error ? <ActionNotice kind="error" title="Could not complete">{error}</ActionNotice> : null}
        <div className="confirm-dialog__actions">
          <button className="action-button action-button--ghost" disabled={pending} onClick={onCancel} ref={cancel} type="button">
            Cancel
          </button>
          <ActionButton onClick={onConfirm} pending={pending} pendingLabel={pendingLabel} variant="danger">
            {confirmLabel}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}
