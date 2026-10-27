import type { WorkItem } from "../domain/types";
import type { StatusTone } from "./StatusPill";

/** The status the Inspector already knows for an assignment; nothing here is invented. */
export function urgencyLabel(item: WorkItem): { tone: StatusTone; label: string } {
  switch (item.urgency) {
    case "overdue":
      return { tone: "danger", label: "Overdue retest" };
    case "due-today":
      return { tone: "warning", label: "Due today" };
    case "draft":
      return { tone: "info", label: "Draft saved" };
    case "synced":
      return { tone: "success", label: "Synced" };
  }
}
