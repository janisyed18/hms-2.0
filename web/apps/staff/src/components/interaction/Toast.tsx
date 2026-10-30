import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { CheckCircle2, X } from "lucide-react";

export const TOAST_MS = 4000;
const MAX_VISIBLE = 3;

export interface ToastInput {
  /** The sentence that says what happened: "Main Pump Hose created successfully." */
  message: string;
  /** A short label for it ("Asset saved"); read out with the message, shown only when there is no message. */
  title?: string;
}

interface ToastRecord extends ToastInput {
  id: number;
}

export interface ToastApi {
  success: (toast: ToastInput) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** The confirmation channel, or null where no provider is mounted (a test, a story): callers then fall back to an inline notice. */
export function useOptionalToast(): ToastApi | null {
  return useContext(ToastContext);
}

/**
 * Success confirmations that outlive the form or drawer that produced them. They live in the shell, not in the
 * component that saved, so closing a drawer or opening the new record does not take them away. Errors
 * never come here: a failure stays beside the thing to fix until it is fixed.
 */
export function ToastProvider({ children, durationMs = TOAST_MS }: { children: ReactNode; durationMs?: number }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const next = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const success = useCallback((toast: ToastInput) => {
    next.current += 1;
    const record = { ...toast, id: next.current };
    setToasts((current) => [...current, record].slice(-MAX_VISIBLE));
  }, []);
  const api = useMemo<ToastApi>(() => ({ success }), [success]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* The container is always present, so a toast added to it is a change inside a live region. */}
      <div className="toast-region">
        {toasts.map((toast) => (
          <ToastItem durationMs={durationMs} key={toast.id} onDismiss={dismiss} toast={toast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ durationMs, onDismiss, toast }: { durationMs: number; onDismiss: (id: number) => void; toast: ToastRecord }) {
  const remaining = useRef(durationMs);
  const startedAt = useRef(0);
  const timer = useRef<number | null>(null);
  const [paused, setPaused] = useState(false);
  const hovered = useRef(false);
  const focused = useRef(false);

  useEffect(() => {
    if (paused) return;
    startedAt.current = Date.now();
    timer.current = window.setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
    };
  }, [onDismiss, paused, toast.id]);

  function sync() {
    setPaused(hovered.current || focused.current);
  }

  return (
    <div
      className="toast toast--success"
      onBlur={() => { focused.current = false; sync(); }}
      onFocus={() => { focused.current = true; sync(); }}
      onMouseEnter={() => { hovered.current = true; sync(); }}
      onMouseLeave={() => { hovered.current = false; sync(); }}
      role="status"
    >
      <CheckCircle2 aria-hidden="true" className="toast__icon" size={20} />
      <p className="toast__text">
        <span className="sr-only">Success. </span>
        <strong>{toast.message}</strong>
      </p>
      <button aria-label="Dismiss confirmation" className="toast__close" onClick={() => onDismiss(toast.id)} type="button">
        <X aria-hidden="true" size={16} />
      </button>
    </div>
  );
}
