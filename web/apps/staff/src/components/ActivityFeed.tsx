import {
  CheckCircle2,
  FileCheck2,
  TimerReset,
  UserRound,
  Wrench
} from "lucide-react";

import type { ActivityItem } from "../domain/types";

interface ActivityFeedProps {
  items: ActivityItem[];
}

function iconFor(item: ActivityItem) {
  if (item.type === "certificate") {
    return FileCheck2;
  }
  if (item.type === "contact") {
    return UserRound;
  }
  if (item.status === "Current") {
    return CheckCircle2;
  }
  if (item.type === "asset") {
    return Wrench;
  }
  return TimerReset;
}

export function ActivityFeed({ items }: ActivityFeedProps) {
  return (
    <section className="activity-panel" aria-label="Recent activity">
      <div className="section-heading">
        <h2>Recent Activity</h2>
        <button type="button">View all activity</button>
      </div>
      <div className="activity-list">
        {items.map((item) => {
          const Icon = iconFor(item);
          return (
            <article className="activity-row" key={item.id}>
              <div className={`activity-icon ${item.status?.toLowerCase().replace(" ", "-") ?? "neutral"}`}>
                <Icon aria-hidden="true" size={17} />
              </div>
              <div>
                <strong>{item.title}</strong>
                <span>{item.meta}</span>
              </div>
              {item.status ? (
                <span className={`mini-status ${item.status.toLowerCase().replace(" ", "-")}`}>
                  {item.status}
                </span>
              ) : null}
              <time>{item.time}</time>
            </article>
          );
        })}
      </div>
    </section>
  );
}
