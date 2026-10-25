import { useCallback, useRef, useState } from "react";

import type { NoticeState } from "./ActionNotice";
import { friendlyApiError, type FriendlyError, type FriendlyErrorOptions } from "./friendlyApiError";

export interface RunOptions<T> extends FriendlyErrorOptions {
  /** What to say once the server has confirmed success. Omit for a silent success. */
  success?: (result: T) => (Omit<NoticeState, "kind"> & { kind?: NoticeState["kind"] }) | string;
  /** Called with the translated error after the failure notice is shown. */
  onError?: (error: FriendlyError) => void;
  /** Title for the failure notice, e.g. "Booking could not be approved". */
  failureTitle?: string;
}

/**
 * Runs one button-style action (approve, reject, cancel, revoke, submit...) the same way
 * everywhere: one at a time, `pending` names which action is in flight, success is announced
 * only after the server confirms, and a failure becomes a safe message that stays until
 * dismissed. It never throws, so the caller's current screen and data stay as they were.
 */
export function useActionRunner(notify: (notice: NoticeState) => void) {
  const lock = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, action: () => Promise<T>, options: RunOptions<T> = {}): Promise<{ ok: true; value: T } | { ok: false; error: FriendlyError }> => {
      if (lock.current) {
        return { ok: false, error: { kind: "unknown", message: "Another action is still running.", status: null, fieldErrors: {}, retryAfterSeconds: null, needsRefresh: false } };
      }
      lock.current = true;
      setPending(key);
      try {
        const value = await action();
        if (options.success) {
          const said = options.success(value);
          notify({ kind: "success", ...(typeof said === "string" ? { message: said } : said) } as NoticeState);
        }
        return { ok: true, value };
      } catch (reason) {
        const error = friendlyApiError(reason, options);
        notify({ kind: "error", message: error.message, title: options.failureTitle });
        options.onError?.(error);
        return { ok: false, error };
      } finally {
        lock.current = false;
        setPending(null);
      }
    },
    [notify]
  );
  return { pending, run };
}
