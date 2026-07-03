import { Ban, Copy, FileCheck2, RotateCcw, X } from "lucide-react";
import { useState } from "react";

import type { CertificateRecord } from "../domain/types";

interface CertificateDetailProps {
  certificate: CertificateRecord | null;
  onClose: () => void;
  onRevoke: () => Promise<void>;
  onSupersede: () => Promise<void>;
}

function statusClass(status: string) {
  if (status === "REVOKED") {
    return "mini-status overdue";
  }
  if (status === "SUPERSEDED") {
    return "mini-status due-soon";
  }
  return "mini-status current";
}

export function CertificateDetail({
  certificate,
  onClose,
  onRevoke,
  onSupersede
}: CertificateDetailProps) {
  const [pendingAction, setPendingAction] = useState<"revoke" | "supersede" | null>(null);

  if (!certificate) {
    return (
      <aside className="inspection-detail-panel" aria-label="Certificate detail">
        <div className="empty-detail">
          <strong>Select a certificate</strong>
          <span>Open a row to review issue metadata and verification data.</span>
        </div>
      </aside>
    );
  }

  async function runLifecycleAction(action: "revoke" | "supersede") {
    setPendingAction(action);
    if (action === "revoke") {
      await onRevoke();
    } else {
      await onSupersede();
    }
    setPendingAction(null);
  }

  return (
    <aside className="inspection-detail-panel" aria-label="Certificate detail">
      <div className="inspection-detail-header">
        <div>
          <h2>{certificate.number}</h2>
          <p>{certificate.customer.name} / {certificate.asset.assetNumber}</p>
        </div>
        <button
          aria-label="Close certificate detail"
          className="icon-button light"
          onClick={onClose}
          type="button"
        >
          <X size={18} />
        </button>
      </div>

      <div className="inspection-detail-strip">
        <span className={statusClass(certificate.status)}>{certificate.status}</span>
        <span>Version {certificate.certificateVersion}</span>
        <span>Valid until {certificate.validUntil ?? "Not set"}</span>
      </div>

      <div className="inspection-facts">
        <div>
          <span>Asset</span>
          <strong>{certificate.asset.assetNumber}</strong>
        </div>
        <div>
          <span>Product</span>
          <strong>{certificate.product.name}</strong>
        </div>
        <div>
          <span>Issued by</span>
          <strong>{certificate.issuedByUserId}</strong>
        </div>
        <div>
          <span>Issued at</span>
          <strong>{certificate.issuedAt}</strong>
        </div>
      </div>

      <div className="certificate-verification">
        <div>
          <FileCheck2 aria-hidden="true" size={18} />
          <span>Public token</span>
          <strong>{certificate.publicToken}</strong>
        </div>
        <div>
          <Copy aria-hidden="true" size={18} />
          <span>Verification hash</span>
          <strong>{certificate.verificationHash}</strong>
        </div>
        <div>
          <span>PDF object key</span>
          <strong>{certificate.pdfObjectKey}</strong>
        </div>
        <div>
          <span>Source inspection</span>
          <strong>
            {certificate.inspection.inspectionType.replace("_", " ")} /{" "}
            {certificate.inspection.result ?? "Pending"}
          </strong>
        </div>
      </div>

      {certificate.status === "ISSUED" ? (
        <div className="certificate-actions" aria-label="Certificate lifecycle actions">
          <div className="certificate-action-band">
            <FileCheck2 aria-hidden="true" size={18} />
            <span>Lifecycle changes are retained as certificate status history.</span>
          </div>
          <div className="inspection-action-row">
            <button
              className="secondary-button"
              disabled={pendingAction !== null}
              onClick={() => runLifecycleAction("supersede")}
              type="button"
            >
              <RotateCcw aria-hidden="true" size={16} />
              {pendingAction === "supersede" ? "Updating..." : "Mark superseded"}
            </button>
            <button
              className="danger-button"
              disabled={pendingAction !== null}
              onClick={() => runLifecycleAction("revoke")}
              type="button"
            >
              <Ban aria-hidden="true" size={16} />
              {pendingAction === "revoke" ? "Updating..." : "Revoke certificate"}
            </button>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
