import type { AdminUserRecord } from "../domain/types";
import type { InspectorOption } from "./scheduleModel";

/** The admin users API returns at most this many users per request. */
export const ROSTER_PAGE_SIZE = 100;
// A safety stop, not a business limit: 200 pages is 20,000 users.
const MAX_PAGES = 200;

type ListUsers = (options: {
  sort: string;
  limit: number;
  after?: string;
}) => Promise<{ items: AdminUserRecord[]; nextAfter: string | null }>;

export interface RosterResult {
  inspectors: InspectorOption[];
  /** Set when a later page failed: `inspectors` then holds what was loaded so far. */
  error: string | null;
}

/**
 * Every active Inspector, read with bounded page requests (the API has no role
 * filter, so each page is filtered here). Pages follow an email keyset cursor rather
 * than an offset, so users added or removed mid-load cannot shift one out of reach.
 * Deduplicated by user id and ordered by name.
 */
export async function loadActiveInspectors(list: ListUsers, maxPages = MAX_PAGES): Promise<RosterResult> {
  const found = new Map<string, InspectorOption>();
  let after: string | undefined;
  let error: string | null = null;
  let reachedEnd = false;
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const result = await list({ sort: "email", limit: ROSTER_PAGE_SIZE, after });
      for (const user of result.items) {
        if (user.role === "INSPECTOR" && user.accountStatus === "ACTIVE") {
          found.set(user.id, { id: user.id, name: user.displayName });
        }
      }
      if (!result.nextAfter) {
        reachedEnd = true;
        break;
      }
      // A continuation that is empty or does not move forward cannot make progress; stop rather than loop.
      if (result.items.length === 0 || result.nextAfter === after) {
        error = "Inspector list incomplete: users changed while the roster was loading.";
        break;
      }
      after = result.nextAfter;
    }
    // The cap ended the loop with users still unread: say so rather than show a short list as whole.
    if (!reachedEnd && !error) error = "Inspector list incomplete: too many users to read in one go.";
  } catch (reason) {
    error = reason instanceof Error ? reason.message : "Inspectors could not be loaded.";
  }
  return {
    inspectors: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)),
    error
  };
}
