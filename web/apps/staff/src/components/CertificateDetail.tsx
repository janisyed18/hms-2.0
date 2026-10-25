import { Ban, Copy, Download, FileCheck2, RotateCcw, X } from "lucide-react";

import { ActionButton } from "./interaction/ActionButton";
import type { CertificateRecord } from "../domain/types";
import { assetLabel } from "../utils/identity";

interface CertificateDetailProps {
  canManage: boolean;
  certificate: CertificateRecord | null;
  onClose: () => void;
  onRequestRevoke: () => void;
  onRequestSupersede: () => void;
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

function certificateDownloadUrl(publicToken: string) {
  return `/api/v1/certificates/verify/${encodeURIComponent(publicToken)}/pdf?download=true`;
}

export function CertificateDetail({
  canManage,
  certificate,
  onClose,
  onRequestRevoke,
  onRequestSupersede
}: CertificateDetailProps) {
  if (!certificate) {
    return (
      <aside className="inspection-detail-panel certificate-detail-panel" aria-label="Certificate detail">
        <div className="empty-detail">
          <strong>Select a certificate</strong>
          <span>Open a row to review issue metadata and verification data.</span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="inspection-detail-panel certificate-detail-panel" aria-label="Certificate detail">
      <div className="inspection-detail-header">
        <div>
          <h2>{certificate.number}</h2>
          <p>{certificate.customer.name} / {assetLabel(certificate.asset)}</p>
        </div>
        <div className="certificate-detail-header-actions">
          <a
            aria-label={`Download certificate ${certificate.number} PDF`}
            className="secondary-button certificate-download-link"
            download={`${certificate.number}.pdf`}
            href={certificateDownloadUrl(certificate.publicToken)}
          >
            <Download aria-hidden="true" size={16} />
            Download PDF
          </a>
          <button
            aria-label="Close certificate detail"
            className="icon-button light"
            onClick={onClose}
            type="button"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="inspection-detail-strip">
        <span className={statusClass(certificate.status)}>{certificate.status}</span>
        <span>Version {certificate.certificateVersion}</span>
        <span>Valid until {certificate.validUntil ?? "Not set"}</span>
      </div>

      <div className="inspection-facts">
        <div>
          <span>Asset</span>
          <strong>{assetLabel(certificate.asset)}</strong>
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

      {canManage && certificate.status === "ISSUED" ? (
        <div className="certificate-actions" aria-label="Certificate lifecycle actions">
          <div className="certificate-action-band">
            <FileCheck2 aria-hidden="true" size={18} />
            <span>Lifecycle changes are retained as certificate status history.</span>
          </div>
          <div className="inspection-action-row">
            <ActionButton onClick={onRequestSupersede} variant="secondary">
              <RotateCcw aria-hidden="true" size={16} />
              Mark superseded
            </ActionButton>
            <ActionButton onClick={onRequestRevoke} variant="secondary">
              <Ban aria-hidden="true" size={16} />
              Revoke certificate
            </ActionButton>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
