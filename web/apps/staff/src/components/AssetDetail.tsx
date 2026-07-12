import { ArrowLeft, Edit3, X } from "lucide-react";

import type { AssetRecord } from "../domain/types";

interface AssetDetailProps {
  asset: AssetRecord;
  canWrite: boolean;
  onBack: () => void;
  onEdit: (asset: AssetRecord) => void;
}

function statusClass(status: string) {
  if (status === "OVERDUE") {
    return "mini-status overdue";
  }
  if (status === "DUE") {
    return "mini-status due-soon";
  }
  return "mini-status current";
}

function endLabel(end: AssetRecord["aEnd"]) {
  const parts = [end.fitting.trim(), end.size.trim()].filter(Boolean);
  return parts.join(" ") || "Not recorded";
}

function locationLabel(asset: AssetRecord) {
  if (!asset.location) {
    return "No location";
  }
  return (
    [
      asset.location.name,
      asset.location.address1,
      asset.location.address2,
      asset.location.city,
      asset.location.state,
      asset.location.country
    ]
      .filter(Boolean)
      .join(", ") || "No location"
  );
}

function orDash(value: string | null | undefined) {
  return value && value.trim() ? value : "—";
}

export function AssetDetail({ asset, canWrite, onBack, onEdit }: AssetDetailProps) {
  return (
    <section className="detail-page" role="complementary" aria-label="Asset detail">
      <div className="detail-page-header">
        <button
          className="secondary-button detail-back"
          onClick={onBack}
          type="button"
        >
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
            <button
              className="primary-button"
              onClick={() => onEdit(asset)}
              type="button"
            >
              <Edit3 aria-hidden="true" size={16} />
              Edit
            </button>
          ) : null}
        </div>
      </div>

      <div className="detail-page-title">
        <div>
          <h2>{asset.assetNumber}</h2>
          {asset.notes ? <p>{asset.notes}</p> : null}
        </div>
        <span className={statusClass(asset.lifecycleStatus)}>
          {asset.lifecycleStatus.replace("_", " ")}
        </span>
      </div>

      <section className="detail-section">
        <h3>Identification</h3>
        <dl className="info-grid">
          <div>
            <dt>Asset ID</dt>
            <dd>{asset.assetNumber}</dd>
          </div>
          <div>
            <dt>Customer serial</dt>
            <dd>{orDash(asset.customerSerialNo)}</dd>
          </div>
          <div>
            <dt>Tag</dt>
            <dd>{orDash(asset.tag)}</dd>
          </div>
          <div>
            <dt>Lifecycle</dt>
            <dd>{asset.lifecycleStatus.replace("_", " ")}</dd>
          </div>
        </dl>
      </section>

      <section className="detail-section">
        <h3>Customer &amp; product</h3>
        <dl className="info-grid">
          <div>
            <dt>Customer</dt>
            <dd>{asset.customer.name}</dd>
          </div>
          <div>
            <dt>Product</dt>
            <dd>{asset.product.name}</dd>
          </div>
          <div>
            <dt>Category</dt>
            <dd>{orDash(asset.product.category)}</dd>
          </div>
          <div>
            <dt>Location</dt>
            <dd>{locationLabel(asset)}</dd>
          </div>
        </dl>
      </section>

      <section className="detail-section">
        <h3>Configuration</h3>
        <dl className="info-grid">
          <div>
            <dt>End A</dt>
            <dd>{endLabel(asset.aEnd)}</dd>
          </div>
          <div>
            <dt>End B</dt>
            <dd>{endLabel(asset.bEnd)}</dd>
          </div>
          <div>
            <dt>Length (m)</dt>
            <dd>{orDash(asset.lengthM)}</dd>
          </div>
          <div>
            <dt>Manufactured</dt>
            <dd>{orDash(asset.manufactureDate)}</dd>
          </div>
        </dl>
      </section>

      <section className="detail-section">
        <h3>Retest &amp; lifecycle</h3>
        <dl className="info-grid">
          <div>
            <dt>Retest due</dt>
            <dd>{asset.nextRetestDueAt ?? "Not scheduled"}</dd>
          </div>
          <div>
            <dt>Retest status</dt>
            <dd>{orDash(asset.retestSchedule?.status)}</dd>
          </div>
          <div>
            <dt>Condemned</dt>
            <dd>{orDash(asset.condemnedAt)}</dd>
          </div>
        </dl>
      </section>

      {asset.notes ? (
        <section className="detail-section">
          <h3>Notes</h3>
          <p className="record-notes">{asset.notes}</p>
        </section>
      ) : null}
    </section>
  );
}
