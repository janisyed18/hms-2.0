import type { AssetRecord } from "../domain/types";

export const mockAssets: AssetRecord[] = [
  {
    id: "asset-1001",
    assetNumber: "997950",
    customerSerialNo: "VOPA-SN-1",
    tag: "HMS-997950",
    lifecycleStatus: "OVERDUE",
    manufactureDate: "2023-05-02",
    nextRetestDueAt: "2023-11-02",
    condemnedAt: null,
    lengthM: "6.100",
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
    location: {
      id: "loc-1001",
      name: "Site A",
      city: "Port Botany",
      state: "NSW",
      country: "AU"
    },
    retestSchedule: {
      dueAt: "2023-11-02",
      status: "OVERDUE"
    }
  },
  {
    id: "asset-1002",
    assetNumber: "ORIC-100",
    customerSerialNo: "ORIC-SN-1",
    tag: "HMS-ORIC-100",
    lifecycleStatus: "IN_SERVICE",
    manufactureDate: null,
    nextRetestDueAt: null,
    condemnedAt: null,
    lengthM: null,
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
    location: null,
    retestSchedule: null
  }
];
