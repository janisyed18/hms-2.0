import type { SyncBootstrapResponse } from "../domain/types";

const changedAt = "2026-07-04T00:00:00.000Z";

export const mockBootstrapResponse: SyncBootstrapResponse = {
  device: {
    device_id: "inspector-browser-dev",
    platform: "web",
    app_version: "0.1.0",
    offline_window_days: 7,
    revoked: false
  },
  cursor: 8,
  has_more: false,
  records: [
    {
      seq: 1,
      entity: "Asset",
      entity_id: "asset-0891",
      op: "upsert",
      version: 2,
      changed_at: changedAt,
      payload: {
        id: "asset-0891",
        asset_number: "HOS-2024-0891",
        lifecycle_status: "IN_SERVICE",
        next_retest_due_at: "2026-05-15",
        customer: {
          id: "cust-001",
          code: "CUST-001",
          name: "North Sea Shipping Ltd"
        },
        product: {
          id: "prod-wp20",
          code: "WP20",
          name: "Composite 2\" WP20",
          category: "Composite hose"
        },
        location: {
          id: "loc-dock-a",
          name: "Dock A - Bay 3",
          city: "Newcastle",
          state: "NSW",
          country: "AU"
        }
      }
    },
    {
      seq: 2,
      entity: "RetestSchedule",
      entity_id: "schedule-0891",
      op: "upsert",
      version: 2,
      changed_at: changedAt,
      payload: {
        id: "schedule-0891",
        asset_id: "asset-0891",
        due_at: "2026-05-15",
        status: "OVERDUE"
      }
    },
    {
      seq: 3,
      entity: "Asset",
      entity_id: "asset-0201",
      op: "upsert",
      version: 1,
      changed_at: changedAt,
      payload: {
        id: "asset-0201",
        asset_number: "HOS-2025-0201",
        lifecycle_status: "IN_SERVICE",
        next_retest_due_at: "2026-07-04",
        customer: {
          id: "cust-002",
          code: "CUST-002",
          name: "Pacific Marine Ltd"
        },
        product: {
          id: "prod-wp15",
          code: "WP15",
          name: "Rubber 3\" WP15",
          category: "Rubber hose"
        },
        location: {
          id: "loc-bay-1",
          name: "Dock B - Bay 1",
          city: "Fremantle",
          state: "WA",
          country: "AU"
        }
      }
    },
    {
      seq: 4,
      entity: "RetestSchedule",
      entity_id: "schedule-0201",
      op: "upsert",
      version: 1,
      changed_at: changedAt,
      payload: {
        id: "schedule-0201",
        asset_id: "asset-0201",
        due_at: "2026-07-04",
        status: "DUE"
      }
    },
    {
      seq: 5,
      entity: "Asset",
      entity_id: "asset-0156",
      op: "upsert",
      version: 1,
      changed_at: changedAt,
      payload: {
        id: "asset-0156",
        asset_number: "HOS-2025-0156",
        lifecycle_status: "IN_SERVICE",
        next_retest_due_at: "2026-07-01",
        customer: {
          id: "cust-003",
          code: "CUST-003",
          name: "Bateman Offshore"
        },
        product: {
          id: "prod-ss-wp50",
          code: "SS-WP50",
          name: "SS 1.5\" WP50",
          category: "Stainless hose"
        },
        location: {
          id: "loc-vessel-deck",
          name: "Vessel deck",
          city: "Darwin",
          state: "NT",
          country: "AU"
        }
      }
    },
    {
      seq: 6,
      entity: "Inspection",
      entity_id: "inspection-0156",
      op: "upsert",
      version: 1,
      changed_at: changedAt,
      payload: {
        id: "inspection-0156",
        asset_id: "asset-0156",
        status: "DRAFT",
        inspection_type: "SERVICE"
      }
    }
  ]
};
