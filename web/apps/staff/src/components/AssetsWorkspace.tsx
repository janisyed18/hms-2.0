import { AssetForm } from "./AssetForm";
import { ModuleTable, type ModuleColumn } from "./ModuleTable";
import { useAssetsWorkspace } from "../hooks/useAssetsWorkspace";
import type { AssetRecord } from "../domain/types";

function locationLabel(asset: AssetRecord) {
  if (!asset.location) {
    return "No location";
  }
  return [asset.location.name, asset.location.city].filter(Boolean).join(", ");
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

export function AssetsWorkspace() {
  const workspace = useAssetsWorkspace();
  const assetColumns: ModuleColumn<AssetRecord>[] = [
    {
      header: "Asset ID",
      render: (asset) => <strong>{asset.assetNumber}</strong>
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
    {
      header: "Actions",
      render: (asset) => (
        <span className="row-actions">
          <button type="button" onClick={() => workspace.openEdit(asset)}>
            Edit
          </button>
          <button type="button" onClick={() => workspace.archiveAsset(asset)}>
            Archive
          </button>
        </span>
      )
    }
  ];

  return (
    <>
      <ModuleTable
        actionLabel="Add Asset"
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
        getRowKey={(asset) => asset.id}
        items={workspace.visibleAssets}
        onAction={workspace.openCreate}
        onQueryChange={workspace.setQuery}
        query={workspace.query}
        searchLabel="Search assets"
        searchPlaceholder="Search assets..."
        source={workspace.source}
        tableLabel="Asset records"
      />
      <AssetForm
        asset={workspace.editingAsset}
        customerOptions={workspace.customerOptions}
        productOptions={workspace.productOptions}
        open={workspace.isFormOpen}
        onClose={() => workspace.setFormOpen(false)}
        onSubmit={workspace.saveAsset}
      />
    </>
  );
}
