import { useCallback, useEffect, useRef, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import type { MyWorkRecord } from "../domain/types";

export const MY_WORK_POLL_MS = 45_000;

interface MyWorkClient {
  getMyWork: (limit?: number) => Promise<MyWorkRecord>;
}

/** A bounded pull loop: one request at a time and no timer work in a hidden tab. */
export function useMyWork({
  client: providedClient,
  limit = 50,
  pollMs = MY_WORK_POLL_MS
}: {
  client?: MyWorkClient;
  limit?: number;
  pollMs?: number;
} = {}) {
  const [work, setWork] = useState<MyWorkRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);
  const queued = useRef(false);
  const hasWork = useRef(false);
  const client = useRef<MyWorkClient>(providedClient ?? createHmsClient());
  const refreshRef = useRef<(queueIfBusy?: boolean) => Promise<void>>(async () => undefined);

  useEffect(() => {
    client.current = providedClient ?? createHmsClient();
  }, [providedClient]);

  useEffect(() => {
    hasWork.current = work !== null;
  }, [work]);

  const refresh = useCallback(async (queueIfBusy = false) => {
    if (inFlight.current) {
      if (queueIfBusy) queued.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const next = await client.current.getMyWork(limit);
      setWork(next);
      setError(null);
    } catch {
      setError(
        hasWork.current
          ? "My Work could not be refreshed. Try again."
          : "My Work could not be loaded. Try again."
      );
    } finally {
      setLoading(false);
      inFlight.current = false;
      if (queued.current) {
        queued.current = false;
        void refreshRef.current();
      }
    }
  }, [limit]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [pollMs, refresh]);

  return { error, loading, refresh: () => refresh(true), work };
}
