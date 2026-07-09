import { CalendarClock, Database, MapPin, Ruler, X } from "lucide-react";

import type { AssetRecord } from "../domain/types";

interface AssetDetailProps {
  asset: AssetRecord;
  onClose: () => void;
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

function locationLabel(asset: AssetRecord) {
  if (!asset.location) {
    return "No location recorded";
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
    .join(", ");
}

function endLabel(end: AssetRecord["aEnd"]) {
  return [end.fitting.trim(), end.size.trim()].filter(Boolean).join(" ") || "Not recorded";
}

export function AssetDetail({ asset, onClose }: AssetDetailProps) {
  return (
    <aside className="inspection-detail-panel" aria-label="Asset detail">
      <div className="inspection-detail-header">
        <div>
          <h2>{asset.assetNumber}</h2>
          <p>{asset.customer.name} / {asset.product.name}</p>
        </div>
        <button
          aria-label="Close asset detail"
          className="icon-button light"
          onClick={onClose}
          type="button"
        >
          <X size={18} />
        </button>
      </div>

      <div className="inspection-detail-strip">
        <span className={statusClass(asset.lifecycleStatus)}>
          {asset.lifecycleStatus.replace("_", " ")}
        </span>
        <span>{asset.product.category}</span>
        <span>Retest {asset.nextRetestDueAt ?? "not scheduled"}</span>
      </div>

      <div className="inspection-facts">
        <div>
          <span>Customer</span>
          <strong>{asset.customer.name}</strong>
        </div>
        <div>
          <span>Product</span>
          <strong>{asset.product.name}</strong>
        </div>
        <div>
          <span>Serial</span>
          <strong>{asset.customerSerialNo ?? "Not recorded"}</strong>
        </div>
        <div>
          <span>Tag</span>
          <strong>{asset.tag ?? "Not tagged"}</strong>
        </div>
      </div>

      <div className="certificate-verification">
        <div>
          <Database aria-hidden="true" size={18} />
          <span>Asset ID</span>
          <strong>{asset.assetNumber}</strong>
        </div>
        <div>
          <Ruler aria-hidden="true" size={18} />
          <span>A / B ends</span>
          <strong>
            {endLabel(asset.aEnd)} / {endLabel(asset.bEnd)}
          </strong>
        </div>
        <div>
          <MapPin aria-hidden="true" size={18} />
          <span>Location</span>
          <strong>{locationLabel(asset)}</strong>
        </div>
        <div>
          <CalendarClock aria-hidden="true" size={18} />
          <span>Retest status</span>
          <strong>{asset.retestSchedule?.status ?? "Not scheduled"}</strong>
        </div>
      </div>

      {asset.notes ? (
        <section className="detail-section">
          <h3>Notes</h3>
          <p className="record-notes">{asset.notes}</p>
        </section>
      ) : null}
    </aside>
  );
}
