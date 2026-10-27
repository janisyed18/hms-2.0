import type { NotificationRecord } from "../domain/types";

/** Where a notification leads, in terms of this app's workspaces. */
export interface NotificationTarget {
  module: "assets" | "inspections" | "customers" | "certificates" | "scheduling" | "bookings" | "devices" | "users";
  assetId?: string;
  inspectionId?: string;
  customerId?: string;
}

/**
 * The ids on the notification decide where it goes; the category only breaks ties for the
 * workspaces that have no record page. Null means there is nowhere better than the list.
 */
export function notificationTarget(
  notification: Pick<NotificationRecord, "subjectType" | "subjectId" | "assetId" | "customerId">,
  surface: "staff" | "portal"
): NotificationTarget | null {
  const { subjectType, subjectId } = notification;
  if (subjectType === "inspection" && subjectId) return { module: "inspections", inspectionId: subjectId };
  if (subjectType === "asset" && subjectId) return { module: "assets", assetId: subjectId };
  if (subjectType === "inspection_booking") return { module: surface === "portal" ? "bookings" : "scheduling" };
  if (subjectType === "certificate") return { module: "certificates" };
  if (surface === "staff" && subjectType === "device") return { module: "devices" };
  if (surface === "staff" && subjectType === "user") return { module: "users" };
  if (notification.assetId) return { module: "assets", assetId: notification.assetId };
  if (surface === "staff" && notification.customerId) return { module: "customers", customerId: notification.customerId };
  return null;
}
