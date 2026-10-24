import type { AdminUserRecord } from "../domain/types";
import type { InspectorOption } from "./scheduleModel";

/** The admin users API returns at most this many users per request. */
export const ROSTER_PAGE_SIZE = 100;
// A safety stop, not a business limit: 200 pages is 20,000 users.
const MAX_PAGES = 200;

type ListUsers = (options: {
  sort: string;
  limit: number;
  offset: number;
}) => Promise<{ total: number; items: AdminUserRecord[] }>;

export interface RosterResult {
  inspectors: InspectorOption[];
  /** Set when a later page failed: `inspectors` then holds what was loaded so far. */
  error: string | null;
}

/**
 * Every active Inspector, read with bounded page requests (the API has no role
 * filter, so each page is filtered here). Deduplicated by user id and ordered by name.
 */
export async function loadActiveInspectors(list: ListUsers, maxPages = MAX_PAGES): Promise<RosterResult> {
  const found = new Map<string, InspectorOption>();
  let offset = 0;
  let error: string | null = null;
  let reachedEnd = false;
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const result = await list({ sort: "email", limit: ROSTER_PAGE_SIZE, offset });
      for (const user of result.items) {
        if (user.role === "INSPECTOR" && user.accountStatus === "ACTIVE") {
          found.set(user.id, { id: user.id, name: user.displayName });
        }
      }
      offset += result.items.length;
      if (result.items.length === 0 || offset >= result.total) {
        reachedEnd = true;
        break;
      }
    }
    // The cap ended the loop with users still unread: say so rather than show a short list as whole.
    if (!reachedEnd) error = "Inspector list incomplete: too many users to read in one go.";
  } catch (reason) {
    error = reason instanceof Error ? reason.message : "Inspectors could not be loaded.";
  }
  return {
    inspectors: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)),
    error
  };
}
