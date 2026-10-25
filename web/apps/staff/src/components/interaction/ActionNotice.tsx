import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

export type NoticeKind = "success" | "error" | "info" | "warning";

export interface NoticeState {
  kind: NoticeKind;
  message: string;
  title?: string;
}

/**
 * A status message. Errors use role="alert" (announced at once, and kept until fixed or
 * dismissed); the rest use role="status". The kind is also spelled out for people who
 * cannot rely on colour.
 */
export function ActionNotice({
  children,
  focus = false,
  kind,
  onDismiss,
  title
}: {
  children: ReactNode;
  /** Move focus here when it appears, for outcomes the user must act on. */
  focus?: boolean;
  kind: NoticeKind;
  onDismiss?: () => void;
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  const label = { success: "Success", error: "Error", info: "Note", warning: "Warning" }[kind];
  return (
    <div
      className={`action-notice is-${kind}`}
      ref={ref}
      role={kind === "error" ? "alert" : "status"}
      tabIndex={-1}
    >
      <p>
        <strong>{title ?? label}.</strong> <span>{children}</span>
      </p>
      {onDismiss ? (
        <button aria-label="Dismiss message" className="action-notice__dismiss" onClick={onDismiss} type="button">
          <X aria-hidden="true" size={16} />
        </button>
      ) : null}
    </div>
  );
}

/** Workspace-level notice state: successes clear themselves, errors stay until dismissed. */
export function useActionNotice(successMs = 8000) {
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const timer = useRef<number | null>(null);
  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setNotice(null);
  }, []);
  const notify = useCallback((next: NoticeState) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setNotice(next);
    if (next.kind === "success" && successMs > 0) {
      timer.current = window.setTimeout(() => setNotice(null), successMs);
    }
  }, [successMs]);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return { notice, notify, clear };
}
