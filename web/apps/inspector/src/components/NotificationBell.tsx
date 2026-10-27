import { Bell, CalendarCheck, CalendarClock, ClipboardCheck, Database, FileCheck2, ShieldCheck, Smartphone, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { NotificationItem } from "../domain/types";
import {
  exactTime,
  presentCategory,
  relativeTime,
  type NotificationIconKey
} from "../notifications/presentation";
import type { useInspectorNotifications } from "../notifications/useInspectorNotifications";

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

type Feed = ReturnType<typeof useInspectorNotifications>;

/**
 * The bell and its panel. Opening a notification reads it on the server first (online only) and
 * then leaves the choice of where to go to the app, which knows which assignments it holds.
 */
export function NotificationBell({
  feed,
  isOnline,
  onOpen
}: {
  feed: Feed;
  isOnline: boolean;
  onOpen: (notification: NotificationItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const bell = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("button, [href]")?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        bell.current?.focus();
      }
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open]);

  async function openNotification(notification: NotificationItem) {
    // Online, it is marked read first and a failure keeps the person here, unread. Offline there is
    // nothing the server can be told, so it is opened without claiming it was read.
    if (isOnline && !(await feed.markRead(notification))) return;
    setOpen(false);
    onOpen(notification);
  }

  const unread = feed.unreadTotal;
  return (
    <div className="notification-bell">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className="notification-bell__button"
        onClick={() => {
          setOpen((current) => !current);
          if (!open && isOnline) void feed.refresh();
        }}
        ref={bell}
        type="button"
      >
        <Bell aria-hidden="true" size={18} />
        {unread > 0 ? <strong aria-hidden="true">{unread}</strong> : null}
      </button>
      {open ? (
        <div aria-label="Notifications" className="notification-panel" ref={panel} role="dialog">
          <div className="notification-panel__header">
            <h2>Notifications</h2>
            <button
              aria-label="Close notifications"
              onClick={() => {
                setOpen(false);
                bell.current?.focus();
              }}
              type="button"
            >
              <X aria-hidden="true" size={16} />
            </button>
          </div>
          {!isOnline ? (
            <p className="notification-panel__note" role="status">
              You are offline. These are the last notifications loaded; they cannot be marked as read until you reconnect.
            </p>
          ) : null}
          <div aria-live="polite" className="notification-panel__body">
            {feed.status === "loading" && feed.items.length === 0 ? <p>Loading notifications...</p> : null}
            {feed.status === "error" ? (
              <p className="notification-panel__error" role="alert">
                {feed.error}{" "}
                {isOnline ? <button onClick={() => void feed.refresh()} type="button">Retry</button> : null}
              </p>
            ) : null}
            {feed.status === "ready" && feed.error ? (
              <p className="notification-panel__error" role="alert">{feed.error}</p>
            ) : null}
            {feed.status === "ready" && feed.items.length === 0 ? <p>You are all caught up.</p> : null}
            {feed.items.length > 0 ? (
              <ul>
                {feed.items.map((notification) => {
                  const presentation = presentCategory(notification.category);
                  const Icon = ICONS[presentation.icon];
                  const isUnread = notification.readAt === null;
                  return (
                    <li key={notification.id}>
                      <button
                        aria-label={`Open ${isUnread ? "unread " : ""}notification ${notification.subject ?? presentation.title}`}
                        className={isUnread ? "notification-row is-unread" : "notification-row"}
                        disabled={feed.pendingId === notification.id}
                        onClick={() => void openNotification(notification)}
                        type="button"
                      >
                        <Icon aria-hidden="true" size={16} />
                        <span>
                          <strong>{isUnread ? <span className="notification-row__unread">Unread · </span> : null}{notification.subject ?? presentation.title}</strong>
                          <span>{notification.body}</span>
                          <time dateTime={notification.createdAt} title={exactTime(notification.createdAt)}>
                            {relativeTime(notification.createdAt)}
                            <span className="sr-only"> ({exactTime(notification.createdAt)})</span>
                          </time>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
          <div className="notification-panel__footer">
            <button
              disabled={!isOnline || feed.markingAll || unread === 0}
              onClick={() => void feed.markAllRead()}
              type="button"
            >
              {feed.markingAll ? "Marking…" : "Mark all read"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
