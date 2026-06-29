import type { InspectionRecord } from "../domain/types";

export const mockInspections: InspectionRecord[] = [
  {
    id: "inspection-1001",
    assetId: "asset-1001",
    inspectionType: "SERVICE",
    status: "DRAFT",
    result: "REVIEW",
    inspectorUserId: "inspector-1",
    reviewerUserId: null,
    submittedAt: null,
    approvedAt: null,
    rejectedAt: null,
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
    },
    pressureTest: {
      id: "pressure-1001",
      appliedPressureKpa: 1500,
      holdTimeSeconds: 300,
      passed: true,
      measurements: { leak: "none" }
    }
  },
  {
    id: "inspection-1002",
    assetId: "asset-1002",
    inspectionType: "SERVICE",
    status: "SUBMITTED",
    result: "PASS",
    inspectorUserId: "inspector-2",
    reviewerUserId: null,
    submittedAt: "2026-06-29T10:00:00Z",
    approvedAt: null,
    rejectedAt: null,
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
    },
    pressureTest: {
      id: "pressure-1002",
      appliedPressureKpa: 1200,
      holdTimeSeconds: 240,
      passed: true,
      measurements: { visual: "ok" }
    }
  },
  {
    id: "inspection-1003",
    assetId: "asset-1001",
    inspectionType: "NEW_ASSET",
    status: "APPROVED",
    result: "PASS",
    inspectorUserId: "inspector-1",
    reviewerUserId: "staff-ui-dev",
    submittedAt: "2026-06-28T09:00:00Z",
    approvedAt: "2026-06-28T11:15:00Z",
    rejectedAt: null,
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
    },
    pressureTest: null
  }
];
