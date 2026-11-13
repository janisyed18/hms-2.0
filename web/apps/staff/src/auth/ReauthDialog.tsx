import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { ActionButton } from "../components/interaction/ActionButton";
import { ActionNotice } from "../components/interaction/ActionNotice";

/**
 * Asks the signed-in user to confirm their password (and authenticator code) before a
 * sensitive action. It sits above whatever dialog is open, and the action that triggered
 * it is retried by the caller once this succeeds, so nothing the user was confirming is lost.
 * A wrong answer keeps the dialog open; a single submit is in flight at a time.
 */
export function ReauthDialog({
  onCancel,
  onSubmit
}: {
  onCancel: () => void;
  onSubmit: (password: string, code: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordValue, setPasswordValue] = useState("");
  const [code, setCode] = useState("");

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    password.current?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      await onSubmit(passwordValue, code.trim());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Something went wrong. Please try again.");
      setPasswordValue("");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return createPortal(
    <div className="confirm-backdrop confirm-backdrop--elevated" role="presentation">
      <div
        aria-describedby="reauth-dialog-message"
        aria-labelledby="reauth-dialog-title"
        aria-modal="true"
        className="confirm-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            if (!pending) onCancel();
          }
          if (event.key !== "Tab" || !dialog.current) return;
          const controls = Array.from(
            dialog.current.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)")
          );
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
        role="dialog"
      >
        <h2 id="reauth-dialog-title">Confirm it is you</h2>
        <p id="reauth-dialog-message">
          This action needs a recent sign-in. Enter your password and authenticator code to continue.
        </p>
        <form onSubmit={submit}>
          <label className="auth-field" htmlFor="reauth-password">
            <span>Password</span>
            <input
              autoComplete="current-password"
              id="reauth-password"
              name="password"
              onChange={(event) => setPasswordValue(event.target.value)}
              ref={password}
              required
              type="password"
              value={passwordValue}
            />
          </label>
          <label className="auth-field" htmlFor="reauth-code">
            <span>Authenticator code</span>
            <input
              autoComplete="one-time-code"
              id="reauth-code"
              inputMode="numeric"
              name="code"
              onChange={(event) => setCode(event.target.value)}
              value={code}
            />
          </label>
          {error ? (
            <ActionNotice kind="error" title="Could not confirm">
              {error}
            </ActionNotice>
          ) : null}
          <div className="confirm-dialog__actions">
            <button
              className="action-button action-button--ghost"
              disabled={pending}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
            <ActionButton pending={pending} pendingLabel="Confirming…" type="submit" variant="primary">
              Confirm
            </ActionButton>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
