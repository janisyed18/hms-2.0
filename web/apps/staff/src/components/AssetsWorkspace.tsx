import { BadgeAlert, Boxes, CircleOff, UsersRound } from "lucide-react";
import { useEffect, useRef } from "react";

import { AssetDetail } from "./AssetDetail";
import { AssetForm } from "./AssetForm";
import { ActionButton } from "./interaction/ActionButton";
import { ActionNotice } from "./interaction/ActionNotice";
import { ConfirmDialog } from "./interaction/ConfirmDialog";
import { ModuleTable, type ModuleColumn } from "./ModuleTable";
import { assetLabel } from "../utils/identity";
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
  routeAssetId,
  onAssetRouteChange
}: {
  canWrite: boolean;
  /** The asset the URL names; the URL, not this component, is the record of which asset is open. */
  routeAssetId?: string | null;
  onAssetRouteChange?: (assetId: string | null, options?: { replace?: boolean }) => void;
}) {
  const workspace = useAssetsWorkspace();
  const { isLoading, resolveAsset, openDetail, reportOpenFailure, closeDetail } = workspace;
  const viewingId = workspace.viewingAsset?.id ?? null;
  // Each direction reacts only to its own side changing, so the two can never chase each other.
  const live = useRef({ routeAssetId, viewingId, resolveAsset, openDetail, reportOpenFailure, closeDetail, onAssetRouteChange });
  useEffect(() => {
    live.current = { routeAssetId, viewingId, resolveAsset, openDetail, reportOpenFailure, closeDetail, onAssetRouteChange };
  });
  const previousViewing = useRef(viewingId);
  const assetStats = {
    total: workspace.assets.length,
    overdue: workspace.assets.filter((asset) => asset.lifecycleStatus === "OVERDUE").length,
    condemned: workspace.assets.filter((asset) => asset.lifecycleStatus === "CONDEMNED").length,
    customers: new Set(workspace.assets.map((asset) => asset.customer.id)).size
  };

  // URL to screen: a link, or Back/Forward, opens or closes the detail. Finding an asset can take a
  // request, so what comes back is shown only if the URL still asks for that asset: a slow answer for an
  // asset the person has already left must neither open it nor undo where they went since.
  useEffect(() => {
    if (isLoading) return;
    const { viewingId: open, resolveAsset: resolve, closeDetail: close } = live.current;
    if (routeAssetId && routeAssetId !== open) {
      void resolve(routeAssetId).then((found) => {
        if (live.current.routeAssetId !== routeAssetId) return;
        if (found) {
          live.current.openDetail(found);
        } else {
          // An asset that is missing or not theirs is not shown, and the link stops naming it.
          live.current.reportOpenFailure();
          live.current.onAssetRouteChange?.(null, { replace: true });
        }
      });
    } else if (!routeAssetId && open) {
      close();
    }
  }, [routeAssetId, isLoading]);

  // Screen to URL: opening or closing the detail by hand updates the address.
  useEffect(() => {
    if (previousViewing.current === viewingId) return;
    previousViewing.current = viewingId;
    if (viewingId !== live.current.routeAssetId) live.current.onAssetRouteChange?.(viewingId);
  }, [viewingId]);

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
          <ActionButton
            onClick={(event) => {
              event.stopPropagation();
              workspace.openEdit(asset);
            }}
            variant="secondary"
          >
            Edit
          </ActionButton>
          <ActionButton
            onClick={(event) => {
              event.stopPropagation();
              workspace.requestArchive(asset);
            }}
            variant="ghost"
          >
            Archive
          </ActionButton>
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

      {workspace.notice ? (
        <ActionNotice kind={workspace.notice.kind} onDismiss={workspace.dismissNotice} title={workspace.notice.title}>
          {workspace.notice.message}
        </ActionNotice>
      ) : null}

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
      <ConfirmDialog
        confirmLabel="Archive asset"
        error={workspace.archiveError}
        message="It will no longer appear in the asset register. Its inspection and certificate history is kept."
        onCancel={workspace.cancelArchive}
        onConfirm={() => void workspace.confirmArchive()}
        open={workspace.archiveTarget !== null}
        pending={workspace.isArchiving}
        pendingLabel="Archiving…"
        title={workspace.archiveTarget ? `Archive ${assetLabel(workspace.archiveTarget)}?` : "Archive asset?"}
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
