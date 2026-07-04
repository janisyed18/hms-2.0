import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncClient, mapBootstrapToWorkItems } from "../api/syncClient";
import { mockBootstrapResponse } from "../data/mockSync";
import type { OutboxOperation } from "../domain/types";

describe("syncClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends development identity and device headers to bootstrap", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockBootstrapResponse
    });

    const client = createSyncClient({ fetchImpl: fetchMock });
    await client.bootstrap();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/sync/bootstrap",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-HMS-User-Id": "inspector-ui-dev",
          "X-HMS-Roles": "INSPECTOR",
          "X-HMS-Device-Id": "inspector-browser-dev",
          "X-HMS-Device-Platform": "web",
          "X-HMS-App-Version": "0.1.0"
        })
      })
    );
  });

  it("maps bootstrap records into queue-first work items", () => {
    const items = mapBootstrapToWorkItems(mockBootstrapResponse);

    expect(items[0]).toMatchObject({
      assetNumber: "HOS-2024-0891",
      customerName: "North Sea Shipping Ltd",
      urgency: "overdue"
    });
  });

  it("pushes outbox operations to the sync push endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ cursor: 9, results: [] })
    });
    const client = createSyncClient({ fetchImpl: fetchMock });

    const operation: OutboxOperation = {
      opId: "op-1",
      idempotencyKey: "idem-1",
      entity: "Inspection",
      entityId: "inspection-1",
      assetId: "asset-1",
      assetNumber: "HOS-2024-0891",
      customerName: "North Sea Shipping Ltd",
      op: "create",
      baseVersion: null,
      payload: { status: "DRAFT" },
      status: "pending",
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:00.000Z"
    };

    await client.push([operation]);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/sync/push",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          operations: [
            {
              op_id: "op-1",
              idempotency_key: "idem-1",
              entity: "Inspection",
              entity_id: "inspection-1",
              op: "create",
              base_version: null,
              payload: { status: "DRAFT" }
            }
          ]
        })
      })
    );
  });

  it("throws a readable sync error when the API response fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => "Version conflict"
    });
    const client = createSyncClient({ fetchImpl: fetchMock });

    await expect(client.bootstrap()).rejects.toThrow(
      "Sync request failed with 409: Version conflict"
    );
  });
});
