import type { AssetRecord } from "../domain/types";

export const mockAssets: AssetRecord[] = [
  {
    id: "asset-1001",
    assetNumber: "997950",
    assetName: "997950",
    customerSerialNo: "VOPA-SN-1",
    purchaseOrderNumber: null,
    tag: "HMS-997950",
    lifecycleStatus: "OVERDUE",
    manufactureDate: "2023-05-02",
    installationDate: null,
    graveDate: null,
    nextRetestDueAt: "2023-11-02",
    condemnedAt: null,
    lengthM: "6.100",
    notes: "Overdue assembly staged for retest coordination at Site A.",
    description: "Overdue assembly staged for retest coordination at Site A.",
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
      address1: "Primary operations site",
      address2: null,
      city: "Port Botany",
      state: "NSW",
      country: "AU"
    },
    retestSchedule: {
      dueAt: "2023-11-02",
      status: "OVERDUE"
    },
    aEnd: {
      fitting: "Camlock M",
      size: "2 inch",
      nominalBore: null,
      material: null,
      coupling: null,
      couplingAddOn: null,
      attachMethod: null
    },
    bEnd: {
      fitting: "Flange W",
      size: "2 inch",
      nominalBore: null,
      material: null,
      coupling: null,
      couplingAddOn: null,
      attachMethod: null
    }
  },
  {
    id: "asset-1002",
    assetNumber: "ORIC-100",
    assetName: "ORIC-100",
    customerSerialNo: "ORIC-SN-1",
    purchaseOrderNumber: null,
    tag: "HMS-ORIC-100",
    lifecycleStatus: "IN_SERVICE",
    manufactureDate: null,
    installationDate: null,
    graveDate: null,
    nextRetestDueAt: null,
    condemnedAt: null,
    lengthM: null,
    notes: "In-service stainless assembly with no scheduled retest date.",
    description: "In-service stainless assembly with no scheduled retest date.",
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
    retestSchedule: null,
    aEnd: {
      fitting: "BSP F",
      size: "1.5 inch",
      nominalBore: null,
      material: null,
      coupling: null,
      couplingAddOn: null,
      attachMethod: null
    },
    bEnd: {
      fitting: "Storz M",
      size: "1.5 inch",
      nominalBore: null,
      material: null,
      coupling: null,
      couplingAddOn: null,
      attachMethod: null
    }
  }
];
