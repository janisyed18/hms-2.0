import { ArrowLeft, ClipboardCheck, Copy, FileCheck2, Edit3, X } from "lucide-react";

import type { AssetRecord } from "../domain/types";

interface AssetDetailProps {
  asset: AssetRecord;
  canWrite: boolean;
  onBack: () => void;
  onCopy: (asset: AssetRecord) => void;
  onEdit: (asset: AssetRecord) => void;
}

function locationLabel(asset: AssetRecord) {
  if (!asset.location) {
    return "No location";
  }

  return [
    asset.location.name,
    asset.location.address1,
    asset.location.address2,
    asset.location.city,
    asset.location.state,
    asset.location.country
  ]
    .filter(Boolean)
    .join(", ") || "No location";
}

function orDash(value: string | null | undefined) {
  return value && value.trim() ? value : "—";
}

function endValue(end: AssetRecord["aEnd"], property: "coupling" | "couplingAddOn" | "attachMethod") {
  return end[property]?.name ?? "—";
}

function materialLabel(asset: AssetRecord) {
  return asset.aEnd.material?.name ?? asset.bEnd.material?.name ?? "—";
}

function boreLabel(asset: AssetRecord) {
  return asset.aEnd.nominalBore?.name ?? asset.bEnd.nominalBore?.name ?? "—";
}

function historyDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString() : "Not recorded";
}

function historyStatus(status: string) {
  return `mini-status ${status.toLowerCase().replaceAll("_", "-")}`;
}

export function AssetDetail({ asset, canWrite, onBack, onCopy, onEdit }: AssetDetailProps) {
  const assetName = asset.assetName || asset.assetNumber;
  const { inspectionHistory, certificateHistory } = asset;

  return (
    <section className="detail-page" role="complementary" aria-label="Asset detail">
      <div className="detail-page-header">
        <button className="secondary-button detail-back" onClick={onBack} type="button">
          <ArrowLeft aria-hidden="true" size={16} />
          Back to list
        </button>
        <div className="detail-page-actions">
          <button
            aria-label="Close asset detail"
            className="icon-button light"
            onClick={onBack}
            type="button"
          >
            <X aria-hidden="true" size={16} />
          </button>
          {canWrite ? (
            <>
              <button className="secondary-button" onClick={() => onCopy(asset)} type="button">
                <Copy aria-hidden="true" size={16} />
                Copy
              </button>
              <button className="primary-button" onClick={() => onEdit(asset)} type="button">
                <Edit3 aria-hidden="true" size={16} />
                Edit
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="detail-page-title">
        <div>
          <h2>{assetName}</h2>
          <p>{asset.customer.name}{asset.location ? ` · ${asset.location.name}` : ""}</p>
        </div>
      </div>

      <section className="detail-section">
        <h3>Asset profile</h3>
        <dl className="info-grid">
          <div>
            <dt>Agent</dt>
            <dd>{asset.customer.name}</dd>
          </div>
          <div>
            <dt>Location</dt>
            <dd>{locationLabel(asset)}</dd>
          </div>
          <div>
            <dt>Asset name</dt>
            <dd>{assetName}</dd>
          </div>
          <div>
            <dt>Serial number</dt>
            <dd>{orDash(asset.customerSerialNo)}</dd>
          </div>
          <div>
            <dt>Purchase order number</dt>
            <dd>{orDash(asset.purchaseOrderNumber)}</dd>
          </div>
          <div>
            <dt>Notes</dt>
            <dd>{orDash(asset.notes ?? asset.description)}</dd>
          </div>
        </dl>
      </section>

      <section className="detail-section">
        <h3>Product and inspection</h3>
        <dl className="info-grid">
          <div>
            <dt>Product</dt>
            <dd>{asset.product.name}</dd>
          </div>
          <div>
            <dt>Installation date</dt>
            <dd>{asset.installationDate ?? "—"}</dd>
          </div>
          <div>
            <dt>Grave date</dt>
            <dd>{asset.graveDate ?? "—"}</dd>
          </div>
          <div>
            <dt>Next inspection date</dt>
            <dd>{asset.nextRetestDueAt ?? "Not scheduled"}</dd>
          </div>
          <div>
            <dt>Length (m)</dt>
            <dd>{orDash(asset.lengthM)}</dd>
          </div>
          <div>
            <dt>Material</dt>
            <dd>{materialLabel(asset)}</dd>
          </div>
          <div>
            <dt>Nominal bore</dt>
            <dd>{boreLabel(asset)}</dd>
          </div>
        </dl>
      </section>

      <section className="detail-section asset-history-section">
        <div className="asset-history-heading">
          <div>
            <h3>Record history</h3>
            <p>Inspection and certificate records linked to this asset.</p>
          </div>
        </div>
        <div className="asset-history-grid">
          <div className="asset-history-column">
            <h4><ClipboardCheck aria-hidden="true" size={16} /> Inspections</h4>
            {inspectionHistory.length ? (
              <ul className="asset-history-list">
                {inspectionHistory.map((inspection) => (
                  <li key={inspection.id}>
                    <div><strong>{inspection.inspectionType.replaceAll("_", " ")}</strong><span>{inspection.result ?? "Result pending"}</span></div>
                    <div><time>{historyDate(inspection.submittedAt ?? inspection.approvedAt)}</time><span className={historyStatus(inspection.status)}>{inspection.status}</span></div>
                  </li>
                ))}
              </ul>
            ) : <p className="history-empty">No inspections recorded.</p>}
          </div>
          <div className="asset-history-column">
            <h4><FileCheck2 aria-hidden="true" size={16} /> Certificates</h4>
            {certificateHistory.length ? (
              <ul className="asset-history-list">
                {certificateHistory.map((certificate) => (
                  <li key={certificate.id}>
                    <div><strong>{certificate.number}</strong><span>Version {certificate.certificateVersion}</span></div>
                    <div><time>{historyDate(certificate.issuedAt)}</time><span className={historyStatus(certificate.status)}>{certificate.status}</span></div>
                  </li>
                ))}
              </ul>
            ) : <p className="history-empty">No certificates recorded.</p>}
          </div>
        </div>
      </section>

      <section className="detail-section">
        <h3>End configuration</h3>
        <dl className="info-grid">
          <div>
            <dt>Coupling (A)</dt>
            <dd>{endValue(asset.aEnd, "coupling")}</dd>
          </div>
          <div>
            <dt>Add-ons (A)</dt>
            <dd>{endValue(asset.aEnd, "couplingAddOn")}</dd>
          </div>
          <div>
            <dt>Attach methods (A)</dt>
            <dd>{endValue(asset.aEnd, "attachMethod")}</dd>
          </div>
          <div>
            <dt>Coupling (B)</dt>
            <dd>{endValue(asset.bEnd, "coupling")}</dd>
          </div>
          <div>
            <dt>Add-ons (B)</dt>
            <dd>{endValue(asset.bEnd, "couplingAddOn")}</dd>
          </div>
          <div>
            <dt>Attach methods (B)</dt>
            <dd>{endValue(asset.bEnd, "attachMethod")}</dd>
          </div>
        </dl>
      </section>
    </section>
  );
}
