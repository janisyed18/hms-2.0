import { useEffect, useState } from "react";

import type { NotificationRecord } from "../domain/types";
import { ActionButton } from "../components/interaction/ActionButton";
import { NotificationList } from "./NotificationList";
import { useNotificationCenter } from "./NotificationCenterProvider";

const PAGE = 50;

/**
 * Every notification, newest first. It shows the same shared feed as the bell, so what is read
 * here is read in the bell at once (and the other way round); only how many it asks for differs.
 */
export function NotificationsPage({ onOpen }: { onOpen: (notification: NotificationRecord) => void }) {
  const feed = useNotificationCenter();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { ensureLimit, limit } = feed;
  useEffect(() => ensureLimit(PAGE), [ensureLimit]);
  const shown = unreadOnly ? feed.items.filter((item) => item.readAt === null) : feed.items;
  // More may exist when the feed filled the page it was asked for.
  const mayHaveMore = feed.items.length >= limit;

  async function open(notification: NotificationRecord) {
    if (await feed.markRead(notification)) onOpen(notification);
  }

  return (
    <section aria-label="All notifications" className="notification-page">
      <div className="notification-page__bar">
        <div className="notification-page__filters" role="group" aria-label="Show">
          <button aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)} type="button">All</button>
          <button aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)} type="button">
            Unread{feed.unreadTotal > 0 ? ` (${feed.unreadTotal})` : ""}
          </button>
        </div>
        <ActionButton
          disabled={feed.unreadTotal === 0}
          onClick={() => void feed.markAllRead()}
          pending={feed.markingAll}
          pendingLabel="Marking…"
          variant="secondary"
        >
          Mark all read
        </ActionButton>
      </div>
      <NotificationList
        error={feed.error}
        items={shown}
        onOpen={(notification) => void open(notification)}
        onRetry={() => void feed.refresh()}
        pendingId={feed.pendingId}
        status={feed.status}
      />
      {mayHaveMore ? (
        <div className="notification-page__more">
          <button onClick={() => ensureLimit(limit + PAGE)} type="button">Show older notifications</button>
        </div>
      ) : null}
    </section>
  );
}
