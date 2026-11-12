import { Boxes, Layers3 } from "lucide-react";

import { ActionButton } from "./interaction/ActionButton";
import { ActionNotice } from "./interaction/ActionNotice";
import { ConfirmDialog } from "./interaction/ConfirmDialog";
import { ModuleTable, activeFilterList, type ModuleColumn } from "./ModuleTable";
import { productLabel } from "../utils/identity";
import { ManagementHeader, ManagementMetric, ManagementMetricStrip } from "./ManagementPrimitives";
import { ProductDetail } from "./ProductDetail";
import { ProductForm } from "./ProductForm";
import { useProductsWorkspace } from "../hooks/useProductsWorkspace";
import type { ProductRecord } from "../domain/types";

interface ProductsWorkspaceProps {
  canManage?: boolean;
  canDelete?: boolean;
  embedded?: boolean;
}

export function ProductsWorkspace({ canManage = true, canDelete = false, embedded = false }: ProductsWorkspaceProps) {
  const workspace = useProductsWorkspace();
  // Counts come from the server for the whole catalogue, not from the page loaded here.
  const total = workspace.serverTotal ?? workspace.products.length;
  const viewLabel = workspace.statusFilter === "ACTIVE" ? "Enabled" : "Disabled";
  const productColumns: ModuleColumn<ProductRecord>[] = [
    {
      header: "Code",
      render: (product) => <strong>{product.code}</strong>
    },
    {
      header: "Product Name",
      render: (product) => product.name
    },
    {
      header: "Category",
      render: (product) => product.category
    },
    {
      header: "Sub Category",
      render: (product) => product.subCategory ?? "Not set"
    },
    {
      header: "Standard",
      render: (product) => product.standardCode ?? "No standard"
    },
    {
      header: "Actions",
      render: (product) => canManage ? (
        <span className="row-actions">
          <ActionButton onClick={() => workspace.openEdit(product)} variant="secondary">
            Edit
          </ActionButton>
          <ActionButton aria-label={`${workspace.statusFilter === "ACTIVE" ? "Disable" : "Enable"} ${product.name}`} onClick={() => void workspace.toggleEnabled(product)} variant="ghost">
            {workspace.statusFilter === "ACTIVE" ? "Disable" : "Enable"}
          </ActionButton>
          {canDelete ? (
            <ActionButton aria-label={`Delete ${product.name}`} onClick={() => workspace.requestDelete(product)} variant="destructive">
              Delete
            </ActionButton>
          ) : null}
        </span>
      ) : "Read only"
    }
  ];

  return (
    <section className="inspection-workspace catalog-workspace management-workspace" aria-label="Product workspace">
      {!embedded ? <>
        <ManagementHeader
          eyebrow="Product catalog"
          title="Product catalog"
          description="Manage hose products, classifications, and standards."
          context={<><Boxes aria-hidden="true" size={20} /><span><strong>{total} {viewLabel.toLowerCase()} products</strong><small>Across the whole catalogue</small></span></>}
        />
        <ManagementMetricStrip>
          <ManagementMetric icon={Boxes} label={`${viewLabel} products`} value={total} detail="Matching the current view" />
          <ManagementMetric icon={Layers3} label="Shown" value={workspace.products.length} detail="Loaded for the current search" tone="green" />
        </ManagementMetricStrip>
      </> : null}
      {workspace.notice ? (
        <ActionNotice kind={workspace.notice.kind} onDismiss={workspace.dismissNotice} title={workspace.notice.title}>
          {workspace.notice.message}
        </ActionNotice>
      ) : null}
      {workspace.loadError ? <ActionNotice kind="error" title="Products unavailable">{workspace.loadError}</ActionNotice> : null}
      <div className={`inspection-layout${workspace.selectedProduct ? "" : " detail-closed"}`}>
        <div className="inspection-table-wrap">
          <ModuleTable
            actionLabel={canManage ? "Add product" : undefined}
            columns={productColumns}
            activeFilters={activeFilterList([
              { id: "category", label: "Category", value: workspace.categoryFilter !== "ALL" && workspace.categoryFilter, onRemove: () => workspace.setCategoryFilter("ALL") },
              { id: "standard", label: "Standard", value: workspace.standardFilter !== "ALL" && workspace.standardFilter, onRemove: () => workspace.setStandardFilter("ALL") }
            ])}
            countLabel={`${workspace.products.length} products`}
            emptyHint="Products appear here once they are added to the catalog."
            emptyLabel="No products match the current filters."
            loadedCount={workspace.products.length}
            noun="products"
            onClearFilters={workspace.clearProductFilters}
            totalCount={workspace.serverTotal}
            exportRows={(product) => [
              product.code,
              product.name,
              product.category,
              product.subCategory ?? "",
              product.standardCode ?? "",
              ""
            ]}
            activeFilterCount={workspace.activeFilterCount}
            filterControls={
              <>
                <label className="filter-field">
                  <span>Category</span>
                  <select
                    aria-label="Product category filter"
                    value={workspace.categoryFilter}
                    onChange={(event) => workspace.setCategoryFilter(event.target.value)}
                  >
                    <option value="ALL">All categories</option>
                    {workspace.categoryOptions.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="filter-field">
                  <span>Standard</span>
                  <select
                    aria-label="Product standard filter"
                    value={workspace.standardFilter}
                    onChange={(event) => workspace.setStandardFilter(event.target.value)}
                  >
                    <option value="ALL">All standards</option>
                    {workspace.standardOptions.map((standard) => (
                      <option key={standard} value={standard}>
                        {standard}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="filter-field">
                  <span>Status</span>
                  <select aria-label="Product status filter" value={workspace.statusFilter} onChange={(event) => workspace.setStatusFilter(event.target.value as "ACTIVE" | "DISABLED")}>
                    <option value="ACTIVE">Enabled</option>
                    <option value="DISABLED">Disabled</option>
                  </select>
                </label>
                <button className="secondary-button filter-clear" type="button" onClick={workspace.clearProductFilters}>
                  Clear product filters
                </button>
              </>
            }
            getRowKey={(product) => product.id}
            items={workspace.visibleProducts}
            onAction={canManage ? workspace.openCreate : undefined}
            onQueryChange={workspace.setQuery}
            onRowSelect={workspace.openDetail}
            query={workspace.query}
            searchLabel="Search products"
            searchPlaceholder="Search products by code, name or category"
            selectedRowKey={workspace.selectedProduct?.id ?? null}
            tableLabel="Product records"
          />
        </div>
        {workspace.selectedProduct ? (
          <ProductDetail
            product={workspace.selectedProduct}
            onClose={workspace.closeDetail}
          />
        ) : null}
      </div>
      <ConfirmDialog
        confirmLabel="Delete product"
        error={workspace.deleteError}
        message="This permanently removes the product from the catalogue. It cannot be deleted while assets use it; disable it instead to stop it being offered."
        onCancel={workspace.cancelDelete}
        onConfirm={() => void workspace.confirmDelete()}
        open={workspace.deleteTarget !== null}
        pending={workspace.isDeleting}
        pendingLabel="Deleting…"
        title={workspace.deleteTarget ? `Delete ${productLabel(workspace.deleteTarget)}?` : "Delete product?"}
      />
      <ProductForm
        open={workspace.isFormOpen}
        product={workspace.editingProduct}
        onClose={() => workspace.setFormOpen(false)}
        onSubmit={workspace.saveProduct}
      />
    </section>
  );
}
