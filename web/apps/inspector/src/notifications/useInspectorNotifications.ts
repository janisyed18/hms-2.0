import { useCallback, useEffect, useRef, useState } from "react";

import { createSyncClient } from "../api/syncClient";
import type { NotificationItem } from "../domain/types";

export const NOTIFICATION_POLL_MS = 45_000;
const FOCUS_REFRESH_AFTER_MS = 15_000;

export type NotificationStatus = "idle" | "loading" | "ready" | "error";

/**
 * The inspector's notifications. Fetched when signed in and online, then polled while the page
 * is visible; never while offline or hidden, never two at once, and a failed poll keeps what is
 * shown. Offline the last feed stays on screen, but reading is a server fact: nothing here
 * pretends it changed while the device cannot reach the server.
 */
export function useInspectorNotifications({
  isOnline,
  limit = 20,
  pollMs = NOTIFICATION_POLL_MS,
  userId
}: {
  isOnline: boolean;
  limit?: number;
  pollMs?: number;
  userId: string;
}) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [status, setStatus] = useState<NotificationStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const inFlight = useRef(false);
  const lastFetch = useRef(0);
  const hasItems = useRef(false);
  useEffect(() => {
    hasItems.current = items.length > 0;
  });

  const rerun = useRef(false);
  const refreshRef = useRef<(options?: { quiet?: boolean; queueIfBusy?: boolean }) => Promise<void>>(async () => undefined);
  const refresh = useCallback(async (options: { quiet?: boolean; queueIfBusy?: boolean } = {}) => {
    if (inFlight.current) {
      // Asked for outright (opening the panel, coming back online): run when this one is done.
      if (options.queueIfBusy) rerun.current = true;
      return;
    }
    inFlight.current = true;
    if (!options.quiet && !hasItems.current) setStatus("loading");
    try {
      const feed = await createSyncClient({ userId }).listNotifications({ limit });
      lastFetch.current = Date.now();
      setItems(feed.items);
      setUnreadTotal(feed.unreadTotal);
      setStatus("ready");
      setError(null);
    } catch {
      setStatus(hasItems.current ? "ready" : "error");
      setError(
        hasItems.current
          ? "Notifications could not be refreshed. Try again."
          : "Notifications could not be loaded. Try again."
      );
    } finally {
      inFlight.current = false;
      if (rerun.current) {
        rerun.current = false;
        void refreshRef.current({ quiet: true });
      }
    }
  }, [limit, userId]);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!isOnline) return;
    void refresh({ quiet: true, queueIfBusy: true });
    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh({ quiet: true });
    }, pollMs);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastFetch.current > FOCUS_REFRESH_AFTER_MS) {
        void refresh({ quiet: true });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isOnline, pollMs, refresh]);

  const markRead = useCallback(async (notification: NotificationItem): Promise<boolean> => {
    if (notification.readAt) return true;
    if (!isOnline) return false;
    setPendingId(notification.id);
    setError(null);
    try {
      const updated = await createSyncClient({ userId }).markNotificationRead(notification.id);
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setUnreadTotal((current) => Math.max(0, current - 1));
      return true;
    } catch {
      setError("This notification could not be marked as read. Try again.");
      return false;
    } finally {
      setPendingId(null);
    }
  }, [isOnline, userId]);

  const markAllRead = useCallback(async (): Promise<boolean> => {
    if (!isOnline || markingAll) return false;
    setMarkingAll(true);
    setError(null);
    try {
      const result = await createSyncClient({ userId }).markAllNotificationsRead();
      const now = new Date().toISOString();
      setItems((current) => current.map((item) => (item.readAt ? item : { ...item, readAt: now })));
      setUnreadTotal(result.unreadTotal);
      return true;
    } catch {
      setError("Notifications could not be marked as read. Try again.");
      return false;
    } finally {
      setMarkingAll(false);
    }
  }, [isOnline, markingAll, userId]);

  return { error, items, markAllRead, markRead, markingAll, pendingId, refresh, status, unreadTotal };
}
