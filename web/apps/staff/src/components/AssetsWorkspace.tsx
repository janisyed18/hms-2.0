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

const assetColumns: ModuleColumn<AssetRecord>[] = [
  {
    header: "Asset",
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
    header: "Status",
    render: (asset) => (
      <span className={statusClass(asset.lifecycleStatus)}>
        {asset.lifecycleStatus.replace("_", " ")}
      </span>
    )
  },
  {
    header: "Next Retest",
    render: (asset) => asset.nextRetestDueAt ?? "Not scheduled"
  },
  {
    header: "Location",
    render: locationLabel
  }
];

export function AssetsWorkspace() {
  const workspace = useAssetsWorkspace();

  return (
    <ModuleTable
      actionLabel="Add Asset"
      columns={assetColumns}
      countLabel={`${workspace.assets.length} assets`}
      emptyLabel="No assets match the current filters."
      getRowKey={(asset) => asset.id}
      items={workspace.visibleAssets}
      onQueryChange={workspace.setQuery}
      query={workspace.query}
      searchLabel="Search assets"
      searchPlaceholder="Search assets..."
      source={workspace.source}
      tableLabel="Asset records"
    />
  );
}
