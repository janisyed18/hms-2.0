import { useCallback, useRef, useState } from "react";

import { friendlyApiError, type FriendlyErrorOptions } from "./friendlyApiError";

/**
 * State for a destructive action behind a ConfirmDialog: which record is targeted, whether the
 * request is in flight, and the reason it failed. A failure leaves the dialog open and the
 * record untouched; `perform` only runs after the user confirms.
 */
export function useConfirmedAction<T>(
  perform: (target: T) => Promise<void>,
  errorOptions: (target: T) => FriendlyErrorOptions
) {
  const [target, setTarget] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const request = useCallback((next: T) => { setError(null); setTarget(next); }, []);
  const cancel = useCallback(() => { if (!lock.current) { setTarget(null); setError(null); } }, []);
  const confirm = useCallback(async () => {
    if (target === null || lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      await perform(target);
      setTarget(null);
    } catch (reason) {
      setError(friendlyApiError(reason, errorOptions(target)).message);
    } finally {
      lock.current = false;
      setPending(false);
    }
  }, [errorOptions, perform, target]);
  return { cancel, confirm, error, pending, request, target };
}
