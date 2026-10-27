import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { useNotificationFeed } from "./useNotificationFeed";

/** What the bell shows; the full page may ask the shared feed for more. */
export const BELL_ITEMS = 12;

type Feed = ReturnType<typeof useNotificationFeed>;
interface NotificationCenter extends Feed {
  /** Make sure the shared feed holds at least `count` notifications (the full page asks for more). */
  ensureLimit: (count: number) => void;
  limit: number;
}

const Context = createContext<NotificationCenter | null>(null);

/**
 * One notification state per signed-in scope, however many places show it. The bell, the Staff
 * page and the portal page all read this, so reading something in one is read everywhere at
 * once, and there is exactly one polling loop.
 */
export function NotificationCenterProvider({
  children,
  customerId
}: {
  children: ReactNode;
  customerId?: string | null;
}) {
  const [limit, setLimit] = useState(BELL_ITEMS);
  const feed = useNotificationFeed({ customerId, limit });
  const ensureLimit = useCallback((count: number) => setLimit((current) => Math.max(current, count)), []);
  const value = useMemo(() => ({ ...feed, ensureLimit, limit }), [feed, ensureLimit, limit]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useNotificationCenter(): NotificationCenter {
  const center = useContext(Context);
  if (!center) throw new Error("useNotificationCenter needs a NotificationCenterProvider");
  return center;
}
