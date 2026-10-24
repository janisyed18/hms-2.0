import { describe, expect, it, vi } from "vitest";
import type { AdminUserRecord } from "../domain/types";
import { loadActiveInspectors, ROSTER_PAGE_SIZE } from "../scheduling/roster";

function user(index: number): AdminUserRecord {
  const id = `ins-${String(index).padStart(4, "0")}`;
  return { id, displayName: `Inspector ${id}`, role: "INSPECTOR", accountStatus: "ACTIVE" } as AdminUserRecord;
}

function serve(total: number) {
  return vi.fn(async ({ offset, limit }: { sort: string; limit: number; offset: number }) => ({
    total,
    items: Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => user(offset + i))
  }));
}

describe("loadActiveInspectors page cap", () => {
  it("reports the list as incomplete, and keeps what loaded, when the cap ends the loop early", async () => {
    const list = serve(ROSTER_PAGE_SIZE * 5);
    const result = await loadActiveInspectors(list, 3);
    expect(list).toHaveBeenCalledTimes(3);
    expect(result.error).toMatch(/inspector list incomplete/i);
    expect(result.inspectors).toHaveLength(ROSTER_PAGE_SIZE * 3);
  });

  it("is complete, with no error, when the last allowed page reaches the total", async () => {
    const result = await loadActiveInspectors(serve(ROSTER_PAGE_SIZE * 3), 3);
    expect(result.error).toBeNull();
    expect(result.inspectors).toHaveLength(ROSTER_PAGE_SIZE * 3);
  });

  it("reports the list as incomplete, keeping what loaded, when an empty page arrives before the total is read", async () => {
    const list = vi.fn(async ({ offset }: { sort: string; limit: number; offset: number }) => ({
      total: ROSTER_PAGE_SIZE * 2,
      items: offset === 0 ? Array.from({ length: ROSTER_PAGE_SIZE }, (_, i) => user(i)) : []
    }));
    const result = await loadActiveInspectors(list);
    expect(list).toHaveBeenCalledTimes(2);
    expect(result.error).toMatch(/inspector list incomplete/i);
    expect(result.inspectors).toHaveLength(ROSTER_PAGE_SIZE);
  });

  it("treats an empty roster whose total is zero as complete", async () => {
    const result = await loadActiveInspectors(serve(0));
    expect(result.error).toBeNull();
    expect(result.inspectors).toEqual([]);
  });
});

describe("loadActiveInspectors under concurrent changes", () => {
  // KNOWN GAP: offset pagination skips a user when an already-read user is removed
  // between pages. `it.fails` keeps CI green while the gap exists; once pagination is
  // stable (cursor or snapshot) this starts passing, Vitest reports the unexpected
  // pass, and the test must become a normal `it`.
  it.fails("does not skip a user when an already-read user is removed between pages", async () => {
    const backing = Array.from({ length: ROSTER_PAGE_SIZE + 2 }, (_, i) => user(i));
    const list = vi.fn(async ({ offset, limit }: { sort: string; limit: number; offset: number }) => {
      if (offset === ROSTER_PAGE_SIZE) {
        // Page 1 is already read; one of its users is removed before page 2.
        backing.splice(50, 1);
      }
      return { total: backing.length, items: backing.slice(offset, offset + limit) };
    });

    const result = await loadActiveInspectors(list);

    // ins-0100 still exists, but it shifted into the already-read range, so
    // offset 100 now starts after it and it never reaches the roster.
    expect(backing.map((u) => u.id)).toContain("ins-0100");
    expect(result.inspectors.map((inspector) => inspector.id)).toContain("ins-0100");
  });
});
