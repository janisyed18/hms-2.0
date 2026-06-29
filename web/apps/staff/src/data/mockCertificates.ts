import type { CertificateRecord } from "../domain/types";

export const mockCertificates: CertificateRecord[] = [
  {
    id: "certificate-1001",
    inspectionId: "inspection-cert-1001",
    assetId: "asset-1003",
    number: "CERT-VOPA-NEW-1",
    certificateVersion: 1,
    issuedAt: "2026-06-28T12:00:00Z",
    validUntil: "2027-06-28",
    pdfObjectKey: "certificates/CERT-VOPA-NEW-1.pdf",
    verificationHash: "hash-vopa-new-1",
    publicToken: "public-token-vopa-new-1",
    issuedByUserId: "staff-ui-dev",
    status: "ISSUED",
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
    },
    inspection: {
      id: "inspection-cert-1001",
      inspectionType: "NEW_ASSET",
      status: "APPROVED",
      result: "PASS",
      approvedAt: "2026-06-28T11:15:00Z"
    }
  }
];
