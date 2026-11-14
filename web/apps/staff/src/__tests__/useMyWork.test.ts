import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useMyWork } from "../hooks/useMyWork";
import type { MyWorkRecord } from "../domain/types";

const feed = (): MyWorkRecord => ({
  summary: { total: 1, urgent: 0, dueSoon: 0, normal: 1 },
  items: [
    {
      id: "CONTINUE_INSPECTION:INSPECTION:inspection-1",
      kind: "INSPECTION",
      state: "IN_PROGRESS",
      priority: "NORMAL",
      title: "In progress",
      summary: "Continue the inspection.",
      customerId: "customer-1",
      customerName: "Mine Ltd",
      assetId: "asset-1",
      assetNumber: "A-100",
      inspectionId: "inspection-1",
      bookingId: null,
      certificateId: null,
      dueAt: null,
      updatedAt: "2026-10-01T00:00:00Z",
      nextAction: {
        code: "CONTINUE_INSPECTION",
        label: "Continue inspection",
        targetType: "INSPECTION",
        targetId: "inspection-1",
        inspectionId: null
      }
    }
  ],
  limit: 50,
  sourceLimit: 500,
  sourceLimited: false
});

describe("useMyWork", () => {
  it("reports a failed refresh, not a failed load, when the failure lands before React commits", async () => {
    // A refresh asked for while the first load is in flight is queued, and the queued run
    // starts the moment that load resolves: inside the same promise chain, before React has
    // committed the render carrying the results. Whether work is already held must not be
    // read from an effect, which has not run yet at that point.
    let releaseFirstLoad: (() => void) | undefined;
    const firstLoad = new Promise<MyWorkRecord>((resolve) => {
      releaseFirstLoad = () => resolve(feed());
    });
    const getMyWork = vi
      .fn()
      .mockReturnValueOnce(firstLoad)
      .mockRejectedValueOnce(new Error("offline"));

    const { result } = renderHook(() => useMyWork({ client: { getMyWork }, pollMs: 60_000 }));

    // Queued behind the first load, so it runs as soon as that resolves.
    void result.current.refresh();
    releaseFirstLoad?.();

    await waitFor(() => expect(getMyWork).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.work?.items).toHaveLength(1);
    expect(result.current.error).toBe("My Work could not be refreshed. Try again.");
  });

  it("reports a failed load when the very first request fails", async () => {
    const getMyWork = vi.fn().mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useMyWork({ client: { getMyWork }, pollMs: 60_000 }));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.work).toBeNull();
    expect(result.current.error).toBe("My Work could not be loaded. Try again.");
  });
});
