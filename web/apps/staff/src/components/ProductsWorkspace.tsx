import { Archive, Boxes, Layers3, ShieldCheck } from "lucide-react";

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
  embedded?: boolean;
}

export function ProductsWorkspace({ canManage = true, embedded = false }: ProductsWorkspaceProps) {
  const workspace = useProductsWorkspace();
  const categoryCount = new Set(workspace.products.map((product) => product.category)).size;
  const standardCount = new Set(workspace.products.map((product) => product.standardCode).filter(Boolean)).size;
  const legacyCount = workspace.products.filter(
    (product) => product.category.toLowerCase() === "legacy catalogue"
  ).length;
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
          <ActionButton
            aria-label={`Archive ${product.name}`}
            onClick={() => workspace.requestArchive(product)}
            variant="ghost"
          >
            Archive
          </ActionButton>
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
          context={<><Boxes aria-hidden="true" size={20} /><span><strong>{workspace.products.length} total products</strong><small>Across {categoryCount} categories</small></span></>}
        />
        <ManagementMetricStrip>
          <ManagementMetric icon={Boxes} label="Total Products" value={workspace.products.length} detail="Available product definitions" />
          <ManagementMetric icon={Layers3} label="Categories" value={categoryCount} detail="Product classifications" tone="green" />
          <ManagementMetric icon={ShieldCheck} label="Standards Tracked" value={standardCount} detail="Linked to product records" tone="amber" />
          <ManagementMetric icon={Archive} label="Legacy Catalogue" value={legacyCount} detail={workspace.products.length ? `${Math.round((legacyCount / workspace.products.length) * 100)}% of total` : "No product records"} tone="violet" />
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
        confirmLabel="Archive product"
        error={workspace.archiveError}
        message="It will no longer appear in the product catalog. Assets already using it are not changed."
        onCancel={workspace.cancelArchive}
        onConfirm={() => void workspace.confirmArchive()}
        open={workspace.archiveTarget !== null}
        pending={workspace.isArchiving}
        pendingLabel="Archiving…"
        title={workspace.archiveTarget ? `Archive ${productLabel(workspace.archiveTarget)}?` : "Archive product?"}
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
