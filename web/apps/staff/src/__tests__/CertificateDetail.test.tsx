import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CertificateDetail } from "../components/CertificateDetail";
import type { CertificateRecord } from "../domain/types";

const certificate: CertificateRecord = {
  id: "certificate-1",
  inspectionId: "inspection-1",
  assetId: "asset-1",
  number: "CERT-HA-00123-1",
  certificateVersion: 1,
  issuedAt: "2026-10-09T10:30:00Z",
  validUntil: "2027-10-09",
  pdfObjectKey: "certificates/CERT-HA-00123-1.pdf",
  verificationHash: "a".repeat(64),
  publicToken: "public-token-123",
  issuedByUserId: "admin-1",
  status: "ISSUED",
  asset: {
    id: "asset-1",
    assetNumber: "HA-00123",
    tag: "TAG-88",
    lifecycleStatus: "IN_SERVICE"
  },
  customer: { id: "customer-1", code: "ACME", name: "Acme Mining" },
  product: { id: "product-1", code: "HP-2W", name: "Hydraulic Hose", category: "Hydraulic" },
  inspection: {
    id: "inspection-1",
    inspectionType: "SERVICE",
    status: "APPROVED",
    result: "PASS",
    approvedAt: "2026-10-09T10:00:00Z"
  }
};

describe("CertificateDetail", () => {
  it("downloads the signed PDF through the token-scoped certificate endpoint", () => {
    render(
      <CertificateDetail
        canManage
        certificate={certificate}
        onClose={vi.fn()}
        onRevoke={vi.fn()}
        onSupersede={vi.fn()}
      />
    );

    const link = screen.getByRole("link", {
      name: "Download certificate CERT-HA-00123-1 PDF"
    });

    expect(link).toHaveAttribute(
      "href",
      "/api/v1/certificates/verify/public-token-123/pdf?download=true"
    );
    expect(link).toHaveAttribute("download", "CERT-HA-00123-1.pdf");
  });
});
