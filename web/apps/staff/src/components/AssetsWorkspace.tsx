import { AssetDetail } from "./AssetDetail";
import { AssetForm } from "./AssetForm";
import { ModuleTable, type ModuleColumn } from "./ModuleTable";
import { useAssetsWorkspace } from "../hooks/useAssetsWorkspace";
import type { AssetRecord } from "../domain/types";

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
  return "mini-status current";
}

function boreLabel(_asset: AssetRecord) {
  const sizes = [assetEndSize(_asset.aEnd), assetEndSize(_asset.bEnd)].filter(Boolean);
  const uniqueSizes = Array.from(new Set(sizes));
  return uniqueSizes.length === 1 ? uniqueSizes[0] : uniqueSizes.join(" / ") || "Not recorded";
}

function assetEndSize(end: AssetRecord["aEnd"]) {
  return end.size.trim();
}

function assetEndLabel(end: AssetRecord["aEnd"]) {
  const parts = [end.fitting.trim(), end.size.trim()].filter(Boolean);
  return parts.join(" ") || "Not recorded";
}

function endLabel(asset: AssetRecord) {
  return `${assetEndLabel(asset.aEnd)} / ${assetEndLabel(asset.bEnd)}`;
}

export function AssetsWorkspace({ canWrite }: { canWrite: boolean }) {
  const workspace = useAssetsWorkspace();
  const assetColumns: ModuleColumn<AssetRecord>[] = [
    {
      header: "Asset ID",
      render: (asset) => (
        <span className="asset-id-cell">
          <strong>{asset.assetNumber}</strong>
          {asset.notes ? <small>{asset.notes}</small> : null}
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
        onEdit={workspace.openEdit}
      />
    );
  }

  return (
    <>
      <ModuleTable
        actionLabel={canWrite ? "Add Asset" : undefined}
        columns={assetColumns}
        countLabel={`${workspace.assets.length} assets`}
        emptyLabel="No assets match the current filters."
        exportRows={(asset) => [
          asset.assetNumber,
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
        onAction={canWrite ? workspace.openCreate : undefined}
        onRowClick={workspace.openDetail}
        onQueryChange={workspace.setQuery}
        query={workspace.query}
        searchLabel="Search assets"
        searchPlaceholder="Search assets..."
        source={workspace.source}
        tableLabel="Asset records"
      />
      {canWrite ? (
        <AssetForm
          asset={workspace.editingAsset}
          customerOptions={workspace.customerOptions}
          locationOptions={workspace.locationOptions}
          productOptions={workspace.productOptions}
          open={workspace.isFormOpen}
          onClose={() => workspace.setFormOpen(false)}
          onSubmit={workspace.saveAsset}
        />
      ) : null}
    </>
  );
}
