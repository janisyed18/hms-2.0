import { describe, expect, it, vi } from "vitest";
import type { AdminUserRecord } from "../domain/types";
import { loadActiveInspectors, ROSTER_PAGE_SIZE } from "../scheduling/roster";

function user(index: number): AdminUserRecord {
  const id = `ins-${String(index).padStart(4, "0")}`;
  return { id, displayName: `Inspector ${id}`, role: "INSPECTOR", accountStatus: "ACTIVE" } as AdminUserRecord;
}

type Call = { sort: string; limit: number; after?: string };

/** Mimics the API's keyset contract over `backing` (in id order): a cursor only when more users remain. */
function page(backing: AdminUserRecord[], { limit, after }: Call) {
  const rest = after === undefined ? backing : backing.filter((u) => u.id > after);
  const items = rest.slice(0, limit);
  return { items, nextAfter: rest.length > limit ? items[items.length - 1].id : null };
}

function serve(total: number) {
  const backing = Array.from({ length: total }, (_, i) => user(i));
  return vi.fn(async (call: Call) => page(backing, call));
}

describe("loadActiveInspectors page cap", () => {
  it("reports the list as incomplete, and keeps what loaded, when the cap ends the loop early", async () => {
    const list = serve(ROSTER_PAGE_SIZE * 5);
    const result = await loadActiveInspectors(list, 3);
    expect(list).toHaveBeenCalledTimes(3);
    expect(result.error).toMatch(/inspector list incomplete/i);
    expect(result.inspectors).toHaveLength(ROSTER_PAGE_SIZE * 3);
  });

  it("is complete, with no error, when exactly maxPages full pages hold every user", async () => {
    const list = serve(ROSTER_PAGE_SIZE * 3);
    const result = await loadActiveInspectors(list, 3);
    expect(list).toHaveBeenCalledTimes(3);
    expect(result.error).toBeNull();
    expect(result.inspectors).toHaveLength(ROSTER_PAGE_SIZE * 3);
  });

  it("reports the cap error when one user is left beyond maxPages full pages", async () => {
    const result = await loadActiveInspectors(serve(ROSTER_PAGE_SIZE * 3 + 1), 3);
    expect(result.error).toMatch(/too many users/i);
    expect(result.inspectors).toHaveLength(ROSTER_PAGE_SIZE * 3);
  });

  it("reports the list as incomplete, keeping what loaded, when an empty page still promises more", async () => {
    const list = vi.fn(async ({ after }: Call) =>
      after === undefined
        ? { items: Array.from({ length: ROSTER_PAGE_SIZE }, (_, i) => user(i)), nextAfter: "ins-0099" }
        : { items: [], nextAfter: "ins-0099" }
    );
    const result = await loadActiveInspectors(list);
    expect(list).toHaveBeenCalledTimes(2);
    expect(result.error).toMatch(/inspector list incomplete/i);
    expect(result.inspectors).toHaveLength(ROSTER_PAGE_SIZE);
  });

  it("stops with an incomplete error when the cursor does not advance", async () => {
    const list = vi.fn(async () => ({ items: [user(0)], nextAfter: "ins-0000" }));
    const result = await loadActiveInspectors(list);
    expect(list).toHaveBeenCalledTimes(2);
    expect(result.error).toMatch(/inspector list incomplete/i);
  });

  it("treats an empty roster as complete", async () => {
    const result = await loadActiveInspectors(serve(0));
    expect(result.error).toBeNull();
    expect(result.inspectors).toEqual([]);
  });
});

describe("loadActiveInspectors under concurrent changes", () => {
  it("does not skip a user when an already-read user is removed between pages", async () => {
    const backing = Array.from({ length: ROSTER_PAGE_SIZE + 2 }, (_, i) => user(i));
    const list = vi.fn(async (call: Call) => {
      if (call.after !== undefined) {
        // Page 1 is already read; one of its users is removed before page 2.
        const at = backing.findIndex((u) => u.id === "ins-0050");
        if (at >= 0) backing.splice(at, 1);
      }
      return page(backing, call);
    });

    const result = await loadActiveInspectors(list);

    expect(backing.map((u) => u.id)).toContain("ins-0100");
    const ids = result.inspectors.map((inspector) => inspector.id);
    expect(ids).toContain("ins-0100");
    expect(ids).toContain("ins-0101");
    expect(result.error).toBeNull();
  });
});
