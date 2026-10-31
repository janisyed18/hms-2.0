import type { InspectionStatus } from "../domain/types";

const LABELS: Record<InspectionStatus, string> = {
  DRAFT: "Draft",
  IN_PROGRESS: "In progress",
  SUBMITTED: "Awaiting review",
  APPROVED: "Approved",
  REJECTED: "Changes required"
};

/** The status as people read it: a rejected inspection is "Changes required". */
export function inspectionStatusLabel(status: string): string {
  return LABELS[status as InspectionStatus] ?? status;
}
