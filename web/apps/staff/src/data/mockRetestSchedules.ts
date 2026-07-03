import type { RetestScheduleRecord } from "../domain/types";

export const mockRetestSchedules: RetestScheduleRecord[] = [
  {
    id: "retest-1001",
    assetId: "asset-1001",
    customerId: "cust-1005",
    dueAt: "2026-07-15",
    status: "OVERDUE",
    reminderIntervalDays: 30,
    escalationIntervalDays: 7,
    lastRemindedAt: "2026-06-15T09:00:00Z",
    escalatedAt: "2026-07-01T09:00:00Z",
    asset: {
      id: "asset-1001",
      assetNumber: "997950",
      tag: "HMS-997950",
      lifecycleStatus: "OVERDUE"
    },
    customer: {
      id: "cust-1005",
      code: "VOPA",
      name: "Vopak"
    },
    product: {
      id: "product-1001",
      code: "1000GY",
      name: "FUELFLEX GREEN",
      category: "Composite"
    }
  },
  {
    id: "retest-1002",
    assetId: "asset-1002",
    customerId: "cust-1006",
    dueAt: "2026-07-28",
    status: "DUE",
    reminderIntervalDays: 30,
    escalationIntervalDays: 10,
    lastRemindedAt: null,
    escalatedAt: null,
    asset: {
      id: "asset-1002",
      assetNumber: "ORIC-100",
      tag: "HMS-ORIC-100",
      lifecycleStatus: "IN_SERVICE"
    },
    customer: {
      id: "cust-1006",
      code: "ORIC",
      name: "Orica"
    },
    product: {
      id: "product-1002",
      code: "SS1",
      name: "SS1 CONV",
      category: "Stainless Steel"
    }
  },
  {
    id: "retest-1003",
    assetId: "asset-1003",
    customerId: "cust-1005",
    dueAt: "2026-09-30",
    status: "UPCOMING",
    reminderIntervalDays: 45,
    escalationIntervalDays: 14,
    lastRemindedAt: null,
    escalatedAt: null,
    asset: {
      id: "asset-1003",
      assetNumber: "VOPA-NEW",
      tag: "HMS-VOPA-NEW",
      lifecycleStatus: "IN_SERVICE"
    },
    customer: {
      id: "cust-1005",
      code: "VOPA",
      name: "Vopak"
    },
    product: {
      id: "product-1001",
      code: "1000GY",
      name: "FUELFLEX GREEN",
      category: "Composite"
    }
  }
];
