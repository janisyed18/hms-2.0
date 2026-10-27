import type { WorkItem } from "../domain/types";
import type { StatusTone } from "./StatusPill";

/** What an assignment shows: its inspection's lifecycle first, then how urgent the retest is. */
export function urgencyLabel(item: WorkItem): { tone: StatusTone; label: string } {
  switch (item.inspectionStatus) {
    case "IN_PROGRESS":
      return { tone: "info", label: "In progress" };
    case "REJECTED":
      return { tone: "danger", label: "Changes required" };
    case "SUBMITTED":
      return { tone: "warning", label: "Awaiting review" };
    case "APPROVED":
      return { tone: "success", label: "Approved" };
    case "DRAFT":
      return { tone: "info", label: "Ready to start" };
  }
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
