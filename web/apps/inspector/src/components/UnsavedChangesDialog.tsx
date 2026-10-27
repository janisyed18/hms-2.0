import { useEffect, useRef } from "react";

/**
 * Asked before leaving a capture whose edits have not reached the outbox. Focus starts on the safe
 * choice, Tab stays inside, Escape keeps editing, and focus returns to where it was.
 */
export function UnsavedChangesDialog({
  onDiscard,
  onKeepEditing
}: {
  onDiscard: () => void;
  onKeepEditing: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    keep.current?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);
  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        aria-describedby="unsaved-changes-message"
        aria-labelledby="unsaved-changes-title"
        aria-modal="true"
        className="dialog-card"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onKeepEditing();
          }
          if (event.key !== "Tab" || !dialog.current) return;
          const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>("button"));
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
        <h2 id="unsaved-changes-title">Discard unsaved changes?</h2>
        <p id="unsaved-changes-message">
          This inspection has changes that are not saved to the queue. If you leave now they will be lost.
        </p>
        <div className="action-row">
          <button className="secondary-action" onClick={onKeepEditing} ref={keep} type="button">
            Keep editing
          </button>
          <button className="primary-action" onClick={onDiscard} type="button">
            Discard changes
          </button>
        </div>
      </div>
    </div>
  );
}
