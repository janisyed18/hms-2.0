import { BadgeAlert, Boxes, CircleOff, UsersRound } from "lucide-react";
import { useEffect } from "react";

import { AssetDetail } from "./AssetDetail";
import { AssetForm } from "./AssetForm";
import { ModuleTable, type ModuleColumn } from "./ModuleTable";
import { useAssetsWorkspace } from "../hooks/useAssetsWorkspace";
import type { AssetRecord } from "../domain/types";
import { StaggerGroup, StaggerItem } from "../motion/MotionPrimitives";

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
    .join(", ");
}

function statusClass(status: string) {
  if (status === "OVERDUE") {
    return "mini-status overdue";
  }
  if (status === "DUE") {
    return "mini-status due-soon";
  }
  if (status === "CONDEMNED") {
    return "mini-status condemned";
  }
  if (status === "RETIRED") {
    return "mini-status retired";
  }
  return "mini-status current";
}

function boreLabel(asset: AssetRecord) {
  const sizes = [assetEndSize(asset.aEnd), assetEndSize(asset.bEnd)].filter(Boolean);
  const uniqueSizes = Array.from(new Set(sizes));
  return uniqueSizes.length === 1 ? uniqueSizes[0] : uniqueSizes.join(" / ") || "Not recorded";
}

function assetEndSize(end: AssetRecord["aEnd"]) {
  return end.nominalBore?.name ?? end.size.trim();
}

function assetEndLabel(end: AssetRecord["aEnd"]) {
  const parts = [end.coupling?.name ?? end.fitting.trim(), end.attachMethod?.name].filter(Boolean);
  return parts.join(" ") || "Not recorded";
}

function endLabel(asset: AssetRecord) {
  return `${assetEndLabel(asset.aEnd)} / ${assetEndLabel(asset.bEnd)}`;
}

export function AssetsWorkspace({
  canWrite,
  initialAssetId,
  onInitialAssetOpened
}: {
  canWrite: boolean;
  initialAssetId?: string | null;
  onInitialAssetOpened?: () => void;
}) {
  const workspace = useAssetsWorkspace();
  const { isLoading, openDetailById } = workspace;
  const assetStats = {
    total: workspace.assets.length,
    overdue: workspace.assets.filter((asset) => asset.lifecycleStatus === "OVERDUE").length,
    condemned: workspace.assets.filter((asset) => asset.lifecycleStatus === "CONDEMNED").length,
    customers: new Set(workspace.assets.map((asset) => asset.customer.id)).size
  };

  useEffect(() => {
    if (!initialAssetId || isLoading) {
      return;
    }
    void openDetailById(initialAssetId).finally(onInitialAssetOpened);
  }, [initialAssetId, isLoading, onInitialAssetOpened, openDetailById]);

  const assetColumns: ModuleColumn<AssetRecord>[] = [
    {
      header: "Asset",
      render: (asset) => (
        <span className="asset-id-cell">
          <strong>{asset.assetName || asset.assetNumber}</strong>
          {asset.customerSerialNo ? <small>{asset.customerSerialNo}</small> : null}
        </span>
      )
    },
    {
      header: "Customer",
      render: (asset) => asset.customer.name
    },
    {
      header: "Product",
      render: (asset) => asset.product.name
    },
    {
      header: "Bore",
      render: boreLabel
    },
    {
      header: "End A / End B",
      render: endLabel
    },
    {
      header: "Location",
      render: locationLabel
    },
    {
      header: "Retest Due",
      render: (asset) => asset.nextRetestDueAt ?? "Not scheduled"
    },
    {
      header: "Lifecycle",
      render: (asset) => (
        <span className={statusClass(asset.lifecycleStatus)}>
          {asset.lifecycleStatus.replace("_", " ")}
        </span>
      )
    },
    ...(canWrite ? [{
      header: "Actions",
      render: (asset) => (
        <span className="row-actions">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              workspace.openEdit(asset);
            }}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              workspace.archiveAsset(asset);
            }}
          >
            Archive
          </button>
        </span>
      )
    } satisfies ModuleColumn<AssetRecord>] : [])
  ];

  if (workspace.viewingAsset) {
    return (
      <AssetDetail
        asset={workspace.viewingAsset}
        canWrite={canWrite}
        onBack={workspace.closeDetail}
        onCopy={workspace.copyAsset}
        onEdit={workspace.openEdit}
      />
    );
  }

  return (
    <section className="asset-register-workspace" aria-labelledby="asset-register-heading">
      <header className="asset-register-header">
        <div>
          <span className="asset-register-eyebrow">Assets</span>
          <h2 id="asset-register-heading">Fleet assets</h2>
          <p>Manage hose assemblies, lifecycle status, and retest readiness.</p>
        </div>
        <div className="asset-register-context" aria-label="Current asset register scope">
          <Boxes aria-hidden="true" size={23} />
          <span>
            <strong>{assetStats.total} total assets</strong>
            <small>{workspace.visibleAssets.length} matching the current view</small>
          </span>
        </div>
      </header>

      <section aria-label="Asset register summary">
        <StaggerGroup className="asset-register-metrics">
          <AssetMetric icon={Boxes} label="Total assets" value={assetStats.total} detail="Registered in the current workspace" tone="blue" />
          <AssetMetric icon={BadgeAlert} label="Overdue" value={assetStats.overdue} detail="Require retest attention" tone="red" />
          <AssetMetric icon={CircleOff} label="Condemned" value={assetStats.condemned} detail="Removed from service" tone="amber" />
          <AssetMetric icon={UsersRound} label="Customers with assets" value={assetStats.customers} detail="Active asset ownership" tone="green" />
        </StaggerGroup>
      </section>

      <ModuleTable
        actionLabel={canWrite ? "Add Asset" : undefined}
        actionsInToolbar
        className="asset-register-table"
        columns={assetColumns}
        countLabel={workspace.isLoading ? "Loading assets" : `${workspace.assets.length} assets`}
        emptyLabel="No assets match the current filters."
        exportRows={(asset) => [
          asset.assetName || asset.assetNumber,
          asset.customer.name,
          asset.product.name,
          boreLabel(asset),
          endLabel(asset),
          locationLabel(asset),
          asset.nextRetestDueAt ?? "",
          asset.lifecycleStatus,
          ""
        ]}
        activeFilterCount={workspace.activeFilterCount}
        filterControls={
          <>
            <label className="filter-field">
              <span>Customer</span>
              <select
                aria-label="Asset customer filter"
                value={workspace.customerFilter}
                onChange={(event) => workspace.setCustomerFilter(event.target.value)}
              >
                <option value="ALL">All customers</option>
                {workspace.customerOptions.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span>Product</span>
              <select
                aria-label="Asset product filter"
                value={workspace.productFilter}
                onChange={(event) => workspace.setProductFilter(event.target.value)}
              >
                <option value="ALL">All products</option>
                {workspace.productOptions.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span>Lifecycle</span>
              <select
                aria-label="Asset lifecycle filter"
                value={workspace.lifecycleFilter}
                onChange={(event) => workspace.setLifecycleFilter(event.target.value)}
              >
                <option value="ALL">All lifecycle states</option>
                <option value="IN_SERVICE">In service</option>
                <option value="DUE">Due</option>
                <option value="OVERDUE">Overdue</option>
                <option value="CONDEMNED">Condemned</option>
                <option value="RETIRED">Retired</option>
              </select>
            </label>
            <label className="filter-field">
              <span>Due from</span>
              <input
                aria-label="Asset due from"
                type="date"
                value={workspace.dueFrom}
                onChange={(event) => workspace.setDueFrom(event.target.value)}
              />
            </label>
            <label className="filter-field">
              <span>Due to</span>
              <input
                aria-label="Asset due to"
                type="date"
                value={workspace.dueTo}
                onChange={(event) => workspace.setDueTo(event.target.value)}
              />
            </label>
            <button className="secondary-button filter-clear" type="button" onClick={workspace.clearAssetFilters}>
              Clear asset filters
            </button>
          </>
        }
        getRowKey={(asset) => asset.id}
        items={workspace.visibleAssets}
        loading={workspace.isLoading}
        onAction={canWrite ? workspace.openCreate : undefined}
        onRowSelect={workspace.openDetail}
        onQueryChange={workspace.setQuery}
        query={workspace.query}
        searchLabel="Search assets"
        searchPlaceholder="Search assets..."
        tableLabel="Asset records"
        error={workspace.error}
      />
      {canWrite ? (
        <AssetForm
          asset={workspace.formAsset}
          isCopy={workspace.isCopy}
          configurationOptions={workspace.configurationOptions}
          customerOptions={workspace.customerOptions}
          locationOptions={workspace.locationOptions}
          productOptions={workspace.productOptions}
          open={workspace.isFormOpen}
          onClose={() => workspace.setFormOpen(false)}
          onSubmit={workspace.saveAsset}
        />
      ) : null}
    </section>
  );
}

function AssetMetric({
  detail,
  icon: Icon,
  label,
  tone,
  value
}: {
  detail: string;
  icon: typeof Boxes;
  label: string;
  tone: "amber" | "blue" | "green" | "red";
  value: number;
}) {
  return (
    <StaggerItem className={`asset-register-metric tone-${tone}`}>
      <Icon aria-hidden="true" size={21} />
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </span>
    </StaggerItem>
  );
}
