import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySyncChangesToRecords,
  createSyncClient,
  mapBootstrapToWorkItems
} from "../api/syncClient";
import { mockBootstrapResponse } from "../data/mockSync";
import type { OutboxOperation, SyncBootstrapResponse } from "../domain/types";

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

  it("maps normalized backend sync records into queue-first work items", () => {
    const backendBootstrap: SyncBootstrapResponse = {
      ...mockBootstrapResponse,
      records: [
        {
          seq: null,
          entity: "Customer",
          entity_id: "customer-1",
          op: "upsert",
          version: 1,
          changed_at: null,
          payload: {
            id: "customer-1",
            code: "VOPA",
            name: "Vopak Terminals"
          }
        },
        {
          seq: null,
          entity: "Product",
          entity_id: "product-1",
          op: "upsert",
          version: 1,
          changed_at: null,
          payload: {
            id: "product-1",
            code: "1000GY",
            name: "FUELFLEX GREEN",
            category: "Composite"
          }
        },
        {
          seq: null,
          entity: "CustomerLocation",
          entity_id: "location-1",
          op: "upsert",
          version: 1,
          changed_at: null,
          payload: {
            id: "location-1",
            customer_id: "customer-1",
            name: "Site A",
            address_1: "1 Friendship Road",
            address_2: "Bay 3",
            city: "Port Botany",
            state: "NSW",
            country: "AU"
          }
        },
        {
          seq: null,
          entity: "Asset",
          entity_id: "asset-1",
          op: "upsert",
          version: 6,
          changed_at: null,
          payload: {
            id: "asset-1",
            asset_number: "997950",
            customer_id: "customer-1",
            location_id: "location-1",
            product_id: "product-1",
            lifecycle_status: "OVERDUE",
            next_retest_due_at: "2026-05-15"
          }
        },
        {
          seq: null,
          entity: "RetestSchedule",
          entity_id: "schedule-1",
          op: "upsert",
          version: 2,
          changed_at: null,
          payload: {
            id: "schedule-1",
            asset_id: "asset-1",
            due_at: "2026-05-15",
            status: "OVERDUE"
          }
        },
        {
          seq: null,
          entity: "Inspection",
          entity_id: "inspection-1",
          op: "upsert",
          version: 4,
          changed_at: null,
          payload: {
            id: "inspection-1",
            asset_id: "asset-1",
            status: "DRAFT",
            inspection_type: "SERVICE"
          }
        }
      ]
    };

    expect(mapBootstrapToWorkItems(backendBootstrap)[0]).toMatchObject({
      assetNumber: "997950",
      customerName: "Vopak Terminals",
      locationName: "Site A",
      locationAddress: "1 Friendship Road, Bay 3, Port Botany, NSW, AU",
      productName: "FUELFLEX GREEN",
      urgency: "draft",
      serverVersion: 4,
      inspectionId: "inspection-1"
    });
  });

  it("applies sync changes before remapping work items", () => {
    const merged = applySyncChangesToRecords(mockBootstrapResponse.records, [
      {
        seq: 9,
        entity: "RetestSchedule",
        entity_id: "schedule-0891",
        op: "upsert",
        version: 3,
        changed_at: "2026-07-04T01:00:00.000Z",
        payload: {
          id: "schedule-0891",
          asset_id: "asset-0891",
          due_at: "2026-07-04",
          status: "DUE"
        }
      },
      {
        seq: 10,
        entity: "Asset",
        entity_id: "asset-0201",
        op: "delete",
        version: 2,
        changed_at: "2026-07-04T01:05:00.000Z",
        payload: null
      }
    ]);

    const items = mapBootstrapToWorkItems({
      ...mockBootstrapResponse,
      records: merged
    });

    expect(items.find((item) => item.assetNumber === "HOS-2024-0891")).toMatchObject({
      urgency: "due-today"
    });
    expect(items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assetNumber: "HOS-2025-0201" })
      ])
    );
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

  it("serializes asset and pressure-test outbox operations", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ cursor: 12, results: [] })
    });
    const client = createSyncClient({ fetchImpl: fetchMock });

    const operations: OutboxOperation[] = [
      {
        opId: "op-asset",
        idempotencyKey: "idem-asset",
        entity: "Asset",
        entityId: "asset-1",
        assetId: "asset-1",
        assetNumber: "HOS-2024-0891",
        customerName: "North Sea Shipping Ltd",
        op: "update",
        baseVersion: 2,
        payload: { tag: "FIELD-TAG-1" },
        status: "pending",
        createdAt: "2026-07-04T00:00:00.000Z",
        updatedAt: "2026-07-04T00:00:00.000Z"
      },
      {
        opId: "op-pressure",
        idempotencyKey: "idem-pressure",
        entity: "PressureTestResult",
        entityId: "pressure-test-1",
        assetId: "asset-1",
        assetNumber: "HOS-2024-0891",
        customerName: "North Sea Shipping Ltd",
        op: "create",
        baseVersion: null,
        payload: {
          inspection_id: "inspection-1",
          applied_pressure_kpa: 30200,
          hold_time_seconds: 300,
          passed: true
        },
        status: "pending",
        createdAt: "2026-07-04T00:00:00.000Z",
        updatedAt: "2026-07-04T00:00:00.000Z"
      }
    ];

    await client.push(operations);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/sync/push",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          operations: [
            {
              op_id: "op-asset",
              idempotency_key: "idem-asset",
              entity: "Asset",
              entity_id: "asset-1",
              op: "update",
              base_version: 2,
              payload: { tag: "FIELD-TAG-1" }
            },
            {
              op_id: "op-pressure",
              idempotency_key: "idem-pressure",
              entity: "PressureTestResult",
              entity_id: "pressure-test-1",
              op: "create",
              base_version: null,
              payload: {
                inspection_id: "inspection-1",
                applied_pressure_kpa: 30200,
                hold_time_seconds: 300,
                passed: true
              }
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
