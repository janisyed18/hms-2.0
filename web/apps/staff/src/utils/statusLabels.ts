import { inspectionStatusLabel } from "./inspectionStatus";

/**
 * Each state a person sees has one name. The API's codes (IN_SERVICE, PENDING_APPROVAL) are never shown
 * to a customer or an operator; these are the words that stand in for them, so a state reads the same
 * on every screen. Display only: the codes themselves are unchanged.
 */
const LIFECYCLE: Record<string, string> = {
  IN_SERVICE: "In service",
  DUE: "Due",
  OVERDUE: "Overdue",
  CONDEMNED: "Condemned",
  RETIRED: "Retired"
};

const RETEST: Record<string, string> = {
  UPCOMING: "Upcoming",
  DUE: "Due",
  OVERDUE: "Overdue",
  ESCALATED: "Escalated",
  SUSPENDED: "Suspended"
};

const CERTIFICATE: Record<string, string> = {
  DRAFT: "Pending issue",
  ISSUED: "Issued",
  SUPERSEDED: "Superseded",
  REVOKED: "Revoked"
};

/** Words a code into sentence case when no specific name is known: "NEW_ASSET" becomes "New asset". */
export function plainWords(code: string): string {
  const words = code.replaceAll("_", " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const lifecycleStatusLabel = (status: string): string => LIFECYCLE[status] ?? plainWords(status);
export const retestStatusLabel = (status: string): string => RETEST[status] ?? plainWords(status);
export const certificateStatusLabel = (status: string): string => CERTIFICATE[status] ?? plainWords(status);
export const inspectionResultLabel = (result: string | null | undefined): string => (result ? plainWords(result) : "Result pending");
export { inspectionStatusLabel };
