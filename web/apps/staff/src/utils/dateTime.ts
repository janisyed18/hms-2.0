import { formatWithZone } from "../scheduling/zonedTime";

/** A system timestamp (audit event, last sync, last update). These carry no site, so they are shown in UTC and say so. */
export function formatDateTime(value: string): string {
  return formatWithZone(value, "UTC");
}
