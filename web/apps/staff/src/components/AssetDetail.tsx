import { ArrowLeft, Edit3, X } from "lucide-react";

import type { AssetRecord } from "../domain/types";

interface AssetDetailProps {
  asset: AssetRecord;
  canWrite: boolean;
  onBack: () => void;
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

export function AssetDetail({ asset, canWrite, onBack, onEdit }: AssetDetailProps) {
  const assetName = asset.assetName || asset.assetNumber;

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
            <button className="primary-button" onClick={() => onEdit(asset)} type="button">
              <Edit3 aria-hidden="true" size={16} />
              Edit
            </button>
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
            <dt>Description</dt>
            <dd>{orDash(asset.description)}</dd>
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
