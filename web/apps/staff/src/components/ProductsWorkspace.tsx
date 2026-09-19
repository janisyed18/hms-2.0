import { Archive, Boxes, Layers3, ShieldCheck } from "lucide-react";

import { ModuleTable, type ModuleColumn } from "./ModuleTable";
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
          <button type="button" onClick={() => workspace.openEdit(product)}>
            Edit
          </button>
          <button
            type="button"
            aria-label={`Archive ${product.name}`}
            onClick={() => workspace.archiveProduct(product)}
          >
            Archive
          </button>
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
      <div className={`inspection-layout${workspace.selectedProduct ? "" : " detail-closed"}`}>
        <div className="inspection-table-wrap">
          <ModuleTable
            actionLabel={canManage ? "Add Product" : undefined}
            columns={productColumns}
            countLabel={`${workspace.products.length} products`}
            emptyLabel="No products match the current filters."
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
            searchPlaceholder="Search products..."
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
      <ProductForm
        open={workspace.isFormOpen}
        product={workspace.editingProduct}
        onClose={() => workspace.setFormOpen(false)}
        onSubmit={workspace.saveProduct}
      />
    </section>
  );
}
