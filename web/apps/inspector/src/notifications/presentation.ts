/**
 * How a notification category reads, in one place. The same file is used by the Staff app
 * (which also serves the customer portal) and by the Inspector; a backend test fails if the
 * two copies drift or a category is missing. Where a click goes is decided from the
 * notification's own ids elsewhere, never from these names.
 */
export type NotificationIconKey =
  | "inspection"
  | "certificate"
  | "retest"
  | "booking"
  | "asset"
  | "account"
  | "device"
  | "general";

export interface CategoryPresentation {
  icon: NotificationIconKey;
  title: string;
  action: string;
}

const PRESENTATION: Record<string, CategoryPresentation> = {
  RETEST_ADVANCE: { icon: "retest", title: "Retest coming up", action: "View asset" },
  RETEST_DUE: { icon: "retest", title: "Retest due", action: "View asset" },
  RETEST_OVERDUE: { icon: "retest", title: "Retest overdue", action: "View asset" },
  SERVICE_BOOKED: { icon: "booking", title: "Service booked", action: "View booking" },
  ASSET_APPROACHING_CONDEMNATION: { icon: "asset", title: "Asset nearing end of life", action: "View asset" },
  ASSET_CONDEMNED: { icon: "asset", title: "Asset condemned", action: "View asset" },
  ASSET_RETIRED: { icon: "asset", title: "Asset retired", action: "View asset" },
  ASSET_BULK_IMPORT_COMPLETED: { icon: "asset", title: "Asset import finished", action: "View assets" },
  INSPECTION_SUBMITTED: { icon: "inspection", title: "Inspection submitted", action: "Review inspection" },
  INSPECTION_APPROVED: { icon: "inspection", title: "Inspection approved", action: "View inspection" },
  INSPECTION_REJECTED: { icon: "inspection", title: "Inspection sent back", action: "View inspection" },
  INSPECTION_FAILED: { icon: "inspection", title: "Inspection failed", action: "View inspection" },
  INSPECTION_BOOKING_REQUESTED: { icon: "booking", title: "Booking requested", action: "View booking" },
  INSPECTION_BOOKING_APPROVED: { icon: "booking", title: "Booking approved", action: "View booking" },
  INSPECTION_BOOKING_REJECTED: { icon: "booking", title: "Booking declined", action: "View booking" },
  INSPECTION_BOOKING_CANCELLED: { icon: "booking", title: "Booking cancelled", action: "View booking" },
  INSPECTION_BOOKING_RESCHEDULE_REQUESTED: { icon: "booking", title: "Reschedule requested", action: "View booking" },
  INSPECTION_BOOKING_RESCHEDULE_PROPOSED: { icon: "booking", title: "New time proposed", action: "View booking" },
  INSPECTION_BOOKING_RESCHEDULED: { icon: "booking", title: "Booking rescheduled", action: "View booking" },
  CERTIFICATE_ISSUED: { icon: "certificate", title: "Certificate issued", action: "View certificate" },
  CERTIFICATE_BULK_COMPLETED: { icon: "certificate", title: "Certificates generated", action: "View certificates" },
  CERTIFICATE_REVOKED: { icon: "certificate", title: "Certificate revoked", action: "View certificate" },
  USER_INVITATION: { icon: "account", title: "Account invitation", action: "Open" },
  PASSWORD_RESET: { icon: "account", title: "Password reset", action: "Open" },
  MFA_CODE: { icon: "account", title: "Verification code", action: "Open" },
  SUSPICIOUS_LOGIN: { icon: "account", title: "Unusual sign-in", action: "Review" },
  ROLE_CHANGED: { icon: "account", title: "Role changed", action: "Open" },
  DEVICE_REGISTERED: { icon: "device", title: "Device registered", action: "View devices" },
  DEVICE_REVOKED: { icon: "device", title: "Device revoked", action: "View devices" },
  OFFLINE_WINDOW_EXPIRING: { icon: "device", title: "Offline access expiring", action: "Open" }
};

function humanise(category: string): string {
  const words = category.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.length === 0 ? "" : `${words[0][0].toUpperCase()}${words[0].slice(1)} ${words.slice(1).join(" ")}`.trim();
}

/** A known category's wording, or a safe generic one for a category added later. */
export function presentCategory(category: string): CategoryPresentation {
  return (
    PRESENTATION[category] ?? { icon: "general", title: humanise(category) || "Update", action: "Open" }
  );
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60]
];

/** "5 minutes ago". An unreadable timestamp reads as "recently" rather than "Invalid Date". */
export function relativeTime(value: string, now: number = Date.now()): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "recently";
  const elapsed = Math.round((time - now) / 1000);
  const [unit, size] = UNITS.find(([, seconds]) => Math.abs(elapsed) >= seconds) ?? ["second", 1];
  if (unit === "second" && Math.abs(elapsed) < 45) return "just now";
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(elapsed / size), unit);
}

/** The exact time, for a tooltip and for assistive technology. */
export function exactTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time unknown"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
