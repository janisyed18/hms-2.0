import { useCallback, useEffect, useRef, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import { friendlyApiError } from "../components/interaction/friendlyApiError";
import type { NotificationRecord } from "../domain/types";

export const NOTIFICATION_POLL_MS = 45_000;
/** A tab that comes back to the front refreshes at once, unless it just did. */
const FOCUS_REFRESH_AFTER_MS = 15_000;

interface FeedClient {
  listNotifications: (options?: { customerId?: string; limit?: number; offset?: number }) => Promise<{
    total: number;
    unreadTotal: number;
    items: NotificationRecord[];
  }>;
  markNotificationRead: (id: string) => Promise<NotificationRecord>;
  markAllNotificationsRead: (options?: { customerId?: string }) => Promise<{ updated: number; unreadTotal: number }>;
}

export type FeedStatus = "idle" | "loading" | "ready" | "error";

/**
 * The signed-in person's notification feed: fetched at once, then polled while the page is
 * visible. Boring on purpose. One request at a time (a tick that finds one running does
 * nothing), nothing while hidden, and a failed poll keeps what is on screen and says so
 * instead of blanking it. Authentication failures are the client's existing 401 path, not
 * handled here.
 *
 * `customerId` scopes a portal organisation; `null` means "no organisation yet": an empty
 * feed, no request.
 */
export function useNotificationFeed({
  customerId,
  enabled = true,
  limit = 12,
  pollMs = NOTIFICATION_POLL_MS,
  client: providedClient
}: {
  customerId?: string | null;
  enabled?: boolean;
  limit?: number;
  pollMs?: number;
  client?: FeedClient;
}) {
  const [items, setItems] = useState<NotificationRecord[]>([]);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [status, setStatus] = useState<FeedStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const inFlight = useRef(false);
  const lastFetch = useRef(0);
  const scope = useRef(customerId);
  const clientRef = useRef(providedClient);
  const hasItems = useRef(false);
  // Read by callbacks that outlive a render, so they see the latest without re-binding.
  useEffect(() => {
    scope.current = customerId;
    clientRef.current = providedClient;
    hasItems.current = items.length > 0;
  });

  const refresh = useCallback(async (options: { quiet?: boolean } = {}) => {
    if (customerId === null) {
      setItems([]);
      setUnreadTotal(0);
      setStatus("ready");
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    if (!options.quiet && !hasItems.current) setStatus("loading");
    const asked = customerId;
    try {
      const feed = await (clientRef.current ?? createHmsClient()).listNotifications({
        ...(asked === undefined ? {} : { customerId: asked }),
        limit
      });
      if (scope.current !== asked) return; // the organisation changed while this was in flight
      lastFetch.current = Date.now();
      setItems(feed.items);
      setUnreadTotal(feed.unreadTotal);
      setStatus("ready");
      setError(null);
    } catch {
      // Keep what is shown. A first load with nothing to show is an error; a failed refresh is a note.
      setStatus(hasItems.current ? "ready" : "error");
      setError(
        hasItems.current
          ? "Notifications could not be refreshed. Try again."
          : "Notifications could not be loaded. Try again."
      );
    } finally {
      inFlight.current = false;
    }
  }, [customerId, limit]);

  useEffect(() => {
    if (!enabled) return;
    void refresh({ quiet: true });
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
  }, [enabled, pollMs, refresh]);

  /** Marks one read on the server first; the feed only changes once the server says so. */
  const markRead = useCallback(async (notification: NotificationRecord): Promise<boolean> => {
    if (notification.readAt) return true;
    setPendingId(notification.id);
    setError(null);
    try {
      const updated = await (clientRef.current ?? createHmsClient()).markNotificationRead(notification.id);
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setUnreadTotal((current) => Math.max(0, current - 1));
      return true;
    } catch (reason) {
      setError(friendlyApiError(reason, { fallback: "This notification could not be marked as read. Try again." }).message);
      return false;
    } finally {
      setPendingId(null);
    }
  }, []);

  const markAllRead = useCallback(async (): Promise<boolean> => {
    if (markingAll) return false;
    setMarkingAll(true);
    setError(null);
    try {
      const result = await (clientRef.current ?? createHmsClient()).markAllNotificationsRead(
        scope.current ? { customerId: scope.current } : {}
      );
      const now = new Date().toISOString();
      setItems((current) => current.map((item) => (item.readAt ? item : { ...item, readAt: now })));
      setUnreadTotal(result.unreadTotal);
      return true;
    } catch (reason) {
      setError(friendlyApiError(reason, { fallback: "Notifications could not be marked as read. Try again." }).message);
      return false;
    } finally {
      setMarkingAll(false);
    }
  }, [markingAll]);

  return { error, items, markAllRead, markRead, markingAll, pendingId, refresh, status, unreadTotal };
}
