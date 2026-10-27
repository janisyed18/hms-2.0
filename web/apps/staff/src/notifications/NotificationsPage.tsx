import { useState } from "react";

import type { NotificationRecord } from "../domain/types";
import { ActionButton } from "../components/interaction/ActionButton";
import { NotificationList } from "./NotificationList";
import { useNotificationFeed } from "./useNotificationFeed";

const PAGE = 50;

/** Every notification, newest first, with the same open / mark-read behaviour as the bell. */
export function NotificationsPage({
  customerId,
  onOpen
}: {
  customerId?: string | null;
  onOpen: (notification: NotificationRecord) => void;
}) {
  const [limit, setLimit] = useState(PAGE);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const feed = useNotificationFeed({ customerId, limit });
  const shown = unreadOnly ? feed.items.filter((item) => item.readAt === null) : feed.items;
  // More are available when the feed filled the page it was asked for.
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
          <button onClick={() => setLimit((current) => current + PAGE)} type="button">Show older notifications</button>
        </div>
      ) : null}
    </section>
  );
}
