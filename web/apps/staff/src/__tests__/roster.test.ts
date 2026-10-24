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
});
