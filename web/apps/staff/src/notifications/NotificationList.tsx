import { Bell, CalendarCheck, CalendarClock, ClipboardCheck, Database, FileCheck2, ShieldCheck, Smartphone, type LucideIcon } from "lucide-react";

import type { NotificationRecord } from "../domain/types";
import { exactTime, presentCategory, relativeTime, type NotificationIconKey } from "./presentation";
import type { FeedStatus } from "./useNotificationFeed";

const ICONS: Record<NotificationIconKey, LucideIcon> = {
  inspection: ClipboardCheck,
  certificate: FileCheck2,
  retest: CalendarClock,
  booking: CalendarCheck,
  asset: Database,
  account: ShieldCheck,
  device: Smartphone,
  general: Bell
};

/**
 * The feed's rows and its loading, error and empty states, shared by the bell's panel and the
 * full page. Read and unread differ by more than colour: an "Unread" mark and the dot.
 */
export function NotificationList({
  error,
  items,
  onOpen,
  onRetry,
  pendingId,
  status
}: {
  error: string | null;
  items: NotificationRecord[];
  onOpen: (notification: NotificationRecord) => void;
  onRetry: () => void;
  pendingId: string | null;
  status: FeedStatus;
}) {
  return (
    <div className="notification-feed" aria-live="polite">
      {status === "loading" && items.length === 0 ? (
        <p className="notification-feed-message">Loading notifications...</p>
      ) : null}
      {status === "error" ? (
        <div className="notification-feed-message notification-feed-error" role="alert">
          <span>{error}</span>
          <button onClick={onRetry} type="button">Retry</button>
        </div>
      ) : null}
      {status === "ready" && error ? (
        <div className="notification-feed-message notification-feed-error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}
      {status === "ready" && items.length === 0 ? (
        <p className="notification-feed-message">You are all caught up.</p>
      ) : null}
      {items.length > 0 ? (
        <ul className="notification-list">
          {items.map((notification) => {
            const presentation = presentCategory(notification.category);
            const Icon = ICONS[presentation.icon];
            const unread = notification.readAt === null;
            return (
              <li key={notification.id}>
                <button
                  aria-label={`Open ${unread ? "unread " : ""}notification ${notification.subject ?? presentation.title}`}
                  className={`notification-item${unread ? " is-unread" : ""}`}
                  disabled={pendingId === notification.id}
                  onClick={() => onOpen(notification)}
                  type="button"
                >
                  <span aria-hidden="true" className="notification-icon"><Icon size={16} /></span>
                  <span className="notification-copy">
                    <strong>{notification.subject ?? presentation.title}</strong>
                    <span>{notification.body}</span>
                    <time dateTime={notification.createdAt} title={exactTime(notification.createdAt)}>
                      {relativeTime(notification.createdAt)}
                      <span className="sr-only"> ({exactTime(notification.createdAt)})</span>
                    </time>
                  </span>
                  {unread ? <span aria-hidden="true" className="notification-unread" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
